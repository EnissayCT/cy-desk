/* Cy, the plush mascot.
   Body: Cycles renders (mascot/build_mascot.py) — a 21×7 grid of head turns (3° × 4°), a full
   turn-around, sitting, waving, cheering, sleeping, singing, plus a stand mic on its own layer.
   Every frame shown is a weighted blend of renders ("lighter" compositing of premultiplied
   images), so head motion is continuous. The face is SVG, placed with blended per-pose anchors.
   Behaviour: an attention model decides whether Cy cares about the mouse; when it doesn't, a
   scheduler picks something to do. System audio (main process meter) makes Cy sing.
   API: window.Buddy.{setBase, onCursor, onAudio, celebrate, notify, say, setPaused, poke, state, ideaSource} */
(function () {
  const M = window.MASCOT;
  const $ = (s) => document.querySelector(s);
  const el = $('#mascot'), canvas = $('#mascotCanvas'), face = $('#face'), fx = $('#fx'), micEl = $('#mic');
  const bubble = $('#bubble'), bubbleText = $('#bubbleText');
  const ctx = canvas.getContext('2d');
  const W = M.width, H = M.height;
  const YAWS = M.yaws, PITCHES = M.pitches;
  const SIT_YAWS = [-18, -9, 0, 9, 18];
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => performance.now();
  const INK = '#1d1517';
  face.setAttribute('viewBox', `0 0 ${W} ${H}`);

  // ---------------------------------------------------------------- images
  // 176 renders decoded would hold ~165 MB. Keep them encoded (~2.5 MB) and decode on demand
  // into a small LRU of ImageBitmaps around the current pose; prefetch neighbours ahead of time.
  const enc = {};
  const bmp = new Map();
  const pending = new Set();
  const CAP = 80;
  const names = Object.keys(M.frames);
  const ready = Promise.all(names.map((n) => new Promise((res) => {
    const im = new Image();
    im.onload = () => { enc[n] = im; res(); };
    im.onerror = res;
    im.src = `mascot/${n}.webp`;
  })));
  micEl.src = 'mascot/mic.webp';
  function request(n) {
    if (bmp.has(n) || pending.has(n) || !enc[n]) return;
    pending.add(n);
    createImageBitmap(enc[n]).then((b) => {
      pending.delete(n);
      bmp.set(n, b);
      while (bmp.size > CAP) { const [k, v] = bmp.entries().next().value; bmp.delete(k); v.close(); }
      dirty = true;
      if (paused) draw(); else wakeLoop(); // covered: still keep a ready frame for when the desktop shows
    }).catch(() => pending.delete(n));
  }
  function bitmap(n) {
    const b = bmp.get(n);
    if (b) { bmp.delete(n); bmp.set(n, b); return b; } // most recently used goes last
    request(n);
    return null;
  }
  function prefetchAround() {
    const [y0, y1] = bracket(YAWS, head.ty), [p0, p1] = bracket(PITCHES, head.tp);
    for (let p = Math.max(0, Math.min(p0, bracket(PITCHES, head.pitch)[0]) - 1); p <= Math.min(PITCHES.length - 1, Math.max(p1, bracket(PITCHES, head.pitch)[1]) + 1); p++) {
      const lo = Math.max(0, Math.min(y0, bracket(YAWS, head.yaw)[0]) - 2), hi = Math.min(YAWS.length - 1, Math.max(y1, bracket(YAWS, head.yaw)[1]) + 2);
      for (let y = lo; y <= hi; y++) request(`g_${y}_${p}`);
    }
  }
  const prefetch = (list) => list.forEach(request);

  function fitCanvas() {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (w && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; dirty = true; }
  }

  // ---------------------------------------------------------------- looks
  // A look resolves to weighted render names. 'gaze' and 'sitgaze' follow the live head angles.
  const head = { yaw: 0, pitch: 0, vy: 0, vp: 0, ty: 0, tp: 0, omega: 5 };
  const eye = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };
  const turn = { angle: 0 };
  function bracket(list, v) {
    v = clamp(v, list[0], list[list.length - 1]);
    for (let i = 0; i < list.length - 1; i++) {
      if (v <= list[i + 1]) return [i, i + 1, (v - list[i]) / (list[i + 1] - list[i])];
    }
    return [list.length - 1, list.length - 1, 0];
  }
  function samples(look) {
    if (look.kind === 'gaze') {
      const [y0, y1, fy] = bracket(YAWS, head.yaw), [p0, p1, fp] = bracket(PITCHES, head.pitch);
      return [[`g_${y0}_${p0}`, (1 - fy) * (1 - fp)], [`g_${y1}_${p0}`, fy * (1 - fp)], [`g_${y0}_${p1}`, (1 - fy) * fp], [`g_${y1}_${p1}`, fy * fp]];
    }
    if (look.kind === 'sitgaze') {
      const [a, b, f] = bracket(SIT_YAWS, head.yaw);
      return [[`sit_${a}`, 1 - f], [`sit_${b}`, f]];
    }
    if (look.kind === 'turn') {
      const t = (((turn.angle % 360) + 360) % 360) / 22.5, a = Math.floor(t) % 16, b = (a + 1) % 16, f = t - Math.floor(t);
      return [[`turn_${String(a).padStart(2, '0')}`, 1 - f], [`turn_${String(b).padStart(2, '0')}`, f]];
    }
    return [[look.name, 1]];
  }
  const GAZE = { kind: 'gaze' }, SITGAZE = { kind: 'sitgaze' }, TURN = { kind: 'turn' };
  const F = (name) => ({ kind: 'frame', name });

  // Crossfade between looks: from a frozen mix to a new look over `dur` ms.
  let mixFrom = [[GAZE, 1]], mixTo = GAZE, mixT0 = 0, mixDur = 0, look = GAZE;
  function progress() { return mixDur ? clamp((now() - mixT0) / mixDur, 0, 1) : 1; }
  function currentMix() {
    const p = progress(), e = p * p * (3 - 2 * p);
    if (e >= 1) return [[mixTo, 1]];
    return mixFrom.map(([l, w]) => [l, w * (1 - e)]).concat([[mixTo, e]]);
  }
  function setLook(next, dur = 260) {
    if (next === mixTo && progress() >= 1) return;
    // Freeze what is on screen now (a look's live state is fine to share: gaze follows the head anyway).
    mixFrom = currentMix().filter(([, w]) => w > 0.01);
    mixTo = next; mixT0 = now(); mixDur = dur; look = next;
    wakeLoop();
  }

  // ---------------------------------------------------------------- drawing
  let dirty = true, lastKey = '', headless = false;
  function weights() {
    const acc = {};
    for (const [l, w] of currentMix()) for (const [n, sw] of samples(l)) if (sw * w > 0.004) acc[n] = (acc[n] || 0) + sw * w;
    return acc;
  }
  function draw() {
    if (headless) return; // a custom 3D model is drawn instead (ui/model.js)
    const ws = weights();
    const key = Object.entries(ws).map(([n, w]) => `${n}:${w.toFixed(3)}`).join('|') + `|${eye.x.toFixed(2)},${eye.y.toFixed(2)}`;
    if (key === lastKey && !dirty) return;
    // Frames still decoding are left out and the rest re-weighted; if too little is ready, keep the last image.
    const have = Object.entries(ws).map(([n, w]) => [bitmap(n), w]).filter(([b]) => b);
    const sum = have.reduce((s, [, w]) => s + w, 0);
    prefetchAround();
    if (sum < 0.35) { if (!have.length) return; }
    lastKey = key; dirty = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'lighter'; // premultiplied sum: weights add up to an opaque body
    ctx.imageSmoothingQuality = 'high';
    for (const [b, w] of have) {
      ctx.globalAlpha = Math.min(1, w / sum);
      ctx.drawImage(b, 0, 0, canvas.width, canvas.height);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    placeFace(ws);
  }

  // ---------------------------------------------------------------- face
  const NS = 'http://www.w3.org/2000/svg';
  face.insertAdjacentHTML('afterbegin', `<defs><radialGradient id="blush"><stop offset="0" stop-color="#ff7f98" stop-opacity=".62"/><stop offset=".55" stop-color="#ff8fa3" stop-opacity=".3"/><stop offset="1" stop-color="#ff9fb0" stop-opacity="0"/></radialGradient></defs>`);
  const parts = {};
  for (const n of ['cheekL', 'cheekR', 'eyeL', 'eyeR', 'browL', 'browR', 'mouth']) {
    const g = document.createElementNS(NS, 'g'); g.setAttribute('class', `feat ${n}`); face.appendChild(g); parts[n] = g;
  }
  function placeFace(ws) {
    // Blend the anchors of every frame on screen.
    const A = {};
    let total = 0;
    for (const [n, w] of Object.entries(ws)) {
      const fr = M.frames[n]; if (!fr) continue;
      total += w;
      for (const [k, a] of Object.entries(fr)) {
        const t = A[k] || (A[k] = { x: 0, y: 0, ax0: 0, ax1: 0, az0: 0, az1: 0, f: 0 });
        t.x += a.x * w; t.y += a.y * w; t.ax0 += a.ax[0] * w; t.ax1 += a.ax[1] * w; t.az0 += a.az[0] * w; t.az1 += a.az[1] * w; t.f += a.facing * w;
      }
    }
    if (!total) return;
    for (const [k, g] of Object.entries(parts)) {
      const a = A[k]; if (!a) continue;
      const rx = (-a.ax0 / total) * W * 0.01, ry = (-a.ax1 / total) * H * 0.01;
      const dx = (-a.az0 / total) * W * 0.01, dy = (-a.az1 / total) * H * 0.01;
      let ex = (a.x / total) * W, ey = (a.y / total) * H;
      if (k.startsWith('eye')) { ex += rx * eye.x + dx * eye.y; ey += ry * eye.x + dy * eye.y; }
      g.setAttribute('transform', `matrix(${rx.toFixed(4)} ${ry.toFixed(4)} ${dx.toFixed(4)} ${dy.toFixed(4)} ${ex.toFixed(2)} ${ey.toFixed(2)})`);
      const f = a.f / total;
      g.style.opacity = f < 0.3 ? 0 : f < 0.5 ? (f - 0.3) / 0.2 : 1;
    }
  }

  const EYES = {
    open: `<g class="lid"><ellipse rx="7.8" ry="9.5" fill="${INK}"/><circle cx="-2.8" cy="-3.8" r="2.9" fill="#fff"/><circle cx="2.9" cy="3.4" r="1.2" fill="#fff" opacity=".7"/></g>`,
    small: `<g class="lid"><ellipse rx="6.8" ry="8.3" fill="${INK}"/><circle cx="-2.4" cy="-3.2" r="2.4" fill="#fff"/></g>`,
    big: `<g class="lid"><ellipse rx="9.4" ry="11.4" fill="${INK}"/><circle cx="-3.3" cy="-4.6" r="3.4" fill="#fff"/><circle cx="3.4" cy="4" r="1.5" fill="#fff" opacity=".7"/></g>`,
    happy: `<path d="M -7.5 2.6 Q 0 -7.5 7.5 2.6" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"/>`,
    closed: `<path d="M -7.5 -1 Q 0 5.5 7.5 -1" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`,
    squint: `<g class="lid"><ellipse rx="6.6" ry="5.6" fill="${INK}"/><circle cx="-2.2" cy="-1.8" r="1.8" fill="#fff"/></g>`,
    heart: `<path d="M 0 7 C -9 0 -8 -7.5 -3.6 -7.5 C -1.6 -7.5 -0.4 -6 0 -4.6 C 0.4 -6 1.6 -7.5 3.6 -7.5 C 8 -7.5 9 0 0 7 Z" fill="#ec4f74"/><circle cx="-3.6" cy="-4.2" r="1.4" fill="#fff" opacity=".85"/>`,
    star: `<path d="M0 -9 L2.6 -2.8 L9 -2.6 L4 1.6 L5.6 8 L0 4.4 L-5.6 8 L-4 1.6 L-9 -2.6 L-2.6 -2.8 Z" fill="#f5b42a" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/>`
  };
  const MOUTHS = {
    smile: `<path d="M -5.6 -1.6 Q 0 6.8 5.6 -1.6 Z" fill="#4a1d27"/><ellipse cx="0" cy="2.2" rx="2.5" ry="1.5" fill="#f07c8e"/>`,
    grin: `<path d="M -8.4 -2.4 Q 0 11 8.4 -2.4 Z" fill="#4a1d27"/><ellipse cx="0" cy="4" rx="3.8" ry="2.2" fill="#f07c8e"/>`,
    o: `<ellipse rx="3.2" ry="3.9" fill="#4a1d27"/>`,
    yawn: `<ellipse rx="5.4" ry="7.6" fill="#4a1d27"/><ellipse cy="3.6" rx="3.4" ry="2.4" fill="#f07c8e"/>`,
    small: `<path d="M -3 0 Q 0 2.6 3 0" fill="none" stroke="#4a1d27" stroke-width="1.9" stroke-linecap="round"/>`,
    wavy: `<path d="M -5 1 Q -2.5 -1.6 0 1 T 5 1" fill="none" stroke="#4a1d27" stroke-width="1.9" stroke-linecap="round"/>`,
    frown: `<path d="M -5.5 3 Q 0 -3 5.5 3" fill="none" stroke="#4a1d27" stroke-width="2.2" stroke-linecap="round"/>`,
    sing: `<ellipse class="sm" rx="4.6" ry="2" fill="#4a1d27"/><ellipse class="st" cy="1.6" rx="2.8" ry="1" fill="#f07c8e"/>`
  };
  const BROWS = {
    none: ['', ''],
    angry: [`<path d="M -6 2.6 L 6 -2.6" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`, `<path d="M -6 -2.6 L 6 2.6" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`],
    worried: [`<path d="M -6 -2.4 Q 0 -1 6 2" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>`, `<path d="M -6 2 Q 0 -1 6 -2.4" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>`],
    up: [`<path d="M -5.5 -3 Q 0 -6 5.5 -3" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`, `<path d="M -5.5 -3 Q 0 -6 5.5 -3" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`]
  };
  //               eyes      mouth    brows      cheeks
  const FACES = {
    happy:     ['open',   'smile', 'none',    0.7],
    content:   ['open',   'small', 'none',    0.55],
    worried:   ['small',  'wavy',  'worried', 0.3],
    angry:     ['squint', 'frown', 'angry',   0.15],
    sleepy:    ['closed', 'o',     'none',    0.55],
    giggle:    ['happy',  'grin',  'none',    1],
    love:      ['heart',  'grin',  'none',    1],
    surprised: ['big',    'o',     'up',      0.5],
    curious:   ['big',    'small', 'up',      0.6],
    idea:      ['star',   'grin',  'up',      0.8],
    yawn:      ['closed', 'yawn',  'none',    0.5],
    hum:       ['happy',  'small', 'none',    0.85],
    sing:      ['open',   'sing',  'none',    0.85],
    singLoud:  ['happy',  'sing',  'up',      1]
  };
  let shownFace = '';
  function setFace(name) {
    const [eyes, mouth, brows, cheeks] = FACES[name] || FACES.happy;
    const key = `${eyes}|${mouth}|${brows}|${cheeks}`;
    if (key === shownFace) return;
    shownFace = key;
    parts.eyeL.innerHTML = parts.eyeR.innerHTML = EYES[eyes];
    parts.mouth.innerHTML = MOUTHS[mouth];
    parts.browL.innerHTML = BROWS[brows][0];
    parts.browR.innerHTML = BROWS[brows][1];
    parts.cheekL.innerHTML = parts.cheekR.innerHTML = `<ellipse rx="13" ry="7.5" fill="url(#blush)" opacity="${cheeks}"/>`;
  }
  function blink() {
    for (const e of [parts.eyeL, parts.eyeR]) {
      const lid = e.querySelector('.lid'); if (!lid) continue;
      lid.setAttribute('transform', 'scale(1 0.1)');
      setTimeout(() => lid.setAttribute('transform', ''), 115);
    }
  }

  // ---------------------------------------------------------------- state
  let base = { mood: 'happy', level: 'ok', lines: ['Hi!'] };
  let emote = null, emoteUntil = 0, faceOverride = null;
  let paused = false, asleep = false, sitting = false, focusMode = false, space = null;
  let lastActivity = Date.now(), lineIndex = 0, sayLock = 0, pokes = [];
  const moodFace = () => faceOverride || (emote && Date.now() < emoteUntil ? emote : null) || (asleep ? 'sleepy' : sing.on ? (sing.env > 0.62 ? 'singLoud' : 'sing') : base.mood);

  function applyFace() {
    const f = moodFace();
    setFace(f);
    fx.querySelectorAll('.z, .anger, .sweat').forEach((n) => n.remove());
    if (f === 'sleepy') fx.insertAdjacentHTML('beforeend', '<span class="z">z</span><span class="z">z</span><span class="z">z</span>');
    if (f === 'angry') fx.insertAdjacentHTML('beforeend', '<span class="anger"></span>');
    if (f === 'worried') fx.insertAdjacentHTML('beforeend', '<span class="sweat"></span>');
    bubble.classList.toggle('bad', !emote && base.level === 'bad');
    bubble.classList.toggle('warn', !emote && base.level === 'warn');
  }
  let emoteTimer = null;
  function setEmote(name, ms) {
    emote = name; emoteUntil = Date.now() + ms;
    applyFace();
    clearTimeout(emoteTimer);
    emoteTimer = setTimeout(() => { emote = null; applyFace(); }, ms);
  }
  function once(cls, ms) {
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }

  // ---------------------------------------------------------------- speech
  function say(text, holdMs = 0) {
    if (!text) return;
    if (holdMs) sayLock = Date.now() + holdMs;
    bubbleText.classList.add('out');
    setTimeout(() => { bubbleText.textContent = text; bubbleText.classList.remove('out'); }, 280);
  }
  setInterval(() => {
    if (paused || asleep || sing.on || focusMode || Date.now() < sayLock) return;
    const lines = base.lines.length ? base.lines : ['…'];
    lineIndex = (lineIndex + 1) % lines.length;
    say(lines[lineIndex]);
  }, 21000);

  // ---------------------------------------------------------------- motion loop
  // Critically damped springs: smooth, no overshoot, frame-rate independent.
  function spring(x, v, target, omega, dt) {
    const f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo;
    const inv = 1 / (f + hhoo);
    return [(f * x + dt * v + hhoo * target) * inv, (v + hoo * (target - x)) * inv];
  }
  let raf = null, lastT = 0, tweens = [];
  function wakeLoop() { if (!raf && !paused) { lastT = now(); raf = requestAnimationFrame(loop); } }
  function tween(obj, key, to, ms, ease = (p) => p * p * (3 - 2 * p)) {
    return new Promise((res) => { tweens.push({ obj, key, from: obj[key], to, t0: now(), ms, ease, res }); wakeLoop(); });
  }
  function loop(t) {
    raf = null;
    if (paused) return;
    const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
    [head.yaw, head.vy] = spring(head.yaw, head.vy, head.ty, head.omega, dt);
    [head.pitch, head.vp] = spring(head.pitch, head.vp, head.tp, head.omega, dt);
    [eye.x, eye.vx] = spring(eye.x, eye.vx, eye.tx, 22, dt);
    [eye.y, eye.vy] = spring(eye.y, eye.vy, eye.ty, 22, dt);
    tweens = tweens.filter((tw) => {
      const p = clamp((t - tw.t0) / tw.ms, 0, 1);
      tw.obj[tw.key] = tw.from + (tw.to - tw.from) * tw.ease(p);
      if (p >= 1) { tw.res(); return false; }
      return true;
    });
    if (sing.on) singTick(t, dt);
    draw();
    const moving = Math.abs(head.ty - head.yaw) > 0.05 || Math.abs(head.tp - head.pitch) > 0.05 || Math.abs(head.vy) > 0.02 || Math.abs(head.vp) > 0.02 ||
      Math.abs(eye.tx - eye.x) > 0.02 || Math.abs(eye.ty - eye.y) > 0.02 || progress() < 1 || tweens.length || sing.on;
    if (moving) raf = requestAnimationFrame(loop);
  }

  // Aim the head (degrees). Eyes lead: they jump toward the target and settle as the head arrives.
  let eyeTimer = null;
  function aim(yaw, pitch, omega) {
    head.ty = clamp(yaw, -30, 30); head.tp = clamp(pitch, -12, 12);
    if (omega) head.omega = omega;
    eye.tx = clamp((head.ty - head.yaw) / 9, -1, 1) * 2.4;
    eye.ty = clamp((head.tp - head.pitch) / 8, -1, 1) * 1.8;
    clearTimeout(eyeTimer);
    eyeTimer = setTimeout(() => { eye.tx = 0; eye.ty = 0; wakeLoop(); }, 220 + 2200 / head.omega);
    wakeLoop();
  }
  function headCenter() { const r = canvas.getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.36 }; }
  function anglesTo(x, y) {
    const c = headCenter();
    return [(Math.atan2(x - c.x, 560) * 180) / Math.PI, (Math.atan2(y - c.y, 640) * 180) / Math.PI];
  }
  function lookAtPoint(x, y, omega) { const [a, b] = anglesTo(x, y); aim(a, b, omega); }
  function lookAtEl(sel, omega = 4) {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    if (r) lookAtPoint(r.left + r.width * rand(0.3, 0.7), r.top + r.height * rand(0.3, 0.7), omega);
  }

  // ---------------------------------------------------------------- attention
  // Interest rises with mouse movement (more when it's close) and fades. Cy's follow mood
  // decides how much interest it takes to look, and how fast the head goes.
  const MODES = { eager: { need: 0.18, omega: 7.5, every: 0 }, lazy: { need: 0.38, omega: 3.2, every: 650 }, aloof: { need: 0.72, omega: 2.4, every: 1200 } };
  let mode = 'lazy', interest = 0, cursor = { x: 0, y: 0, t: 0 }, lastHeadUpdate = 0, tracking = false;
  function pickMode() {
    const night = new Date().getHours() < 7;
    const w = night ? [['eager', 1], ['lazy', 3], ['aloof', 3]] : base.level === 'bad' ? [['eager', 1], ['lazy', 2], ['aloof', 2]] : [['eager', 3], ['lazy', 4], ['aloof', 2]];
    let r = Math.random() * w.reduce((s, [, v]) => s + v, 0);
    for (const [m, v] of w) { if ((r -= v) <= 0) { mode = m; break; } }
    setTimeout(pickMode, rand(25000, 50000));
  }
  function onCursor(p) {
    const t = Date.now();
    if (cursor.t) {
      const d = Math.hypot(p.x - cursor.x, p.y - cursor.y), dt = Math.max(16, t - cursor.t);
      const c = headCenter(), near = Math.hypot(p.x - c.x, p.y - c.y) < 260 ? 1.8 : 1;
      interest = clamp(interest * Math.exp(-(dt / 1000) / 3.2) + Math.min(0.2, (d / dt) * 0.045) * near, 0, 1);
    }
    cursor = { x: p.x, y: p.y, t };
    if (paused) return;
    lastActivity = t;
    if (asleep) { wake(); return; }
    if (sing.on) return;
    // A strong burst of movement pulls Cy out of a minor activity, like a pet noticing you.
    if (busy() && interest > 0.85 && ['lookAround', 'hum', 'stretch', 'hop'].includes(act.name)) { cancelAct(); setLook(GAZE, 250); }
    if (busy()) return;
    const m = MODES[mode];
    tracking = interest > m.need;
    if (tracking && t - lastHeadUpdate > m.every) {
      lastHeadUpdate = t;
      const [a, b] = anglesTo(p.x, p.y);
      aim(sitting ? clamp(a, -18, 18) : a, sitting ? 0 : b, m.omega);
    }
  }
  setInterval(() => { interest *= 0.82; if (interest < 0.1) tracking = false; }, 700);

  // ---------------------------------------------------------------- activities
  let act = null; // { name, token }
  const busy = () => !!act && act.name !== 'sit';
  const wait = (ms, token) => new Promise((res, rej) => setTimeout(() => (token.cancelled ? rej(new Error('cancel')) : res()), ms));
  function cancelAct() {
    if (act) { act.token.cancelled = true; act = null; }
    if (faceOverride) { faceOverride = null; applyFace(); }
  }
  async function run(name, fn) {
    cancelAct();
    const token = { cancelled: false };
    act = { name, token };
    try { await fn(token); } catch (e) { /* cancelled */ }
    if (act && act.token === token) act = null;
  }
  function bulb() {
    fx.insertAdjacentHTML('beforeend', `<span class="bulb"><svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3Z"/></svg></span>`);
    const b = fx.lastElementChild; setTimeout(() => b.remove(), 2600);
  }
  function notes(n = 1) {
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      s.className = 'note'; s.textContent = pick(['♪', '♫', '♪', '♬']);
      s.style.setProperty('--dx', `${rand(-3, 3).toFixed(2)}rem`);
      s.style.setProperty('--r', `${rand(-25, 25).toFixed(0)}deg`);
      s.style.left = `${rand(40, 58)}%`;
      fx.appendChild(s);
      setTimeout(() => s.remove(), 2400);
    }
  }
  const A = {
    async lookAround(tk) {
      const spots = space ? ['#spacePanel .sp-head', '#spacePanel .sp-card', '#spacePanel .sp-card:last-child', '#spacePanel .sp-kpis', '#focusList', '#health']
        : ['#health', '#focusList', '#plist', '#heat', '#greet', '#serverPills', '#stats'];
      for (let i = 0, n = Math.floor(rand(2, 4)); i < n; i++) {
        lookAtEl(pick(spots), rand(3, 6)); await wait(rand(900, 2200), tk);
        if (Math.random() < 0.3) blink();
      }
      aim(rand(-4, 4), rand(-2, 3), 3);
    },
    async sit(tk) {
      sitting = true; prefetch(['sit_0', 'sit_1', 'sit_2', 'sit_3', 'sit_4', 'sit_sleep']);
      el.classList.add('dip'); setTimeout(() => el.classList.remove('dip'), 520);
      aim(0, 0, 3); setLook(SITGAZE, 480);
      say(pick(['Taking a little break.', 'Sitting down for a sec.', '*sits*', 'Comfy.']), 3000);
      const end = Date.now() + rand(25000, 80000);
      while (Date.now() < end) {
        await wait(rand(4000, 9000), tk);
        if (Math.random() < 0.4) aim(rand(-18, 18), 0, 2.5);
        if (Date.now() - lastActivity > 45000 && Math.random() < 0.5) { asleep = true; setLook(F('sit_sleep'), 900); applyFace(); await wait(rand(20000, 40000), tk); asleep = false; applyFace(); setLook(SITGAZE, 700); }
      }
      await standUp();
    },
    async idea(tk) {
      setEmote('surprised', 380); await wait(380, tk);
      bulb(); setLook(F('wave_0'), 260); faceOverride = 'idea'; applyFace();
      const text = (window.Buddy.ideaSource && window.Buddy.ideaSource()) || 'Idea: take a short break, then the next task.';
      say(text, 9000);
      await wait(2200, tk);
      setLook(GAZE, 380); faceOverride = null; applyFace(); once('hop', 750);
    },
    async turnAround(tk) {
      prefetch([...Array(16).keys()].map((i) => `turn_${String(i).padStart(2, '0')}`)); await wait(120, tk);
      setLook(TURN, 200); turn.angle = 0;
      await tween(turn, 'angle', 360, 2600, (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2));
      setLook(GAZE, 200);
      if (Math.random() < 0.5) say(pick(['Just checking behind me.', 'Ta-da!', 'Spin!']), 2500);
    },
    async wave(tk) {
      for (let i = 0; i < 3; i++) { setLook(F('wave_0'), 160); await wait(200, tk); setLook(F('wave_1'), 160); await wait(200, tk); }
      setLook(GAZE, 260);
    },
    async stretch(tk) {
      faceOverride = 'yawn'; applyFace(); setLook(F('cheer'), 520);
      await wait(1700, tk);
      faceOverride = null; applyFace(); setLook(GAZE, 520); blink();
    },
    async hum(tk) {
      faceOverride = 'hum'; applyFace();
      for (let i = 0; i < 5; i++) { notes(1); aim(i % 2 ? 6 : -6, -3, 3); await wait(650, tk); }
      faceOverride = null; applyFace(); aim(0, 0, 3);
    },
    async hop() { once('hop', 750); },
    async grumble(tk) {
      setEmote('angry', 2600); once('shake', 850); say(base.lines[0], 6000); await wait(2600, tk);
    },
    async shrug(tk) {
      setLook(F('shrug'), 260); lookAtEl('#health', 4); say(base.lines[0], 5000); await wait(1500, tk); setLook(GAZE, 300);
    },
    // v1.1 -------------------------------------------------------------
    async dance(tk) {
      prefetch(['dance_0', 'dance_1']);
      faceOverride = 'giggle'; applyFace();
      for (let i = 0; i < 8; i++) {
        setLook(F(i % 2 ? 'dance_1' : 'dance_0'), 170); aim(i % 2 ? 8 : -8, -3, 6);
        if (i % 2) once('beat', 260); if (i % 3 === 0) notes(1);
        await wait(380, tk);
      }
      once('hop', 750); faceOverride = null; applyFace(); setLook(GAZE, 300); aim(0, 0, 3);
    },
    async think(tk) {
      prefetch(['think']);
      setLook(F('think'), 380); aim(-10, -8, 2.5); faceOverride = 'curious'; applyFace();
      dots();
      await wait(2600, tk);
      faceOverride = null; applyFace(); setLook(GAZE, 380);
      if (Math.random() < 0.6) { await wait(200, tk); await A.idea(tk); } else say(pick(['Hmm. Never mind.', 'Lost my train of thought.', 'Thinking about lunch, honestly.']), 3500);
    },
    async point(tk, text) {
      prefetch(['point']);
      setLook(F('point'), 300); aim(18, -2, 5);
      if (text) say(text, 6000);
      await wait(1800, tk);
      setLook(GAZE, 380); aim(14, 0, 3);
    },
    async bow(tk) {
      prefetch(['bow']);
      setLook(F('bow'), 420); aim(0, 10, 3); await wait(900, tk);
      setLook(GAZE, 420); aim(0, 0, 3);
    },
    async peekaboo(tk) {
      say(pick(['Where did I go?', 'Hide and seek!']), 2500);
      el.classList.add('hide'); micEl.classList.remove('on');
      await wait(rand(1800, 2800), tk);
      el.classList.remove('hide'); setEmote('surprised', 1400); burst('bang'); once('hop', 750);
      say(pick(['Boo!', 'Peekaboo!', 'Found you.']), 3000);
    },
    async coffee(tk) { await holdProp(tk, '☕', pick(['Coffee first. Then code.', 'Morning fuel. Want one too?']), 'happy'); },
    async water(tk) { await holdProp(tk, '💧', pick(['Sip of water? I am having one.', 'Hydration check!']), 'content'); },
    async lunch(tk) { await holdProp(tk, '🥪', pick(['Lunch break? You earned it.', 'My tummy says it is lunch time.']), 'giggle'); },
    async nod(tk) {
      for (let i = 0; i < 2; i++) { aim(head.ty, 8, 9); await wait(170, tk); aim(head.ty, -2, 9); await wait(170, tk); }
      aim(0, 0, 4);
    },
    async headShake(tk) {
      for (let i = 0; i < 2; i++) { aim(-10, 2, 9); await wait(190, tk); aim(10, 2, 9); await wait(190, tk); }
      aim(0, 0, 4);
    },
    async endOfDay(tk) {
      say(pick(['Good work today. Wrap up soon?', 'Day is nearly done. Write down where you stopped?']), 8000);
      await A.wave(tk);
    }
  };
  // Holds something (coffee, water, a sandwich) in both paws for a few seconds.
  async function holdProp(tk, emoji, text, mood) {
    prefetch(['hold']);
    setLook(F('hold'), 380); aim(0, 7, 3); faceOverride = mood; applyFace();
    fx.insertAdjacentHTML('beforeend', `<span class="prop">${emoji}</span>`);
    const p = fx.lastElementChild;
    say(text, 6000);
    try { await wait(3200, tk); } finally { p.remove(); faceOverride = null; applyFace(); setLook(GAZE, 380); aim(0, 0, 3); }
  }
  function dots() {
    fx.insertAdjacentHTML('beforeend', '<span class="dots"><i></i><i></i><i></i></span>');
    const d = fx.lastElementChild; setTimeout(() => d.remove(), 2800);
  }
  async function standUp() {
    sitting = false; asleep = false; applyFace();
    el.classList.add('rise'); setTimeout(() => el.classList.remove('rise'), 520);
    setLook(GAZE, 420); aim(0, 0, 3);
  }
  // Things that happen once a day at the right time (coffee, lunch, end of the day).
  const daily = {};
  const onceToday = (k) => { const d = new Date().toDateString(); if (daily[k] === d) return false; daily[k] = d; return true; };
  function timely() {
    const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
    if (h >= 7.5 && h < 10 && onceToday('coffee')) return 'coffee';
    if (h >= 12.5 && h < 14 && onceToday('lunch')) return 'lunch';
    if (h >= 18 && h < 20 && d.getDay() % 6 && onceToday('eod')) return 'endOfDay';
    return null;
  }
  function schedule() {
    setTimeout(() => {
      if (!paused && !act && !sing.on && !asleep && !tracking && !(emote && Date.now() < emoteUntil)) {
        const d = new Date(), h = d.getHours(), night = h < 6 || h >= 23, friday = d.getDay() === 5 && h >= 15;
        const special = !focusMode && base.level === 'ok' && timely();
        const table = focusMode ? [['sit', 3], ['none', 7]]
          : base.level === 'bad' ? [['grumble', 4], ['lookAround', 4], ['shrug', 1]]
          : base.level === 'warn' ? [['shrug', 3], ['lookAround', 5], ['sit', 1], ['idea', 1], ['think', 1]]
          : space ? [['lookAround', 30], ['think', 8], ['idea', 6], ['point', 6], ['wave', 3], ['hum', 4], ['dance', 2], ['none', 25]]
          : [['lookAround', 30], ['sit', night ? 22 : 11], ['idea', 9], ['think', 5], ['turnAround', 5], ['wave', 5], ['stretch', night || h < 10 ? 10 : 5], ['hum', 6], ['hop', 6],
            ['dance', friday ? 8 : 2], ['peekaboo', 2], ['water', h >= 10 && h < 18 ? 3 : 0], ['none', 23]];
        if (special) { run(special, A[special]); schedule(); return; }
        let r = Math.random() * table.reduce((s, [, v]) => s + v, 0), choice = 'none';
        for (const [n, v] of table) { if ((r -= v) <= 0) { choice = n; break; } }
        if (choice !== 'none') run(choice, A[choice]);
      } else if (!paused && !asleep && !sing.on && Date.now() - lastActivity > (new Date().getHours() < 6 ? 120000 : 480000) && act?.name !== 'sit') {
        fallAsleep();
      }
      schedule();
    }, rand(6000, 13000));
  }
  // First name from the profile (USER lives in app.js, loaded after this file).
  const userName = () => (typeof USER === 'string' && USER) || '';
  function fallAsleep() {
    cancelAct(); asleep = true;
    prefetch(['sleep', 'sit_sleep']);
    setLook(sitting ? F('sit_sleep') : F('sleep'), 1100); aim(0, 6, 2);
    applyFace(); say(new Date().getHours() < 6 ? `Zzz… it's late${userName() ? `, ${userName()}` : ''}.` : 'Zzz…');
  }
  function wake() {
    if (!asleep) return;
    asleep = false;
    cancelAct();
    if (sitting) { sitting = false; el.classList.add('rise'); setTimeout(() => el.classList.remove('rise'), 520); }
    setLook(GAZE, 380);
    setEmote('surprised', 1200);
    burst('bang');
    say(pick(['Oh! Hi.', "I'm up, I'm up!", 'Welcome back.']), 4000);
    setTimeout(() => run('wave', A.wave), 900);
  }

  // ---------------------------------------------------------------- reactions
  function burst(kind) {
    if (kind === 'bang') { fx.insertAdjacentHTML('beforeend', '<span class="bang">!</span>'); const b = fx.lastElementChild; setTimeout(() => b.remove(), 1100); return; }
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + rand(-0.2, 0.2), d = rand(5, 8);
      const s = document.createElement('span');
      s.className = 'spark'; s.textContent = pick(['✦', '✧', '♥', '✦']);
      s.style.setProperty('--dx', `${(Math.cos(a) * d).toFixed(2)}rem`);
      s.style.setProperty('--dy', `${(Math.sin(a) * d - 2).toFixed(2)}rem`);
      fx.appendChild(s); setTimeout(() => s.remove(), 1100);
    }
  }
  function poke() {
    lastActivity = Date.now();
    if (asleep) { wake(); return; }
    if (sitting && act) { cancelAct(); standUp(); }
    const t = Date.now();
    pokes = pokes.filter((x) => t - x < 5000); pokes.push(t);
    once('squish', 350);
    if (pokes.length >= 5) {
      pokes = [];
      setEmote('angry', 4000); once('shake', 850);
      say(pick(['Hey! Stop poking me.', 'Okay, that is enough.', 'I bite, you know.']), 5000);
    } else {
      setEmote('giggle', 1200);
      say(pick(['Hehe!', 'That tickles.', userName() ? `Hi ${userName()}!` : 'Hi there!', 'Boop.', 'Need something?', 'At your service.']), 3500);
    }
  }
  function celebrate(text) {
    if (paused) return;
    lastActivity = Date.now(); if (asleep) wake();
    if (act) { cancelAct(); sitting = false; }
    setEmote('love', 1900);
    setLook(F('cheer'), 200); setTimeout(() => setLook(sing.on ? GAZE : GAZE, 400), 1200);
    once('hop', 750); burst('sparks'); say(text, 5000);
  }
  function notify(text) {
    if (paused) return;
    lastActivity = Date.now(); if (asleep) wake();
    setEmote('surprised', 1400); burst('bang'); lookAtEl('#focusList', 6); say(text, 6000);
  }
  function setBase(next) {
    const prev = base.level;
    base = { ...base, ...next };
    if (prev !== base.level) {
      if (base.level === 'bad') { if (asleep) wake(); run('grumble', A.grumble); }
      else if (prev === 'bad' && base.level === 'ok') celebrate('Phew. Everything is back up.');
      else if (base.level === 'warn') run('shrug', A.shrug);
    }
    applyFace();
  }

  // ---------------------------------------------------------------- singing
  // Fed by the main process' system audio meter (~12 readings/s). Starts after 1.2 s of sound,
  // stops after 2.5 s of silence. Calls and meetings never trigger it.
  const NO_SING = /^(ms-?teams|teams|zoom|skype|webex|discord|slack|lync)$/i;
  const sing = { on: false, raw: 0, env: 0, avg: 0.05, loudSince: 0, lastLoud: 0, app: '', title: '', lastNote: 0, lastBeat: 0, beatSide: 1, t0: 0, enabled: true };
  function cleanTitle(t, app) {
    if (!t) return '';
    t = t.replace(/\s*[-–—|]\s*(YouTube|Google Chrome|Microsoft​? Edge|Mozilla Firefox|Brave|Opera|Spotify( Premium| Free)?|VLC media player)\s*$/i, '')
      .replace(/\s*[-–—|]\s*(YouTube|Google Chrome|Microsoft​? Edge)\s*$/i, '').replace(/^\(\d+\)\s*/, '').trim();
    if (/^(spotify( premium| free)?|youtube|new tab|google chrome)$/i.test(t)) return '';
    return t.length > 46 ? t.slice(0, 44) + '…' : t;
  }
  function onAudio(a) {
    if (!sing.enabled) return;
    const t = Date.now();
    if (a.app && NO_SING.test(a.app)) { if (sing.on) stopSinging(); return; }
    sing.raw = a.p || 0;
    if (a.app) { sing.app = a.app; if (a.title) sing.title = a.title; }
    if (sing.raw > 0.015) { sing.lastLoud = t; if (!sing.loudSince) sing.loudSince = t; }
    else if (t - sing.lastLoud > 600) sing.loudSince = 0;
    if (!sing.on && sing.loudSince && t - sing.loudSince > 1200 && !paused) startSinging();
    if (sing.on && t - sing.lastLoud > 2500) stopSinging();
    if (sing.on) wakeLoop();
  }
  function startSinging() {
    prefetch(['sing_0', 'sing_1']);
    sing.on = true; sing.t0 = now(); sing.env = 0;
    lastActivity = Date.now();
    cancelAct();
    asleep = false; sitting = false;
    setLook(GAZE, 400); aim(0, -3, 4);
    el.classList.add('singing'); micEl.classList.add('on');
    applyFace();
    const title = cleanTitle(sing.title, sing.app);
    const app = /spotify/i.test(sing.app) ? 'Spotify' : '';
    say(title ? `♪ Singing along to ${title}` : app ? '♪ Ooh, Spotify! Mic check…' : pick(['♪ Ooh, I know this one!', '♪ Mic check… one, two…', '♪ La la la!']), 7000);
    wakeLoop();
  }
  function stopSinging() {
    if (!sing.on) return;
    sing.on = false; sing.loudSince = 0;
    el.classList.remove('singing'); micEl.classList.remove('on');
    setLook(GAZE, 400); aim(0, 7, 3); setTimeout(() => aim(0, 0, 3), 700);
    applyFace();
    say(pick(['Thank you, thank you!', 'Encore?', 'That was a good one.', 'Thank you, you have been great.']), 4000);
    setTimeout(() => { if (!sing.on && !act) run('bow', A.bow); }, 450);
  }
  function singTick(t, dt) {
    // Envelope: fast attack, slower release; avg tracks the song's typical level for beat detection.
    const target = clamp(sing.raw * 2.6, 0, 1);
    sing.env += (target - sing.env) * (target > sing.env ? Math.min(1, dt * 18) : Math.min(1, dt * 6));
    sing.avg += (sing.env - sing.avg) * Math.min(1, dt * 0.8);
    const s = (t - sing.t0) / 1000;
    // Sway with the music, a little nod on beats.
    head.ty = Math.sin(s * 2.1) * 9 + Math.sin(s * 0.7) * 3;
    head.tp = -4 + Math.sin(s * 4.2) * 2 - sing.env * 3;
    head.omega = 5;
    if (sing.env > sing.avg * 1.35 && sing.env > 0.25 && t - sing.lastBeat > 280) {
      sing.lastBeat = t; once('beat', 260);
      if (sing.env > 0.7 && Math.random() < 0.25) { setLook(F(sing.beatSide > 0 ? 'sing_1' : 'sing_0'), 140); sing.beatSide *= -1; setTimeout(() => sing.on && setLook(GAZE, 260), 420); }
    }
    if (sing.env > 0.18 && t - sing.lastNote > rand(550, 1300)) { sing.lastNote = t; notes(1); }
    // Mouth follows the sound.
    const m = parts.mouth.querySelector('.sm'), tg = parts.mouth.querySelector('.st');
    if (m) { m.setAttribute('ry', (1.6 + sing.env * 8.5).toFixed(2)); m.setAttribute('rx', (4.2 + sing.env * 2.4).toFixed(2)); }
    if (tg) { tg.setAttribute('cy', (1.2 + sing.env * 5).toFixed(2)); tg.setAttribute('opacity', sing.env > 0.25 ? 1 : 0); }
    const f = sing.env > 0.62 ? 'singLoud' : 'sing';
    if (!faceOverride && !(emote && Date.now() < emoteUntil) && FACES[f][0] !== shownFace.split('|')[0]) applyFace();
  }

  // ---------------------------------------------------------------- lifecycle
  function setPaused(p) {
    paused = p;
    document.body.classList.toggle('paused', p);
    if (!p) { lastActivity = Date.now(); fitCanvas(); dirty = true; wakeLoop(); }
  }
  function blinkLoop() {
    setTimeout(() => {
      if (!paused && !asleep && ['open', 'small', 'big', 'squint'].includes((FACES[moodFace()] || [])[0])) {
        blink(); if (Math.random() < 0.2) setTimeout(blink, 260);
      }
      blinkLoop();
    }, rand(2200, 5600));
  }

  el.addEventListener('click', poke);
  el.addEventListener('dblclick', () => { run('wave', A.wave); say('Hello there!', 3000); });
  window.addEventListener('resize', () => { fitCanvas(); dirty = true; wakeLoop(); });
  ready.then(() => {
    prefetch(['wave_0', 'wave_1', 'cheer', 'shrug']);
    fitCanvas(); applyFace(); dirty = true; wakeLoop();
    draw(); // starts decoding the first pose even when the desktop is covered
    setTimeout(() => run('wave', A.wave), 600);
  });
  blinkLoop(); pickMode(); schedule();

  window.Buddy = {
    setBase, onCursor, onAudio, celebrate, notify, say, setPaused, poke,
    setSinging: (on) => { sing.enabled = on; if (!on) stopSinging(); },
    // A short mood with a line (laptop vitals, battery...): happy, worried, sleepy, surprised.
    react: (mood, text) => {
      if (paused) return;
      lastActivity = Date.now(); if (asleep) wake();
      setEmote({ happy: 'giggle', worried: 'worried', sleepy: 'sleepy', surprised: 'surprised' }[mood] || mood, 2600);
      if (mood === 'worried') once('shake', 850); else if (mood === 'happy') once('hop', 750);
      say(text, 7000);
    },
    // Focus session: calm, quiet, maybe a little sit. No idle antics or rotating chatter.
    setFocus: (on) => {
      focusMode = !!on;
      if (on && act && act.name !== 'sit') { cancelAct(); setLook(GAZE, 300); }
    },
    run: (name, arg) => { if (A[name]) run(name, (tk) => A[name](tk, arg)); },
    // A space opened beside Cy (or closed: null). Cy gets up, faces it and points.
    setSpace: (name, line) => {
      const was = space; space = name || null;
      if (paused) return;
      lastActivity = Date.now();
      if (space) {
        if (asleep) { asleep = false; applyFace(); }
        cancelAct(); if (sitting) standUp();
        if (!was) once('hop', 750);
        setTimeout(() => { fitCanvas(); dirty = true; run('point', (tk) => A.point(tk, line)); }, was ? 80 : 620);
      } else if (was) {
        cancelAct(); setTimeout(() => { fitCanvas(); dirty = true; setLook(GAZE, 300); aim(0, 0, 3); wakeLoop(); }, 620);
        if (line) say(line, 3000);
      }
    },
    setHeadless: (on) => { headless = !!on; if (!on) { dirty = true; wakeLoop(); } else ctx.clearRect(0, 0, canvas.width, canvas.height); },
    relayout: () => { fitCanvas(); dirty = true; wakeLoop(); },
    ideaSource: null,
    get state() {
      return { emote: emote && Date.now() < emoteUntil ? emote : null, asleep, sitting, paused, base, mode, focus: focusMode, interest: +interest.toFixed(2),
        activity: act ? act.name : null, singing: sing.on, look: look.kind === 'frame' ? look.name : look.kind, space,
        yaw: +head.yaw.toFixed(1), pitch: +head.pitch.toFixed(1), face: moodFace(), headless };
    }
  };
})();
