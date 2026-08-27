#!/usr/bin/env python3
# ai-visualizer: give your AI agent a face.
# Copyright (C) 2026 Jared Rhodenizer
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
"""ai-visualizer server. Python standard library only, nothing to install.

Serves the face gallery at http://127.0.0.1:8790/ and exposes:

  /state   polled by the faces (~8x/sec):
           {"state":  "idle|listening|thinking|speaking",
            "level":  0.0-1.0,       voice loudness while speaking
            "samples": [64 floats],  raw waveform snapshot (0s when quiet)
            "alert":  bool,          optional attention signal
            "loading": bool}         true while the voice line plays its
                                     own thinking sound (we stay quiet)
  /config  the merged ai-visualizer.json plus the list of installed
           faces, discovered by scanning the faces/ folder. Drop a new
           folder with an index.html into faces/ and it appears in the
           gallery. That is the whole plugin system.
  /log     the transcript panel's live state, as JSON:
           {"visible": bool,      false while .transcript_hidden exists
                                   in the bus dir — toggled by a plain
                                   "hide/show console" request, no
                                   restart or reload needed
            "turns": [{"time","who","text"}, ...]}  tailed from the
                                   voice line's own logs/backtalk.log
                                   ([you]/[Jarvis] lines only — the
                                   technical [ears]/[mouth]/[turn]/etc
                                   lines are filtered out), newest last

READ-ONLY on the signal bus. The bus is three tiny files written by a
voice line (backtalk writes them natively, github.com/jaredrhod/backtalk):

  .voice_state        idle | listening | thinking | speaking
  .voice_waveform     JSON {ts, samples: [64 floats]} while audio plays
  .voice_loading_pid  exists while the voice line plays a thinking sound
  .voice_alert        optional: non-empty file = attention needed

Where the bus lives comes from "bus_dir" in ai-visualizer.json (default:
this folder). Point it at your backtalk folder, or point backtalk's
"signals_dir" here. Either direction works.

Run:
  python3 server.py             the real bus
  python3 server.py --mock speaking
                                no voice line needed: /state synthesizes
                                the chosen state (idle|listening|thinking
                                |speaking) so you can see a face perform
  python3 server.py --no-open   do not auto-open the browser
Ctrl-C stops.
"""
import json
import math
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATES = {"idle", "listening", "thinking", "speaking"}
WAVEFORM_STALE_S = 0.6

DEFAULTS = {
    "name": "JARVIS",       # shown on the chip / headers, yours to change
    "badge": "",            # optional handle shown in some faces' chrome
    "face": "board",        # the default face the root URL opens
    "port": 8790,
    "bus_dir": "",          # where the .voice_* files live ("" = here)
    "thinking_sound": True, # play assets/thinking.wav while thinking
    "idle_dim_minutes": 0,  # fade to black after this many idle minutes
                            # with no input (burn-in guard); 0 = off
    "idle_dim_opacity": 0.85,  # how dark the fade goes, 0..1
    "show_transcript": True,  # left-third live conversation panel
    "transcript_opacity": {"default": 0.15},  # per-face panel opacity;
                            # "default" applies unless a face id key
                            # (e.g. "board") overrides it
}

TRANSCRIPT_LINE_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}) \[(you|Jarvis)\]\s*(.*)$")
TRANSCRIPT_LATENCY_RE = re.compile(r"^\(\d+(\.\d+)?s to first\)\s*")
TRANSCRIPT_MAX_LINES = 300


def read_transcript():
    """Tail backtalk's own session log, keeping only the conversational
    [you]/[Jarvis] lines (drops [ears]/[mouth]/[backtalk]/[turn]/[brain]
    plumbing) so the panel reads as a transcript, not a debug feed."""
    path = BUS / "logs" / "backtalk.log"
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        m = TRANSCRIPT_LINE_RE.match(line)
        if not m:
            continue
        text = TRANSCRIPT_LATENCY_RE.sub("", m.group(3))
        out.append({"time": m.group(1), "who": m.group(2), "text": text})
    return out[-TRANSCRIPT_MAX_LINES:]


def transcript_visible():
    """Live on/off switch for the transcript panel — a plain marker file
    in the bus dir, same style as .voice_alert (existence, not content,
    is the signal). Toggled by Jarvis on a plain 'hide/show console'
    request; polled every 500ms by the already-open browser, so it
    takes effect instantly with no server restart or page reload."""
    return not (BUS / ".transcript_hidden").exists()


def load_config():
    cfg = dict(DEFAULTS)
    try:
        user = json.loads((HERE / "ai-visualizer.json").read_text())
        for k, v in user.items():
            cfg[k] = v
    except FileNotFoundError:
        pass
    except ValueError as e:
        print(f"[config] ai-visualizer.json is not valid JSON ({e}), "
              f"using defaults")
    return cfg


CFG = load_config()
BUS = Path(CFG["bus_dir"]).expanduser() if CFG.get("bus_dir") else HERE

MOCK = None
NO_OPEN = "--no-open" in sys.argv
if "--mock" in sys.argv:
    i = sys.argv.index("--mock")
    MOCK = sys.argv[i + 1] if len(sys.argv) > i + 1 else "speaking"
    if MOCK not in STATES:
        MOCK = "speaking"
PORT = int(CFG.get("port", 8790))
if "--port" in sys.argv:
    i = sys.argv.index("--port")
    PORT = int(sys.argv[i + 1])


def list_faces():
    faces = []
    fdir = HERE / "faces"
    if fdir.is_dir():
        for p in sorted(fdir.iterdir()):
            if p.is_dir() and (p / "index.html").exists():
                meta = {"id": p.name, "title": p.name.title(), "tagline": ""}
                try:
                    meta.update(json.loads((p / "face.json").read_text()))
                except (OSError, ValueError):
                    pass
                meta["id"] = p.name
                faces.append(meta)
    return faces


def mock_bus():
    t = time.time()
    level = 0.0
    samples = [0.0] * 64
    if MOCK == "speaking":
        level = abs(math.sin(t * 6.0)) * 0.85
        samples = [
            (math.sin(i * 0.55 + t * 9.0) * 0.6
             + math.sin(i * 1.7 - t * 13.0) * 0.4)
            * 9000.0 * (0.35 + 0.65 * abs(math.sin(t * 2.6)))
            for i in range(64)
        ]
    return {"state": MOCK, "level": level, "samples": samples,
            "alert": False, "loading": MOCK == "thinking"}


def read_bus():
    if MOCK:
        return mock_bus()
    try:
        state = (BUS / ".voice_state").read_text().strip().lower()
        if state not in STATES:
            state = "idle"
    except OSError:
        state = "idle"
    level = 0.0
    samples = [0.0] * 64
    try:
        payload = json.loads((BUS / ".voice_waveform").read_text())
        age = time.time() - float(payload.get("ts", 0))
        raw = payload.get("samples") or []
        if raw and age < WAVEFORM_STALE_S:
            # A fresh waveform IS speech, whatever the state file says.
            state = "speaking"
            samples = [float(s) for s in raw[:64]]
            mean = sum(abs(s) for s in samples) / len(samples)
            level = min(1.0, mean / 3000.0)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    try:
        alert = (BUS / ".voice_alert").stat().st_size > 0
    except OSError:
        alert = False
    loading = (BUS / ".voice_loading_pid").exists()
    return {"state": state, "level": level, "samples": samples,
            "alert": alert, "loading": loading}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path == "/state":
                self._send(json.dumps(read_bus()).encode(),
                           "application/json")
            elif path == "/config":
                out = {"name": CFG["name"], "badge": CFG["badge"],
                       "face": CFG["face"],
                       "thinking_sound": bool(CFG["thinking_sound"]),
                       "idle_dim_minutes": CFG["idle_dim_minutes"],
                       "idle_dim_opacity": CFG["idle_dim_opacity"],
                       "show_transcript": bool(CFG["show_transcript"]),
                       "transcript_opacity": CFG["transcript_opacity"],
                       "faces": list_faces()}
                self._send(json.dumps(out).encode(), "application/json")
            elif path == "/log":
                out = {"visible": transcript_visible(),
                       "turns": read_transcript()}
                self._send(json.dumps(out).encode(), "application/json")
            else:
                self._static(path)
        except BrokenPipeError:
            pass
        except Exception as e:
            body = json.dumps({"error": str(e)}).encode()
            self._send(body, "application/json", 500)

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        target = (HERE / path.lstrip("/")).resolve()
        if target != HERE and HERE not in target.parents:
            self._send(b"not found", "text/plain", 404)
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            self._send(b"not found", "text/plain", 404)
            return
        ctype = mimetypes.guess_type(str(target))[0] or \
            "application/octet-stream"
        self._send(target.read_bytes(), ctype)

    def _send(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def _find_browser():
    """Locate msedge/chrome on Windows. Neither sits on PATH by default,
    so shutil.which() alone misses them; fall back to the same "App Paths"
    registry key the shell uses to resolve `start msedge`."""
    for exe in ("msedge.exe", "chrome.exe"):
        path = shutil.which(exe)
        if path:
            return path
        try:
            import winreg
            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}",
            ) as key:
                path = winreg.QueryValueEx(key, "")[0]
                if path and Path(path).is_file():
                    return path
        except OSError:
            continue
    return None


def _open_face(url):
    """Open the face in a real, visible window, fullscreen where supported.

    On Windows, handing the URL to the generic webbrowser.open() can land
    in Edge's pre-warmed background instance (the --no-startup-window
    process it keeps idle for fast launch) instead of popping a window
    you can see. And if Edge/Chrome is already running under the user's
    default profile at all, a plain launch just messages that existing
    process over IPC and silently drops most startup switches, including
    --start-fullscreen. A distinct --user-data-dir forces a genuinely
    separate instance so the switches actually take effect.
    """
    if os.name == "nt":
        path = _find_browser()
        if path:
            profile = HERE / ".browser-profile"
            subprocess.Popen([
                path,
                f"--user-data-dir={profile}",
                "--new-window",
                "--start-fullscreen",
                url,
            ])
            return
    webbrowser.open(url)


if __name__ == "__main__":
    mode = f"MOCK={MOCK}" if MOCK else f"bus: {BUS}"
    root = f"http://127.0.0.1:{PORT}/"
    # The browser opens on the configured face; the gallery stays at "/" for switching.
    face = CFG.get("face", "")
    url = f"{root}faces/{face}/" if face and (HERE / "faces" / face / "index.html").exists() else root
    print(f"ai-visualizer on {root}  opening {url}  ({mode})  Ctrl-C stops", flush=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.allow_reuse_address = True
    if not NO_OPEN:
        threading.Timer(0.6, lambda: _open_face(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
