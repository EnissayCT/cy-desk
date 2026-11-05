// Shared to-do store: one JSON file read and written by the dashboard and by
// Claude sessions (through todo.js). Writes go through a temp file + rename so a
// reader never sees half a file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = require('./paths').file('todos.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(data.items)) return data;
  } catch {}
  return { version: 1, items: [] };
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, FILE); return; } catch (e) {
      // Windows refuses the rename while another process has the file open; retry briefly.
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function update(fn) {
  const data = load();
  const result = fn(data);
  save(data);
  return result;
}

function add({ item, text, focus = false, by = 'me' }) {
  return update((d) => {
    const t = {
      id: 't_' + crypto.randomBytes(4).toString('hex'),
      item, text: String(text).trim().slice(0, 300),
      done: false, focus: !!focus, by,
      created: new Date().toISOString(), doneAt: null
    };
    d.items.push(t);
    return t;
  });
}

function patch(id, changes) {
  return update((d) => {
    const t = d.items.find((x) => x.id === id);
    if (!t) return null;
    for (const k of ['text', 'done', 'focus', 'item']) if (k in changes) t[k] = changes[k];
    if ('done' in changes) t.doneAt = changes.done ? new Date().toISOString() : null;
    if (changes.done) t.focus = false;
    return t;
  });
}

function remove(id) {
  return update((d) => {
    const n = d.items.length;
    d.items = d.items.filter((x) => x.id !== id);
    return d.items.length !== n;
  });
}

function move(id, toIndexAmongItem) {
  return update((d) => {
    const t = d.items.find((x) => x.id === id);
    if (!t) return false;
    const siblings = d.items.filter((x) => x.item === t.item && x.id !== id);
    const rest = d.items.filter((x) => x.item !== t.item);
    siblings.splice(Math.max(0, Math.min(toIndexAmongItem, siblings.length)), 0, t);
    d.items = [...rest, ...siblings];
    return true;
  });
}

module.exports = { FILE, load, add, patch, remove, move };
