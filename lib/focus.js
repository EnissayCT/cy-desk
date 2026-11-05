// Focus sessions: a timed block on one task. Stored in data/focus.json; the page shows the
// timer, the main process ends the session (and notifies) even if the page reloads.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = require('./paths').file('focus.json');

function load() {
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (Array.isArray(d.sessions)) return d; } catch {}
  return { version: 1, sessions: [] };
}
function save(d) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, FILE);
}
const minutesOf = (s) => Math.max(0, Math.round(((s.end || Date.now()) - s.start) / 60000));

function active() {
  const s = load().sessions.find((x) => !x.end);
  return s ? { ...s, endsAt: s.start + s.planned * 60000 } : null;
}

function start({ todoId = null, item = null, text = '', minutes = 25 }) {
  const d = load();
  for (const s of d.sessions) if (!s.end) { s.end = Date.now(); s.completed = false; s.minutes = minutesOf(s); }
  const s = { id: 'f_' + crypto.randomBytes(4).toString('hex'), todoId, item, text: String(text).slice(0, 200), start: Date.now(), planned: Math.max(5, Math.min(180, minutes)), end: null, completed: false, minutes: 0 };
  d.sessions.push(s);
  d.sessions = d.sessions.slice(-2000);
  save(d);
  return { ...s, endsAt: s.start + s.planned * 60000 };
}

function stop(completed = false) {
  const d = load();
  const s = d.sessions.find((x) => !x.end);
  if (!s) return null;
  s.end = completed ? s.start + s.planned * 60000 : Date.now();
  s.completed = !!completed;
  s.minutes = minutesOf(s);
  save(d);
  return s;
}

function extend(minutes = 5) {
  const d = load();
  const s = d.sessions.find((x) => !x.end);
  if (!s) return null;
  s.planned = Math.min(240, s.planned + Math.max(1, Math.min(60, Number(minutes) || 5)));
  save(d);
  return { ...s, endsAt: s.start + s.planned * 60000 };
}

// Minutes focused per item since a time, plus the total.
function since(ts) {
  const per = {};
  let total = 0;
  for (const s of load().sessions) {
    if (s.start < ts) continue;
    const m = s.end ? s.minutes : minutesOf(s);
    per[s.item || 'other'] = (per[s.item || 'other'] || 0) + m;
    total += m;
  }
  return { per, total };
}

module.exports = { FILE, load, active, start, stop, extend, since };
