// Custom widgets: any number from a URL (JSON or text) or a command on this computer, refreshed on
// its own interval, with a short history for a sparkline. Defined in config.widgets:
//   { id, title, source: 'url' | 'command', url | command, path: 'data.items[0].count', unit, every: minutes }
const https = require('https');
const http = require('http');
const { exec } = require('child_process');

const state = {}; // id -> { ok, value, text, error, at, history: [[t, v]] }
const timers = {};

function pick(obj, p) {
  if (!p) return obj;
  let cur = obj;
  for (const part of String(p).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}
function get(url) {
  return new Promise((res, rej) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: 12000, headers: { 'User-Agent': 'CY-Desk widget', Accept: 'application/json, text/plain, */*' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); get(new URL(r.headers.location, url).href).then(res, rej); return; }
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (d) => { body += d; if (body.length > 2e6) req.destroy(new Error('response too large')); });
      r.on('end', () => (r.statusCode < 400 ? res(body) : rej(new Error(`HTTP ${r.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', rej);
  });
}
function run(cmd) {
  return new Promise((res, rej) => exec(cmd, { timeout: 15000, windowsHide: true, maxBuffer: 1 << 20 }, (e, out, err) => (e ? rej(new Error((err || e.message).trim().split('\n').pop())) : res(out))));
}

async function refresh(w) {
  const prev = state[w.id] || { history: [] };
  let raw;
  try {
    raw = w.source === 'command' ? await run(w.command) : await get(w.url);
    let val = raw.trim();
    try { val = pick(JSON.parse(raw), w.path); } catch { /* not JSON: the text itself */ }
    const num = typeof val === 'number' ? val : typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val.trim()) ? Number(val) : null;
    const text = num !== null ? null : typeof val === 'object' ? JSON.stringify(val).slice(0, 80) : String(val ?? '—').slice(0, 80);
    const history = num !== null ? prev.history.concat([[Date.now(), num]]).slice(-48) : prev.history;
    state[w.id] = { ok: true, value: num, text, at: Date.now(), history };
  } catch (e) {
    state[w.id] = { ...prev, ok: false, error: e.message.slice(0, 120), at: Date.now() };
  }
}

// (Re)starts the timers for the current config; onChange is called with the whole state after each refresh.
function start(config, onChange) {
  for (const t of Object.values(timers)) clearInterval(t);
  for (const k of Object.keys(timers)) delete timers[k];
  const list = (config.widgets || []).filter((w) => w && w.id && (w.url || w.command));
  for (const k of Object.keys(state)) if (!list.some((w) => w.id === k)) delete state[k];
  for (const w of list) {
    const tick = () => refresh(w).then(() => onChange({ ...state }));
    tick();
    timers[w.id] = setInterval(tick, Math.max(1, Number(w.every) || 5) * 60000);
  }
}

module.exports = { start, refresh, state, pick };
