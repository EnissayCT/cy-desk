// Health: how you are doing at the computer. Screen time and breaks are measured from input
// idle time (no camera, no keylogging: only "was there input in the last minute"); water, mood
// and stretches are logged by you. One JSON file in the data folder, a day per key.
const fs = require('fs');
const path = require('path');
const FILE = require('./paths').file('health.json');

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const blank = () => ({ activeMin: 0, breaks: 0, longest: 0, water: 0, stretches: 0, mood: null, firstAt: null, lastAt: null });

let data = null, dirty = false;
function load() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  if (!data || typeof data.days !== 'object') data = { version: 1, goals: { water: 8, activeMax: 480, bedtime: '23:30' }, days: {} };
  data.goals = { water: 8, activeMax: 480, bedtime: '23:30', ...(data.goals || {}) };
  return data;
}
function save() {
  if (!data) return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
  dirty = false;
}
function today() { const d = load(); const k = dayKey(); return (d.days[k] = { ...blank(), ...(d.days[k] || {}) }); }

// Called every few seconds by the main process with the system idle time.
let stretch = 0, onBreak = false, lastTick = 0;
function tick(idleSeconds, now = Date.now()) {
  const dt = lastTick ? Math.min(60, (now - lastTick) / 1000) : 0;
  lastTick = now;
  const t = today();
  if (idleSeconds < 60) {
    t.activeMin = Math.round((t.activeMin + dt / 60) * 100) / 100;
    stretch += dt / 60;
    t.longest = Math.max(t.longest, Math.round(stretch));
    t.firstAt = t.firstAt || now; t.lastAt = now;
    onBreak = false;
  } else if (idleSeconds >= 300 && !onBreak) {
    onBreak = true; stretch = 0; t.breaks++;
  }
  dirty = true;
}
setInterval(() => { if (dirty) { try { save(); } catch {} } }, 60000).unref();

function log(what, value) {
  const t = today();
  if (what === 'water') t.water = Math.max(0, t.water + (value === -1 ? -1 : 1));
  else if (what === 'stretch') t.stretches++;
  else if (what === 'mood' && [1, 2, 3, 4, 5].includes(value)) t.mood = value;
  save();
  return summary();
}
function setGoals(g) {
  const d = load();
  if (g.water) d.goals.water = Math.max(1, Math.min(20, Number(g.water)));
  if (g.bedtime && /^\d{2}:\d{2}$/.test(g.bedtime)) d.goals.bedtime = g.bedtime;
  if (g.activeMax) d.goals.activeMax = Math.max(60, Math.min(960, Number(g.activeMax)));
  save();
  return summary();
}
function summary(days = 14) {
  const d = load();
  today();
  const out = [];
  for (let i = days - 1; i >= 0; i--) { const k = dayKey(new Date(Date.now() - i * 86400000)); out.push({ day: k, ...blank(), ...(d.days[k] || {}) }); }
  return { goals: d.goals, today: out[out.length - 1], days: out, stretchMin: Math.round(stretch) };
}
function flush() { if (dirty) save(); }

module.exports = { FILE, tick, log, setGoals, summary, flush, dayKey };
