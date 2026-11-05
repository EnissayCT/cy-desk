// Claude agents board: reads Claude Code session transcripts (~/.claude/projects/*/*.jsonl)
// and tells, for each recent session, whether it is working, waiting for an answer, done,
// blocked (a pending tool call, usually a permission prompt) or stopped. Read-only, local.
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const MAP_FILE = require('./paths').file('claude-sessions.json');
const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

function loadMap() {
  try {
    const m = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')).sessions || [];
    const byKey = new Map(), byTitle = new Map();
    for (const [title, cwd, id] of m) {
      const k = `${title.toLowerCase()}|${norm(cwd)}`;
      if (!byKey.has(k)) byKey.set(k, id);
      if (!byTitle.has(title.toLowerCase())) byTitle.set(title.toLowerCase(), id);
    }
    return { byKey, byTitle };
  } catch { return { byKey: new Map(), byTitle: new Map() }; }
}

function readTail(file, size, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const s = buf.toString('utf8');
    return size > bytes ? s.slice(s.indexOf('\n') + 1) : s;
  } finally { fs.closeSync(fd); }
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '');
const clean = (t) => String(t || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
const isPrompt = (d) => d.type === 'user' && !d.isMeta && d.message && (typeof d.message.content === 'string' ||
  (Array.isArray(d.message.content) && d.message.content.some((c) => c.type === 'text') && !d.message.content.some((c) => c.type === 'tool_result')));

function parse(file, st) {
  const lines = readTail(file, st.size, 256 * 1024).split('\n');
  let title = '', cwd = '', lastTs = 0, sessionId = path.basename(file, '.jsonl');
  const events = [];
  for (const line of lines) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'custom-title' && d.customTitle) title = d.customTitle;
    else if (d.type === 'agent-name' && d.agentName && !title) title = d.agentName;
    if (d.cwd) cwd = d.cwd;
    if ((d.type === 'user' || d.type === 'assistant') && !d.isSidechain) { events.push(d); if (d.timestamp) lastTs = Date.parse(d.timestamp) || lastTs; }
  }
  if (!events.length) return null;
  // The current (or last) turn: everything after the last real prompt.
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) if (isPrompt(events[i])) { start = i; break; }
  const turn = events.slice(start);
  const prompt = clean(textOf(turn[0].message && turn[0].message.content)).slice(0, 140);
  let ask = '', recap = '', lastText = '', pendingTool = null, answered = new Set();
  for (const d of turn) {
    const c = d.message && d.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === 'tool_result') answered.add(b.tool_use_id);
      if (b.type === 'text' && d.type === 'assistant' && b.text.trim()) lastText = b.text;
      if (b.type === 'tool_use') {
        pendingTool = { id: b.id, name: b.name };
        if (/wrap_up$/.test(b.name) && b.input) { recap = b.input.recap || recap; ask = b.input.ask || ''; }
        if (b.name === 'AskUserQuestion' && b.input && b.input.questions && b.input.questions[0]) ask = b.input.questions[0].question;
      }
    }
  }
  if (pendingTool && answered.has(pendingTool.id)) pendingTool = null;
  const last = events[events.length - 1];
  const lastIsAssistant = last.type === 'assistant';
  const stop = lastIsAssistant && last.message ? last.message.stop_reason : null;
  const idle = Date.now() - st.mtimeMs;
  let status;
  if (idle < 25000) status = 'working';
  else if (pendingTool && pendingTool.name === 'AskUserQuestion') status = 'question';
  else if (lastIsAssistant && stop === 'tool_use' && pendingTool) status = idle < 20 * 60000 ? 'blocked' : 'stopped';
  else if (lastIsAssistant && (stop === 'end_turn' || stop === 'stop_sequence' || !stop)) {
    const tail = clean(lastText).slice(-260);
    status = ask || /\?\s*$/.test(tail) ? 'question' : 'done';
  } else status = idle < 3 * 60000 ? 'working' : 'stopped';
  const preview = clean(status === 'question' && ask ? ask : recap || lastText || prompt).slice(0, 170);
  return {
    sessionId, file, title: title || prompt.slice(0, 60) || sessionId.slice(0, 8), cwd, status, preview,
    prompt, lastAt: lastTs || st.mtimeMs, tool: status === 'blocked' && pendingTool ? pendingTool.name : null
  };
}

const RANK = { question: 0, blocked: 1, working: 2, done: 3, stopped: 4 };

function scan(config, { days = 3, limit = 16 } = {}) {
  const since = Date.now() - days * 86400000;
  const map = loadMap();
  // A session belongs to the project that names it (config `session`), else to the project or
  // group whose folder it runs in (several Odoo modules share one repo: those map to the group).
  const projects = [], bySession = new Map();
  for (const g of (config && config.groups) || []) {
    if (g.repo) projects.push({ dir: norm(g.repo), name: g.short || g.name.split(' · ').pop(), id: null });
    for (const it of g.items) {
      if (it.session) bySession.set(it.session, it);
      const dir = it.repo || it.folder;
      if (dir) projects.push({ dir: norm(dir), name: it.name, id: it.id });
    }
  }
  projects.sort((a, b) => b.dir.length - a.dir.length);
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT); } catch { return []; }
  for (const dir of dirs) {
    const full = path.join(ROOT, dir);
    let files;
    try { files = fs.readdirSync(full); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(full, f);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs < since || st.size < 200) continue;
      let s;
      try { s = parse(p, st); } catch { s = null; }
      if (!s || s.lastAt < since) continue; // the app touches old files; go by the last message
      const cwd = norm(s.cwd);
      s.localId = map.byKey.get(`${s.title.toLowerCase()}|${cwd}`) || map.byTitle.get(s.title.toLowerCase()) || null;
      const owner = s.localId && bySession.get(s.localId);
      const proj = projects.find((x) => cwd === x.dir || cwd.startsWith(x.dir + '\\') || cwd.startsWith(x.dir + '/'));
      s.project = owner ? owner.name : proj ? proj.name : path.basename(s.cwd || dir);
      s.item = owner ? owner.id : proj ? proj.id : null;
      out.push(s);
    }
  }
  out.sort((a, b) => (RANK[a.status] - RANK[b.status]) || (b.lastAt - a.lastAt));
  return out.slice(0, limit).map(({ file, ...rest }) => rest);
}

module.exports = { scan, ROOT };
