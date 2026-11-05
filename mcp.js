#!/usr/bin/env node
// CY Desk as an MCP server (stdio), so Claude Code sessions can read and add to-dos, check the
// servers, and log an expense. Connect it from Settings > Claude, or by hand:
//   claude mcp add --scope user cy-desk -- node /path/to/cy-desk/mcp.js
// No dependencies: newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs go to stderr.
const fs = require('fs');
const paths = require('./lib/paths');
const todos = require('./lib/todos');

const VERSION = (() => { try { return require('./package.json').version; } catch { return '1'; } })();
function config() {
  try { return JSON.parse(fs.readFileSync(paths.CONFIG_FILE, 'utf8')); } catch { return { groups: [], servers: {}, sites: [] }; }
}
function projects() {
  const out = [];
  for (const g of config().groups || []) for (const i of g.items || []) out.push({ id: i.id, name: i.name, group: g.name });
  return out;
}
function resolveProject(q) {
  const list = projects();
  if (!q) throw new Error('project is required: one of ' + list.map((p) => p.id).join(', '));
  const s = String(q).toLowerCase();
  const hit = list.find((p) => p.id === s) || list.find((p) => p.name.toLowerCase() === s) ||
    list.find((p) => p.id.startsWith(s) || p.name.toLowerCase().includes(s));
  if (!hit) throw new Error(`Unknown project "${q}". Projects: ${list.map((p) => `${p.id} (${p.name})`).join(', ')}`);
  return hit;
}

const TOOLS = [
  { name: 'cy_list_projects', description: 'List the projects on the CY Desk dashboard (id, name, group). Use an id when adding a to-do.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'cy_list_todos', description: 'List open to-dos on the dashboard, for one project or all. Check before adding, to avoid duplicates.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project id or name (optional)' }, include_done: { type: 'boolean' } } } },
  { name: 'cy_add_todo', description: "Add a to-do to a project on the user's desktop dashboard. Only for what matters to them: a blocker, a release step, a decision waiting on them, a real risk, an unfinished follow-up. Never secrets.",
    inputSchema: { type: 'object', required: ['project', 'text'], properties: {
      project: { type: 'string', description: 'Project id or name (see cy_list_projects)' },
      text: { type: 'string', description: 'Short task, under 120 characters' },
      focus: { type: 'boolean', description: "Pin it to today's focus (only if it is urgent)" },
      by: { type: 'string', description: 'Your session name, shown next to the task' } } } },
  { name: 'cy_complete_todo', description: 'Tick a to-do as done, by its id or a fragment of its text.',
    inputSchema: { type: 'object', required: ['todo'], properties: { todo: { type: 'string', description: 'To-do id (t_...) or text fragment' } } } },
  { name: 'cy_status', description: 'Health of the servers and websites the dashboard watches (last check).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'cy_add_expense', description: "Log an expense or income in the user's CY Desk money ledger, when they ask you to.",
    inputSchema: { type: 'object', required: ['amount'], properties: {
      amount: { type: 'number' }, kind: { type: 'string', enum: ['out', 'in'] }, category: { type: 'string' }, note: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD, default today' } } } }
];

function call(name, a = {}) {
  if (name === 'cy_list_projects') {
    const open = todos.load().items.filter((t) => !t.done);
    return projects().map((p) => `${p.id}\t${p.name}\t(${p.group})\t${open.filter((t) => t.item === p.id).length} open`).join('\n') || 'No projects yet: add some in CY Desk settings.';
  }
  if (name === 'cy_list_todos') {
    const pid = a.project ? resolveProject(a.project).id : null;
    const names = Object.fromEntries(projects().map((p) => [p.id, p.name]));
    const list = todos.load().items.filter((t) => (a.include_done || !t.done) && (!pid || t.item === pid));
    return list.map((t) => `${t.id}\t${t.done ? '[x]' : t.focus ? '[*]' : '[ ]'} ${t.text}\t(${names[t.item] || t.item})`).join('\n') || 'No open to-dos.';
  }
  if (name === 'cy_add_todo') {
    const p = resolveProject(a.project);
    const text = String(a.text || '').trim();
    if (!text) throw new Error('text is required');
    const dup = todos.load().items.find((t) => !t.done && t.item === p.id && t.text.toLowerCase() === text.toLowerCase());
    if (dup) return `Already on the list: ${dup.id} ${dup.text}`;
    const t = todos.add({ item: p.id, text, focus: !!a.focus, by: `agent:${String(a.by || 'Claude').slice(0, 60)}` });
    return `Added ${t.id} to ${p.name}: ${t.text}`;
  }
  if (name === 'cy_complete_todo') {
    const q = String(a.todo || '').toLowerCase();
    const open = todos.load().items.filter((t) => !t.done);
    const hits = open.filter((t) => t.id === q || t.text.toLowerCase().includes(q));
    if (!q || !hits.length) throw new Error('No open to-do matches that.');
    if (hits.length > 1 && !hits.some((t) => t.id === q)) throw new Error(`Several match: ${hits.slice(0, 5).map((t) => `${t.id} ${t.text}`).join(' | ')}`);
    const t = hits.find((x) => x.id === q) || hits[0];
    todos.patch(t.id, { done: true });
    return `Done: ${t.text}`;
  }
  if (name === 'cy_status') {
    let st = {};
    try { st = JSON.parse(fs.readFileSync(paths.file('state.json'), 'utf8')); } catch {}
    const c = config();
    const lines = [];
    for (const [id, s] of Object.entries(c.servers || {})) {
      const r = (st.servers || {})[id];
      lines.push(`${s.name || id}: ${!r ? 'not checked yet' : r.ok ? 'up' : `unreachable (${r.error || 'error'})`}`);
    }
    for (const s of c.sites || []) {
      const r = (st.sites || {})[s.id];
      lines.push(`${s.host}: ${!r ? 'not checked yet' : r.ok ? `up, ${r.ms} ms` : `down (${r.error || r.code})`}`);
    }
    if (st.refreshedAt) lines.push(`Last check: ${new Date(st.refreshedAt).toLocaleString()}`);
    return lines.join('\n') || 'No servers or sites configured.';
  }
  if (name === 'cy_add_expense') {
    const r = require('./lib/ledger').add(a);
    if (!r.ok) throw new Error(r.error);
    return `Logged ${r.entry.kind === 'in' ? 'income' : 'expense'} of ${r.entry.amount} ${r.ledger.currency} (${r.entry.category}) on ${r.entry.date}.`;
  }
  throw new Error(`Unknown tool ${name}`);
}

function reply(id, result, error) {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }) + '\n');
}
function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications (initialized, cancelled)
  if (method === 'initialize') {
    return reply(id, { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'cy-desk', version: VERSION },
      instructions: 'CY Desk is the user\'s desktop dashboard. Use cy_add_todo only for important follow-ups; never secrets.' });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try { return reply(id, { content: [{ type: 'text', text: call(params.name, params.arguments || {}) }] }); }
    catch (e) { return reply(id, { content: [{ type: 'text', text: e.message }], isError: true }); }
  }
  reply(id, null, { code: -32601, message: `Method not found: ${method}` });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (e) { process.stderr.write(`cy-desk mcp: ${e.message}\n`); }
  }
});
process.stdin.on('end', () => process.exit(0));
