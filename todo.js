#!/usr/bin/env node
// CY Desk to-do CLI, for Claude sessions and for the terminal.
//   node todo.js items                       list valid item ids (projects / modules)
//   node todo.js list [item] [--all]         open to-dos (all items, or one)
//   node todo.js add <item> "text" [--focus] [--by "<session name>"]
//   node todo.js done <id | text fragment>   tick a to-do
//   node todo.js undo <id>                   reopen
//   node todo.js focus <id> [off]            pin to / unpin from today's Focus
//   node todo.js edit <id> "new text"
//   node todo.js rm <id>
// The dashboard picks changes up within a second.
const path = require('path');
const store = require('./lib/todos');
let config;
try { config = JSON.parse(require('fs').readFileSync(require('./lib/paths').CONFIG_FILE, 'utf8')); } catch { console.error('No config.json yet: start CY Desk once (npm start) to create it.'); process.exit(1); }

const items = [];
for (const g of config.groups) for (const i of g.items) items.push({ group: g.name, id: i.id, name: i.name });

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : true; };
const by = flag('--by');
const focus = !!flag('--focus');
const all = !!flag('--all');
const [cmd, a, b] = argv;

function die(msg) { console.error(msg); process.exit(1); }
function resolveItem(q) {
  if (!q) die(`Missing item id. Run: node "${__filename}" items`);
  const s = q.toLowerCase();
  const hit = items.find((i) => i.id === s) || items.find((i) => i.name.toLowerCase() === s) ||
    items.find((i) => i.id.startsWith(s) || i.name.toLowerCase().includes(s));
  if (!hit) die(`Unknown item "${q}". Run: node "${__filename}" items`);
  return hit.id;
}
function resolveTodo(q) {
  const list = store.load().items;
  const t = list.find((x) => x.id === q) || list.filter((x) => !x.done && x.text.toLowerCase().includes(String(q).toLowerCase()));
  if (Array.isArray(t)) {
    if (t.length === 1) return t[0];
    die(t.length ? `Ambiguous, matches:\n${t.map(fmt).join('\n')}` : `No open to-do matches "${q}"`);
  }
  if (!t) die(`No to-do "${q}"`);
  return t;
}
function fmt(t) {
  return `${t.id}  ${t.done ? '[x]' : t.focus ? '[*]' : '[ ]'} ${t.item.padEnd(13)} ${t.text}`;
}

switch (cmd) {
  case 'items':
    for (const i of items) console.log(`${i.id.padEnd(14)} ${i.name}  (${i.group})`);
    break;
  case 'list':
  case undefined: {
    const id = a ? resolveItem(a) : null;
    const list = store.load().items.filter((t) => (all || !t.done) && (!id || t.item === id));
    console.log(list.length ? list.map(fmt).join('\n') : 'Nothing open.');
    break;
  }
  case 'add':
    if (!b) die('Usage: add <item> "text"');
    console.log('Added ' + fmt(store.add({ item: resolveItem(a), text: b, focus, by: by ? `agent:${by}` : 'cli' })));
    break;
  case 'done':
    console.log('Done  ' + fmt(store.patch(resolveTodo(a).id, { done: true })));
    break;
  case 'undo':
    console.log('Open  ' + fmt(store.patch(resolveTodo(a).id, { done: false })));
    break;
  case 'focus':
    console.log(fmt(store.patch(resolveTodo(a).id, { focus: b !== 'off' })));
    break;
  case 'edit':
    console.log(fmt(store.patch(resolveTodo(a).id, { text: b })));
    break;
  case 'rm':
    store.remove(resolveTodo(a).id); console.log('Removed');
    break;
  default:
    die(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
