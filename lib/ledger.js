// Money: a small personal ledger (income and expenses) plus recurring costs (subscriptions,
// servers, rent). One JSON file in the data folder; amounts are plain numbers in one currency.
const fs = require('fs');
const crypto = require('crypto');
const FILE = require('./paths').file('ledger.json');

const CATEGORIES = {
  out: ['Food', 'Transport', 'Housing', 'Bills', 'Software', 'Servers', 'Shopping', 'Health', 'Fun', 'Other'],
  in: ['Salary', 'Freelance', 'Sales', 'Refund', 'Other']
};

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(d.entries)) return { currency: 'USD', recurring: [], budget: 0, ...d };
  } catch {}
  return { version: 1, currency: defaultCurrency(), budget: 0, entries: [], recurring: [] };
}
function defaultCurrency() {
  const loc = Intl.DateTimeFormat().resolvedOptions().locale || '';
  const region = (loc.split('-')[1] || '').toUpperCase();
  return { MA: 'MAD', FR: 'EUR', DE: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', GB: 'GBP', CA: 'CAD', JP: 'JPY', IN: 'INR', CH: 'CHF', AU: 'AUD' }[region] || 'USD';
}
function save(d) {
  fs.mkdirSync(require('path').dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, FILE);
}
const id = (p) => p + crypto.randomBytes(4).toString('hex');
const amountOf = (v) => Math.round(Math.abs(Number(v) || 0) * 100) / 100;
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function add(e) {
  const d = load();
  const amount = amountOf(e.amount);
  if (!amount) return { ok: false, error: 'Enter an amount above zero' };
  const kind = e.kind === 'in' ? 'in' : 'out';
  const entry = { id: id('m_'), kind, amount, category: String(e.category || 'Other').slice(0, 30), note: String(e.note || '').slice(0, 120),
    date: isDay(e.date) ? e.date : new Date().toISOString().slice(0, 10), created: new Date().toISOString() };
  d.entries.push(entry);
  save(d);
  return { ok: true, entry, ledger: d };
}
function remove(entryId) {
  const d = load();
  d.entries = d.entries.filter((x) => x.id !== entryId);
  d.recurring = d.recurring.filter((x) => x.id !== entryId);
  save(d);
  return d;
}
function addRecurring(r) {
  const d = load();
  const amount = amountOf(r.amount);
  if (!amount || !String(r.name || '').trim()) return { ok: false, error: 'Give it a name and an amount' };
  d.recurring.push({ id: id('r_'), name: String(r.name).trim().slice(0, 40), amount, every: r.every === 'year' ? 'year' : 'month',
    day: Math.max(1, Math.min(28, Number(r.day) || 1)), category: String(r.category || 'Bills').slice(0, 30) });
  save(d);
  return { ok: true, ledger: d };
}
function setOptions(o) {
  const d = load();
  if (o.currency && /^[A-Z]{3}$/.test(o.currency)) d.currency = o.currency;
  if (o.budget !== undefined) d.budget = amountOf(o.budget);
  save(d);
  return d;
}

module.exports = { FILE, CATEGORIES, load, add, remove, addRecurring, setOptions };
