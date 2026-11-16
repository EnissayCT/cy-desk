// Cy levels up with you: XP for finished tasks, focus minutes, commits, water, stretches and
// a mood check-in. Levels unlock things for Cy to wear. One JSON file in the data folder.
const fs = require('fs');
const path = require('path');
const FILE = require('./paths').file('xp.json');

// XP needed to go from level n to n+1 grows gently: 100, 140, 185, 235…
const need = (level) => Math.round(100 * Math.pow(level, 1.35));
const GAINS = { task: 20, focusMin: 1, commit: 4, water: 2, stretch: 5, mood: 3, agentDone: 5 };
const DAILY_CAP = { commit: 120, water: 16, stretch: 25, mood: 3, agentDone: 40 }; // so a busy repo or a click-fest can't farm
// What Cy can wear, and the level that unlocks it.
const ITEMS = [
  { id: 'scarf', level: 1, name: 'Scarf', slot: 'neck', builtin: true },
  { id: 'sunglasses', level: 2, name: 'Sunglasses', slot: 'eyes' },
  { id: 'party', level: 3, name: 'Party hat', slot: 'head' },
  { id: 'headphones', level: 4, name: 'Headphones', slot: 'ears' },
  { id: 'beanie', level: 5, name: 'Beanie', slot: 'head' },
  { id: 'bowtie', level: 6, name: 'Bow tie', slot: 'neck2' },
  { id: 'glasses', level: 7, name: 'Round glasses', slot: 'eyes' },
  { id: 'flower', level: 8, name: 'Flower', slot: 'head2' },
  { id: 'crown', level: 10, name: 'Crown', slot: 'head' },
  { id: 'wizard', level: 12, name: 'Wizard hat', slot: 'head' }
];

let data = null;
function load() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  if (!data || typeof data.xp !== 'number') data = { version: 1, xp: 0, level: 1, into: 0, equipped: {}, today: { day: '', counts: {} }, log: [] };
  return data;
}
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}
const dayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// Adds XP for `n` events of a kind; returns { gained, levelUp: [levels], unlocked: [items] } or null.
function grant(kind, n = 1, label = '') {
  const d = load();
  if (!GAINS[kind] || !(n > 0)) return null;
  if (d.today.day !== dayKey()) d.today = { day: dayKey(), counts: {} };
  let amount = GAINS[kind] * n;
  if (DAILY_CAP[kind] !== undefined) {
    const used = d.today.counts[kind] || 0;
    amount = Math.max(0, Math.min(amount, DAILY_CAP[kind] - used));
    d.today.counts[kind] = used + amount;
  }
  if (!amount) return null;
  d.xp += amount; d.into += amount;
  const levelUp = [], unlocked = [];
  while (d.into >= need(d.level)) {
    d.into -= need(d.level); d.level++;
    levelUp.push(d.level);
    for (const it of ITEMS) if (it.level === d.level) unlocked.push(it);
  }
  d.log.push({ at: Date.now(), kind, amount, label: String(label).slice(0, 80) });
  d.log = d.log.slice(-200);
  save();
  return { gained: amount, kind, levelUp, unlocked };
}

function equip(itemId, on) {
  const d = load();
  const it = ITEMS.find((x) => x.id === itemId);
  if (!it || it.level > d.level) return summary();
  for (const [slot, id] of Object.entries(d.equipped)) if (id === itemId || (on && slot === it.slot)) delete d.equipped[slot];
  if (on) d.equipped[it.slot] = itemId;
  save();
  return summary();
}

function summary() {
  const d = load();
  return { xp: d.xp, level: d.level, into: d.into, need: need(d.level), equipped: Object.values(d.equipped),
    items: ITEMS.map((it) => ({ ...it, unlocked: it.level <= d.level })), recent: d.log.slice(-8).reverse() };
}

module.exports = { FILE, grant, equip, summary, ITEMS, need };
