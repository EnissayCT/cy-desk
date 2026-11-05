// Daily brief: what happened on the last working day (commits per project, tasks done,
// focus time) and what's on today, plus a standup text ready to paste.
const { execFile } = require('child_process');
const fs = require('fs');

function git(cwd, args) {
  return new Promise((res) => execFile('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 4 << 20 }, (e, out) => res(e ? '' : out)));
}

// Start of the last working day before today (Monday looks back to Friday).
function lastWorkday(now = new Date()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const back = d.getDay() === 1 ? 3 : d.getDay() === 0 ? 2 : 1;
  const from = new Date(d); from.setDate(from.getDate() - back);
  return { from, to: d, label: back === 1 ? 'Yesterday' : back === 3 ? 'Since Friday' : 'Since Friday' };
}

async function commitsPerProject(config, from, to) {
  const out = [];
  const range = ['--since', from.toISOString(), '--until', to.toISOString(), '--format=%s', '--no-merges'];
  for (const g of config.groups || []) {
    for (const it of g.items) {
      let lines = '';
      if (it.repo && fs.existsSync(it.repo)) lines = await git(it.repo, ['log', ...range]);
      else if (g.repo && it.paths && it.paths.length && fs.existsSync(g.repo)) lines = await git(g.repo, ['log', ...range, '--', ...it.paths]);
      const subjects = lines.trim().split('\n').filter(Boolean);
      if (subjects.length) out.push({ item: it.id, project: it.name, group: g.name, n: subjects.length, subjects: subjects.map(short) });
    }
  }
  // One commit can touch several modules: show each project the commit most specific to it.
  const seen = {};
  for (const c of out) for (const s of c.subjects) seen[s] = (seen[s] || 0) + 1;
  for (const c of out) c.subjects = [...c.subjects].sort((a, b) => seen[a] - seen[b]).slice(0, 4);
  return out.sort((a, b) => b.n - a.n);
}

function short(s) {
  // "fix: pointages fiabilisés (hr_employee_shift 16.0.1.55.4, …) - long details" -> "fix: pointages fiabilisés"
  const head = s.split(/\s[-–]\s|\s\|\s/)[0].replace(/\s*\([^)]*\)/g, '').trim();
  return head.length > 90 ? head.slice(0, 88) + '…' : head;
}

async function build({ config, todos, focus, agents = [], alerts = [], user = '' }) {
  const { from, to, label } = lastWorkday();
  const commits = await commitsPerProject(config, from, to);
  const done = todos.items.filter((t) => t.done && t.doneAt && Date.parse(t.doneAt) >= +from && Date.parse(t.doneAt) < +to);
  const focusPast = focus.since(+from);
  const pinned = todos.items.filter((t) => !t.done && t.focus);
  const waiting = agents.filter((a) => a.status === 'question' || a.status === 'blocked');
  const names = {};
  for (const g of config.groups || []) for (const it of g.items) names[it.id] = it.name;
  const blockers = [];
  for (const g of config.groups || []) for (const it of g.items) if (it.blocker) blockers.push(`${it.name}: ${it.blocker}`);

  const lines = [`${label}:`];
  for (const c of commits.slice(0, 8)) lines.push(`- ${c.project}: ${c.n} commit${c.n > 1 ? 's' : ''} (${c.subjects[0]})`);
  for (const t of done.slice(0, 6)) lines.push(`- Done: ${t.text} (${names[t.item] || t.item})`);
  if (lines.length === 1) lines.push('- No commits or finished tasks recorded.');
  lines.push('', 'Today:');
  for (const t of pinned.slice(0, 5)) lines.push(`- ${t.text} (${names[t.item] || t.item})`);
  if (!pinned.length) lines.push('- Pick up the top tasks from the board.');
  const block = alerts.filter((a) => a.level === 'bad').map((a) => a.text).concat(blockers.slice(0, 4));
  lines.push('', 'Blockers:');
  if (block.length) for (const b of block) lines.push(`- ${b}`); else lines.push('- None.');

  return {
    label, from: +from, to: +to, user,
    commits, totalCommits: commits.reduce((s, c) => s + c.n, 0),
    done: done.map((t) => ({ text: t.text, item: t.item })),
    focusMin: focusPast.total,
    today: pinned.map((t) => ({ id: t.id, text: t.text, item: t.item })),
    waiting: waiting.map((a) => ({ title: a.title, project: a.project, preview: a.preview })),
    standup: lines.join('\n'),
    builtAt: Date.now()
  };
}

module.exports = { build, lastWorkday };
