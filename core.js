/*
 * ai-visualizer: give your AI agent a face.
 * Copyright (C) 2026 Jared Rhodenizer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* ============================================================
   ai-visualizer core — the shared plumbing every face rides on.

   A face is one self-contained page in faces/<name>/index.html.
   It includes this script, calls AV.init(opts), then reads these
   fields every animation frame after calling AV.tick(dtMs):

     AV.state      "idle" | "listening" | "thinking" | "speaking"
     AV.level      0..1 raw voice loudness (speaking only)
     AV.env        0..1 smoothed speech envelope (attack/release eased,
                   adaptively normalized — use this for motion)
     AV.samples    Float32Array(64), 0..1 normalized waveform ring
     AV.alert      bool, optional attention signal
     AV.micLevel   0..1 your microphone (only if init({mic:true}))
     AV.name       display name from config ("JARVIS" by default)
     AV.label      the dotted chip label ("J.A.R.V.I.S.")
     AV.badge      optional handle from config ("" by default)

   Modes:
     live   served by server.py — rides the real signal bus
     demo   ?demo=1, or the page opened as a plain file — a scripted
            voice-turn loop (idle, listening, thinking, speaking) with
            synthesized audio, so every face performs with no voice
            line installed
     shot   ?shot=<state>&t=ms — pins one state and runs the frame
            loop deterministically, then sets document.title to
            "ready" (screenshot/verification harness)

   The thinking sound: assets/thinking.wav plays while the state is
   "thinking", exactly like a voice line would play it. If the bus
   says the voice line is already playing its own (.voice_loading_pid),
   this player stays quiet — you never hear it twice. The speaker
   button (bottom left) toggles it; browsers may require one click on
   the page before audio is allowed.
   ============================================================ */
"use strict";

const AV = (() => {
  const Q = new URLSearchParams(location.search);
  const SHOT = Q.get("shot");
  const SHOT_T = parseInt(Q.get("t") || "4000", 10);
  const DEMO = Q.get("demo") === "1" || location.protocol === "file:" || !!SHOT;

  // where core.js lives -> where assets/ lives (works over http and file://)
  const ROOT = new URL(".", document.currentScript.src);

  const A = {
    state: "idle", level: 0, env: 0, alert: false, micLevel: 0,
    samples: new Float32Array(64),
    name: "JARVIS", label: "J.A.R.V.I.S.", badge: "",
    demo: DEMO, shot: SHOT, faces: [],
    _sndOn: true, _mic: false, _readyCbs: [], _ready: false,
  };

  function dotted(name) {
    const up = String(name).toUpperCase();
    if (/^[A-Z0-9]{2,10}$/.test(up)) return up.split("").join(".") + ".";
    return up;
  }

  /* -------------------------------- config -------------------------------- */
  function applyConfig(cfg) {
    if (cfg.name) { A.name = String(cfg.name); A.label = dotted(A.name); }
    A.badge = String(cfg.badge || "");
    if (cfg.thinking_sound === false) A._sndWant = false;
    A.faces = cfg.faces || [];
    // burn-in guard: dim to black after this many idle minutes with no
    // state change and no user input. 0 (or unset) disables it — the
    // face is already always in motion, so this is belt-and-suspenders.
    A._idleDimMs = Math.max(0, Number(cfg.idle_dim_minutes) || 0) * 60000;
    const dimOpacity = cfg.idle_dim_opacity;
    A._idleDimOpacity = dimOpacity == null ? 0.85
      : Math.max(0, Math.min(1, Number(dimOpacity)));
    if (cfg.show_transcript !== false) transcriptInit(cfg.transcript_opacity);
    rateLimitInit();
    A._ready = true;
    A._readyCbs.forEach(cb => cb(A));
    A._readyCbs = [];
  }

  A.ready = cb => { A._ready ? cb(A) : A._readyCbs.push(cb); };

  /* ------------------------------ bus polling ------------------------------ */
  let raw = { state: "idle", level: 0, samples: null, alert: false,
              loading: false };
  if (!DEMO) {
    setInterval(async () => {
      try {
        const r = await fetch("/state", { cache: "no-store" });
        raw = await r.json();
      } catch (e) { /* server gone: hold last state */ }
    }, 120);
  }

  /* ------------------------------ demo driver ------------------------------ */
  // A scripted voice turn: the face performs everything with no voice line.
  const SCRIPT = [["idle", 6000], ["listening", 3500], ["thinking", 4200],
                  ["speaking", 8500]];
  let demoT = 0, demoClock = 0;
  const PIN = SHOT || Q.get("state");   // ?state=speaking pins the demo
  function demoUpdate(dt) {
    demoClock += dt;
    let st = PIN || "idle";
    if (!PIN) {
      demoT = (demoT + dt) % SCRIPT.reduce((a, s) => a + s[1], 0);
      let t = demoT;
      for (const [name, len] of SCRIPT) {
        if (t < len) { st = name; break; }
        t -= len;
      }
    }
    const tt = demoClock / 1000;
    const speaking = st === "speaking";
    const cadence = speaking
      ? Math.max(0, Math.sin(tt * 2.1) * 0.6 + Math.sin(tt * 0.9) * 0.5)
      : 0;
    const samples = new Array(64);
    for (let i = 0; i < 64; i++) {
      // drifting per-sample color so the synthetic voice has a moving
      // spectrum, not a steady tone — spectrum-driven faces dance
      const m = 0.3 + 0.7 * Math.abs(Math.sin(i * 0.23 + tt * 1.7))
        * Math.abs(Math.sin(tt * 2.9 + i * 0.05));
      samples[i] = speaking
        ? (Math.sin(i * 0.55 + tt * 9) * 0.6 + Math.sin(i * 1.7 - tt * 13)
           * 0.4) * 9000 * (0.15 + 0.85 * cadence) * m
        : 0;
    }
    raw = { state: st, level: speaking ? Math.min(1, cadence) : 0,
            samples, alert: false, loading: false };
    if (st === "listening")
      A.micLevel = 0.25 + 0.55 * Math.abs(Math.sin(tt * 2.7))
        * Math.abs(Math.sin(tt * 0.61));
  }

  /* ------------------------- idle-dim (burn-in guard) ---------------------- */
  // Full-screen black overlay that fades in after A._idleDimMs of
  // unbroken idle state and no user input, and fades out instantly on
  // either. The face itself never stops animating underneath, so this
  // is a second layer of protection, not the only one.
  let dimEl = null, idleMs = 0;
  function dimInit() {
    if (SHOT) return;
    dimEl = document.createElement("div");
    dimEl.style.cssText =
      "position:fixed;inset:0;background:#000;pointer-events:none;" +
      "opacity:0;transition:opacity 4s ease;z-index:40";
    document.body.appendChild(dimEl);
    const wake = () => { idleMs = 0; };
    addEventListener("mousemove", wake);
    addEventListener("mousedown", wake);
    addEventListener("keydown", wake);
    addEventListener("touchstart", wake);
  }
  function dimUpdate(dt) {
    if (!dimEl || !A._idleDimMs) return;
    idleMs = A.state === "idle" ? idleMs + dt : 0;
    dimEl.style.opacity = idleMs >= A._idleDimMs ? String(A._idleDimOpacity) : "0";
  }

  /* ------------------------- transcript panel ------------------------------ */
  // Left-quarter, half-transparent scrolling readout of the actual
  // conversation — tails backtalk's own session log via server.py's
  // /log endpoint (already filtered to [you]/[Jarvis] lines there, so
  // this only ever renders speech, never mic/model plumbing). Off in
  // demo/shot modes: there's no real backtalk log to read there.
  let tEl = null, tPoll = null, tKey = "";
  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
  // Which face this page is (the URL is always /faces/<id>/...) — lets
  // the panel opacity vary per face, since a face's own colors/contrast
  // can make the same value read differently (board needed darker).
  function currentFaceId() {
    const m = location.pathname.match(/\/faces\/([^/]+)\//);
    return m ? m[1] : "";
  }
  function transcriptInit(opacityCfg) {
    if (SHOT || DEMO || tEl) return;
    const oc = opacityCfg || {};
    const opacity = oc[currentFaceId()] ?? oc.default ?? 0.15;
    const style = document.createElement("style");
    style.textContent = ".av-transcript::-webkit-scrollbar{display:none}";
    document.head.appendChild(style);
    tEl = document.createElement("div");
    tEl.className = "av-transcript";
    tEl.style.cssText =
      "position:fixed;left:0;top:0;width:25vw;height:100vh;" +
      `background:#000;color:#cfe3ff;opacity:${opacity};` +
      "font:12px/1.5 'SF Mono',Menlo,Consolas,monospace;" +
      "padding:16px;box-sizing:border-box;overflow-y:scroll;" +
      "scrollbar-width:none;-ms-overflow-style:none;" +
      "white-space:pre-wrap;word-break:break-word;z-index:20;" +
      "pointer-events:auto";
    document.body.appendChild(tEl);
    transcriptPoll();
    tPoll = setInterval(transcriptPoll, 500);
  }
  async function transcriptPoll() {
    if (!tEl) return;
    let data;
    try {
      const r = await fetch("/log", { cache: "no-store" });
      data = await r.json();
    } catch (e) { return; }  // server gone: leave last content on screen
    tEl.style.display = data.visible === false ? "none" : "block";
    if (data.visible === false) return;  // hidden: skip the render work
    const turns = data.turns;
    if (!Array.isArray(turns)) return;
    // fingerprint the newest line, not the array length — /log caps at
    // TRANSCRIPT_MAX_LINES, so length alone stops changing once a long
    // conversation fills the window and every new line just displaces
    // the oldest one, which silently froze the panel before this fix.
    const last = turns.length ? turns[turns.length - 1] : null;
    const key = last ? `${last.time}|${last.who}|${last.text}|${turns.length}` : "";
    if (key === tKey) return;
    tKey = key;
    tEl.innerHTML = turns.map(t => {
      const you = t.who === "you";
      const who = you ? "You" : (A.name || "Jarvis");
      const color = you ? "#7fd7ff" : "#ffd77f";
      return `<div style="margin-bottom:8px">` +
        `<span style="color:${color};font-weight:600">${who}</span> ` +
        `<span style="opacity:.45">${t.time}</span><br>` +
        `${escapeHtml(t.text)}</div>`;
    }).join("");
    tEl.scrollTop = tEl.scrollHeight;
  }

  /* ------------------------- rate-limit alert HUD ---------------------------- */
  // Top-right corner readout — but real-alert-only, not a gauge: there
  // is no SDK call that returns a live plan-usage percentage (the CLI
  // only reports utilization on an actual threshold crossing, and
  // omits it during normal "allowed" operation — upstream limitation,
  // anthropics/claude-code#50518, closed not planned). So this element
  // stays hidden until backtalk's own rate_limit_event handler writes
  // a genuine transition to the bus, via server.py's /rate_limit.
  // Amber while approaching a limit, solid red once actually hit;
  // hides itself again the moment a later event reports "allowed".
  // REWRITTEN 2026-09-16: an always-on readout, not an alert.
  //
  // The old version was alert-only and hidden by default, because at
  // the time no live plan-usage percentage could be polled -- the CLI
  // only reported utilization on an actual threshold crossing. Claude
  // Code now passes `rate_limits` to the status line command on stdin,
  // so `tools/statusline_usage.py` caches real numbers and server.py
  // serves them. Verified against Sir's UI: 58% matched exactly.
  //
  // COLOUR IS DRIVEN BY THE 5-HOUR WINDOW ONLY (Sir's call, 2026-09-16):
  // context auto-compacts at 97% so it looks after itself, and the
  // weekly window is not a limit he realistically reaches. Both are
  // still displayed, they just never drive the colour.
  const RL_OK = "#ffffff", RL_WARN = "#ffb84d", RL_HIT = "#ff4d4d";
  const RL_WARN_PCT = 80, RL_HIT_PCT = 95;
  // Nothing writes this file unless a Claude Code session is live, so a
  // reading can age. Showing an old percentage as if it were current
  // would be a lie -- dim it and say so instead.
  const RL_STALE_S = 300;
  let rlEl = null, rlPoll = null, rlKey = null;

  function rlAgo(sec) {
    if (sec < 90) return `${Math.round(sec)}s`;
    const m = Math.round(sec / 60);
    return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
  }
  function rlUntil(epoch) {
    const s = epoch - Date.now() / 1000;
    if (s <= 0) return "due";
    const m = Math.round(s / 60), h = Math.floor(m / 60);
    return h ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
  }

  function rateLimitInit() {
    if (SHOT || DEMO || rlEl) return;
    rlEl = document.createElement("div");
    rlEl.style.cssText =
      "position:fixed;right:16px;top:16px;z-index:20;display:none;" +
      "font:700 13px/1.4 'SF Mono',Menlo,Consolas,monospace;" +
      "letter-spacing:.05em;pointer-events:none;text-align:right;" +
      "text-shadow:0 0 8px currentColor";
    document.body.appendChild(rlEl);
    rateLimitPoll();
    rlPoll = setInterval(rateLimitPoll, 3000);
  }

  async function rateLimitPoll() {
    if (!rlEl) return;
    let d;
    try {
      const r = await fetch("/rate_limit", { cache: "no-store" });
      d = await r.json();
    } catch (e) { return; }  // server gone: leave last reading on screen

    if (!d || d.present === false || d.present === undefined) {
      // No file yet, or rate_limits genuinely absent (pre-first-response
      // / non-Pro plan). Say so rather than imply zero usage.
      if (rlKey !== "none") {
        rlKey = "none";
        rlEl.style.color = RL_OK;
        rlEl.style.opacity = "0.45";
        rlEl.textContent = "usage n/a";
        rlEl.style.display = "";
      }
      return;
    }

    const five = d.five_hour || {}, seven = d.seven_day || {};
    const age = d.captured_at_epoch
      ? Date.now() / 1000 - d.captured_at_epoch : null;
    const stale = age !== null && age > RL_STALE_S;

    const parts = [];
    if (d.model) parts.push(d.model);
    if (d.context_pct != null) parts.push(`ctx ${Math.round(d.context_pct)}%`);
    if (five.used_percentage != null) {
      let s = `5h ${Math.round(five.used_percentage)}%`;
      if (five.resets_at) s += ` (${rlUntil(five.resets_at)})`;
      parts.push(s);
    }
    if (seven.used_percentage != null) {
      let s = `7d ${Math.round(seven.used_percentage)}%`;
      if (seven.resets_at) s += ` (${rlUntil(seven.resets_at)})`;
      parts.push(s);
    }
    let text = parts.join(" | ");
    if (stale) text += `  (stale ${rlAgo(age)})`;

    // Colour: 5-hour window only. Falls back to white on its own as the
    // percentage drops at reset -- no special "reset" handling needed.
    const p = five.used_percentage;
    const colour = p == null ? RL_OK
      : p >= RL_HIT_PCT ? RL_HIT
      : p >= RL_WARN_PCT ? RL_WARN : RL_OK;

    const key = text + "|" + colour;
    if (key === rlKey) return;   // repaint only on a real change
    rlKey = key;
    rlEl.style.color = colour;
    rlEl.style.opacity = stale ? "0.5" : "1";
    rlEl.textContent = text;
    rlEl.style.display = "";
  }

  /* ----------------------- envelope + samples easing ----------------------- */
  let peak = 0.05, sPeak = 200;
  function tick(dt) {
    if (DEMO) demoUpdate(dt);
    A.state = raw.state || "idle";
    A.alert = !!raw.alert;
    A.level = raw.level || 0;
    dimUpdate(dt);

    // adaptive envelope: normalize against a decaying peak, then ease
    // (attack 50ms, release 350ms) — motion code rides AV.env
    const dts = dt / 1000;
    peak = Math.max(A.level, 0.05, peak - 0.5 * peak * dts);
    const target = Math.min(1, A.level / peak);
    const tau = target > A.env ? 50 : 350;
    A.env += (target - A.env) * Math.min(1, dt / tau);

    // waveform ring: rectify, normalize against its own decaying peak,
    // blend toward the newest frame so the ring flows instead of flickers
    const s = raw.samples;
    A.rawSamples = s && s.length ? s : null;   // signed, int16-scale floats
    if (s && s.length) {
      let mx = 0;
      for (let i = 0; i < s.length; i++) mx = Math.max(mx, Math.abs(s[i]));
      sPeak = Math.max(mx, 200, sPeak * 0.98);
      const n = s.length;
      for (let i = 0; i < 64; i++) {
        const v = Math.abs(s[Math.min(n - 1, Math.round(i * (n - 1) / 63))])
          / sPeak;
        A.samples[i] = A.samples[i] * 0.45 + Math.min(1, v) * 0.55;
      }
    } else {
      for (let i = 0; i < 64; i++) A.samples[i] *= Math.max(0, 1 - dts * 6);
    }
    if (A.state !== "speaking" && !DEMO)
      for (let i = 0; i < 64; i++) A.samples[i] *= Math.max(0, 1 - dts * 6);

    if (A._mic && A._micAnalyser) micRead();
    soundUpdate();
  }

  /* --------------------------------- mic ---------------------------------- */
  let micPeak = 0.02;
  function micRead() {
    const an = A._micAnalyser;
    const buf = A._micBuf;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    micPeak = Math.max(rms, 0.02, micPeak * 0.999);
    A.micLevel = Math.min(1, rms / micPeak);
  }
  async function micStart() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      A._micAnalyser = an;
      A._micBuf = new Float32Array(an.fftSize);
      const kick = () => ctx.state === "suspended" && ctx.resume();
      addEventListener("click", kick); addEventListener("keydown", kick);
    } catch (e) { /* no mic permission: level stays 0, faces degrade */ }
  }

  /* ----------------------------- thinking sound ---------------------------- */
  let audio = null, sndBtn = null, playing = false;
  A._sndWant = true;
  function soundInit() {
    if (SHOT) return;
    try { A._sndOn = localStorage.getItem("av_sound") !== "0"; }
    catch (e) { A._sndOn = true; }
    audio = new Audio(new URL("assets/thinking.wav", ROOT).href);
    audio.volume = 0.35;
    sndBtn = document.createElement("div");
    // hidden until the mouse moves, so it never collides with a face's
    // chrome and never shows on camera or in an OBS source
    sndBtn.style.cssText =
      "position:fixed;left:64px;bottom:14px;z-index:50;cursor:pointer;" +
      "font:12px 'SF Mono',Menlo,Consolas,monospace;letter-spacing:.2em;" +
      "color:#5a6a72;opacity:0;transition:opacity .4s;user-select:none;" +
      "pointer-events:none";
    sndBtn.title = "thinking sound on/off";
    let hideT = null;
    addEventListener("mousemove", () => {
      sndBtn.style.opacity = ".65";
      sndBtn.style.pointerEvents = "auto";
      clearTimeout(hideT);
      hideT = setTimeout(() => {
        sndBtn.style.opacity = "0";
        sndBtn.style.pointerEvents = "none";
      }, 3000);
    });
    sndBtn.onclick = () => {
      A._sndOn = !A._sndOn;
      try { localStorage.setItem("av_sound", A._sndOn ? "1" : "0"); }
      catch (e) {}
      if (!A._sndOn) stopSound();
      paintBtn();
    };
    paintBtn();
    document.body.appendChild(sndBtn);
  }
  function paintBtn() {
    if (sndBtn) sndBtn.textContent = A._sndOn ? "SND ON" : "SND OFF";
  }
  function stopSound() {
    if (audio && playing) { audio.pause(); audio.currentTime = 0; }
    playing = false;
  }
  function soundUpdate() {
    if (!audio || !A._sndWant) return;
    const want = A._sndOn && A.state === "thinking" && !raw.loading;
    if (want && !playing) {
      playing = true;
      audio.currentTime = 0;
      audio.play().catch(() => { playing = false; });
    } else if (!want && playing) {
      stopSound();
    }
  }

  /* ------------------------------ shot harness ----------------------------- */
  // Runs the face's frame() deterministically (a synchronous burst of t ms).
  // A headless browser resizes the window and finishes loading images AFTER
  // the first burst, so the burst re-runs on resize and on two late timers
  // (the last one flags "ready"), then keeps painting at frame pace so the
  // late capture always sees a fresh composite.
  A.shotRun = (frame) => {
    const burst = () => { for (let t = 0; t < SHOT_T; t += 16.6) frame(16.6); };
    burst();
    addEventListener("resize", burst);
    setTimeout(burst, 450);
    setTimeout(burst, 900);
    setTimeout(() => { burst(); document.title = "ready"; }, 3000);
    // fat 100ms steps: assets that finish loading after the last burst
    // still reach their steady state within a few paints
    const loop = () => { frame(100); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  };

  /* ---------------------------------- init --------------------------------- */
  A.init = (opts = {}) => {
    A._mic = !!opts.mic;
    if (A._mic && !DEMO) micStart();
    if (opts.sound !== false) soundInit(); else A._sndWant = false;
    dimInit();
    if (DEMO) {
      applyConfig({ name: Q.get("name") || "JARVIS" });
    } else {
      fetch("/config", { cache: "no-store" })
        .then(r => r.json()).then(applyConfig)
        .catch(() => applyConfig({}));
    }
    return A;
  };

  A.tick = tick;

  /* ----------------------------- render helpers ---------------------------- */
  const U = {};
  U.dim = (c, f) => {
    f = Math.max(0, Math.min(1, f));
    return `rgb(${c[0] * f | 0},${c[1] * f | 0},${c[2] * f | 0})`;
  };
  U.rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  U.mix = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t | 0,
                          c1[1] + (c2[1] - c1[1]) * t | 0,
                          c1[2] + (c2[2] - c1[2]) * t | 0];
  // soft additive glow sprite (canvas), cached by the caller
  U.makeGlow = (rgb, size) => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(size / 2, size / 2, 0,
                                       size / 2, size / 2, size / 2);
    grd.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
    grd.addColorStop(.25, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.55)`);
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return c;
  };
  // the one-field bloom rule: draw everything luminous into one field
  // canvas, bloom the WHOLE field (two downscale taps), composite
  // additively — bloom applied per-element reads as pencil lines
  U.bloomBlit = (dst, field, w, h) => {
    if (!field._b4 || field._b4.width !== w >> 2) {
      field._b4 = document.createElement("canvas");
      field._b4.width = Math.max(1, w >> 2);
      field._b4.height = Math.max(1, h >> 2);
      field._b8 = document.createElement("canvas");
      field._b8.width = Math.max(1, w >> 3);
      field._b8.height = Math.max(1, h >> 3);
    }
    const g4 = field._b4.getContext("2d"), g8 = field._b8.getContext("2d");
    g4.clearRect(0, 0, field._b4.width, field._b4.height);
    g4.drawImage(field, 0, 0, field._b4.width, field._b4.height);
    g8.clearRect(0, 0, field._b8.width, field._b8.height);
    g8.drawImage(field, 0, 0, field._b8.width, field._b8.height);
    const prev = dst.globalCompositeOperation;
    dst.globalCompositeOperation = "lighter";
    dst.drawImage(field, 0, 0);
    dst.drawImage(field._b4, 0, 0, w, h);
    dst.drawImage(field._b8, 0, 0, w, h);
    dst.globalCompositeOperation = prev;
  };
  // text that resolves out of glyph noise, left to right
  U.Descrambler = class {
    constructor(text, perChar = 50, hold = null) {
      this.text = text; this.per = perChar; this.hold = hold;
      this.t = 0; this.done = false;
      this.chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&";
    }
    render(dt) {
      this.t += dt;
      const n = this.t / this.per | 0;
      let out = "";
      for (let i = 0; i < this.text.length; i++) {
        const ch = this.text[i];
        out += (i < n || ch === " ") ? ch
          : this.chars[Math.random() * this.chars.length | 0];
      }
      if (this.hold != null && this.t > this.per * this.text.length + this.hold)
        this.done = true;
      return out;
    }
  };
  A.util = U;

  return A;
})();
