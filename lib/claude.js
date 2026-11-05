// Claude Code on this computer: where it keeps its data, token usage read from the session
// transcripts, the git repos you work in with it, and the one-click connection (MCP server +
// a short note in your CLAUDE.md). Read-only except for the two connect actions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const platform = require('./platform');

const HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS = path.join(HOME, 'projects');
const CLAUDE_MD = path.join(HOME, 'CLAUDE.md');
const MARK_START = '<!-- cy-desk:start -->', MARK_END = '<!-- cy-desk:end -->';

const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function listTranscripts(sinceMs) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return out; }
  for (const d of dirs) {
    const full = path.join(PROJECTS, d);
    let files = [];
    try { files = fs.readdirSync(full); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(full, f);
      try { const st = fs.statSync(p); if (st.mtimeMs >= sinceMs) out.push({ p, dir: d, st }); } catch {}
    }
  }
  return out;
}

// ---------------------------------------------------------------- usage
// Per transcript: messages and tokens per day, model and folder. Assistant messages repeat
// their usage on every content block, so they are counted once per message id.
// Transcripts reach hundreds of MB (pasted images, tool output), so they are streamed in 1 MB
// chunks, only from where the last read stopped, and lines that can't matter (tool results,
// attachments) are skipped before JSON.parse. Memory stays at a few MB whatever the file size.
const cache = new Map();
const CHUNK = 1 << 20;
function* lines(p, from) {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let pos = from, rest = Buffer.alloc(0), n;
    while ((n = fs.readSync(fd, buf, 0, CHUNK, pos)) > 0) {
      pos += n;
      let data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0, i;
      while ((i = data.indexOf(10, start)) >= 0) { yield [data.subarray(start, i), pos - data.length + i + 1]; start = i + 1; }
      rest = Buffer.from(data.subarray(start));
      // A single giant line (a pasted image) is dropped rather than buffered.
      if (rest.length > 32 * CHUNK) rest = Buffer.alloc(0);
    }
  } finally { fs.closeSync(fd); }
}
function parseUsage(p, st) {
  let c = cache.get(p);
  if (c && c.size === st.size) return c.r;
  if (!c || st.size < c.size) c = { size: 0, offset: 0, seen: new Set(), r: { days: {}, cwd: '', title: '', prompts: 0 } };
  const r = c.r, seen = c.seen;
  let offset = c.offset;
  try { for (const [raw, end] of lines(p, c.offset)) { offset = end; take(raw); } } catch {}
  c.size = st.size; c.offset = offset;
  cache.set(p, c);
  return r;
  function take(raw) {
    if (raw.length < 20) return;
    // Cheap filters on the bytes first: only assistant usage, real prompts, titles.
    const head = raw.subarray(0, 1500).toString('latin1');
    const isAsst = head.includes('"type":"assistant"') || raw.includes('"usage"');
    if (!isAsst && !head.includes('"type":"user"') && !head.includes('custom-title')) return;
    if (!isAsst && raw.includes('"tool_result"')) return;
    if (raw.length > 4 * CHUNK) return;
    let d;
    try { d = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (d.cwd) r.cwd = d.cwd;
    if (d.type === 'custom-title' && d.customTitle) r.title = d.customTitle;
    const ts = d.timestamp ? Date.parse(d.timestamp) : 0;
    if (!ts) return;
    const day = (r.days[dayOf(ts)] = r.days[dayOf(ts)] || { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, msgs: 0, prompts: 0, models: {} });
    if (d.type === 'user' && !d.isMeta && !d.isSidechain && d.message && (typeof d.message.content === 'string' ||
      (Array.isArray(d.message.content) && d.message.content.some((x) => x.type === 'text') && !d.message.content.some((x) => x.type === 'tool_result')))) { day.prompts++; r.prompts++; }
    const m = d.type === 'assistant' && d.message;
    if (!m || !m.usage) return;
    const id = m.id || d.uuid;
    if (seen.has(id)) return;
    seen.add(id);
    const u = m.usage;
    day.in += u.input_tokens || 0; day.out += u.output_tokens || 0;
    day.cacheRead += u.cache_read_input_tokens || 0; day.cacheWrite += u.cache_creation_input_tokens || 0;
    day.msgs++;
    if (m.model && m.model !== '<synthetic>') day.models[m.model] = (day.models[m.model] || 0) + (u.output_tokens || 0) + (u.input_tokens || 0);
  }
}

// Totals per day over `days` days, plus models and the folders worked in.
function usage({ days = 14 } = {}) {
  const since = Date.now() - days * 86400000;
  const perDay = {}, models = {}, folders = {};
  let sessions = 0;
  for (const { p, st } of listTranscripts(since)) {
    const r = parseUsage(p, st);
    let used = false;
    for (const [day, v] of Object.entries(r.days)) {
      if (Date.parse(day) < since - 86400000) continue;
      used = true;
      const t = (perDay[day] = perDay[day] || { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, msgs: 0, prompts: 0 });
      for (const k of ['in', 'out', 'cacheRead', 'cacheWrite', 'msgs', 'prompts']) t[k] += v[k];
      for (const [m, n] of Object.entries(v.models)) models[m] = (models[m] || 0) + n;
      if (r.cwd) folders[r.cwd] = (folders[r.cwd] || 0) + v.prompts;
    }
    if (used) sessions++;
  }
  return { perDay, models, folders, sessions, days, at: Date.now() };
}

// ---------------------------------------------------------------- repos you work in with Claude
// The git root of each recent session's folder (newest transcript per project folder).
function repos({ days = 120 } = {}) {
  const since = Date.now() - days * 86400000;
  const newest = new Map();
  for (const t of listTranscripts(since)) { const n = newest.get(t.dir); if (!n || n.st.mtimeMs < t.st.mtimeMs) newest.set(t.dir, t); }
  const roots = new Set();
  for (const { p, st } of newest.values()) {
    let cwd = '';
    try {
      const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(Math.min(st.size, 64 * 1024)); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      const m = buf.toString('utf8').match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) cwd = JSON.parse(`"${m[1]}"`);
    } catch {}
    const root = cwd && fs.existsSync(cwd) && require('./collectors').gitRoot(cwd);
    if (root) roots.add(root);
  }
  return [...roots];
}

// ---------------------------------------------------------------- connection
const run = (cmd, args, timeout = 20000) => new Promise((res) => {
  execFile(cmd, args, { timeout, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout, stderr) => res({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
});

function claudeJson() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); } catch { return null; }
}

async function status() {
  const bin = platform.which('claude');
  let version = null;
  if (bin) { const r = await run('claude', ['--version'], 8000); if (r.ok) version = r.out.trim().split(/\s+/)[0]; }
  const cj = claudeJson();
  const mcp = !!(cj && cj.mcpServers && cj.mcpServers['cy-desk']);
  let md = false;
  try { md = fs.readFileSync(CLAUDE_MD, 'utf8').includes(MARK_START); } catch {}
  return { installed: !!bin, version, home: HOME, transcripts: fs.existsSync(PROJECTS), mcp, claudeMd: md, mdPath: CLAUDE_MD };
}

// Registers mcp.js with Claude Code (user scope), run by this same Electron binary in Node mode.
async function connectMcp(appDir) {
  const script = path.join(appDir.replace('app.asar', 'app.asar.unpacked'), 'mcp.js');
  await run('claude', ['mcp', 'remove', '--scope', 'user', 'cy-desk'], 15000);
  const args = ['mcp', 'add', '--scope', 'user', '-e', 'ELECTRON_RUN_AS_NODE=1'];
  if (process.env.CY_DATA_DIR) args.push('-e', `CY_DATA_DIR=${process.env.CY_DATA_DIR}`);
  args.push('cy-desk', '--', process.execPath, script);
  const quote = (a) => (process.platform === 'win32' && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const r = await run('claude', args.map(quote), 30000);
  return r.ok ? { ok: true } : { ok: false, error: (r.err || r.out).trim().split('\n').pop() || 'claude mcp add failed' };
}

const NOTE = `${MARK_START}
## CY Desk (desktop dashboard)
The cy-desk MCP tools put to-dos on the user's desktop dashboard. Add a to-do only for what matters
to them: a blocker, a release or deploy step still to do, a decision waiting on them, a real risk,
a follow-up you leave unfinished. Not routine sub-steps, not things you finish in the same turn,
never secrets. Check the list first (cy_list_todos) so you don't add duplicates; tick what you
finish (cy_complete_todo).
${MARK_END}`;

function writeClaudeMd(on) {
  let text = '';
  try { text = fs.readFileSync(CLAUDE_MD, 'utf8'); } catch {}
  const re = new RegExp(`\\n*${MARK_START}[\\s\\S]*?${MARK_END}\\n?`, 'g');
  text = text.replace(re, '\n');
  if (on) text = `${text.replace(/\s*$/, '')}\n\n${NOTE}\n`;
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CLAUDE_MD, text.replace(/^\n+/, ''));
  return true;
}

module.exports = { HOME, PROJECTS, usage, repos, status, connectMcp, writeClaudeMd, NOTE };
