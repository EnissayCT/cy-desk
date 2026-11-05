// Demo mode (`--demo`): a believable, fictional workspace with no network or git access.
// Used for screenshots, the README demo, and for anyone trying CY Desk without servers.
const fs = require('fs');
const path = require('path');

// Small seeded random so the demo looks the same every run.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const H = 3600000, D = 86400000;

const SUBJECTS = {
  billing: ['feat: prorate plan changes mid-cycle', 'fix: invoice PDF rounding on 3-decimal currencies', 'perf: batch tax lookups'],
  auth: ['feat: SAML login for enterprise tenants', 'fix: refresh token rotation race'],
  admin: ['feat: audit log filters', 'a11y: keyboard navigation in tables'],
  mobile: ['feat: offline drafts', 'fix: push notification deep links', 'chore: bump React Native to 0.79'],
  reports: ['feat: CSV export for monthly revenue'],
  infra: ['ops: nightly backups to object storage', 'ops: nginx rate limits'],
  checkout: ['refactor: split checkout into steps', 'fix: coupon applied twice on retry'],
  catalog: ['feat: incremental product sync'],
  payments: ['feat: 3-D Secure 2 challenge flow'],
  emails: ['feat: order shipped template'],
  habit: ['feat: streak freeze', 'design: onboarding screens'],
  recipes: ['spike: ingredient detection from photos'],
  blog: ['post: what I learned shipping offline sync']
};

function status(config) {
  const r = rng(42), now = Date.now();
  const servers = {};
  for (const [id, s] of Object.entries(config.servers || {})) {
    servers[id] = { ok: true, ms: 900 + Math.round(r() * 400), at: now, data: {
      host: { load: [+(0.2 + r() * 0.6).toFixed(2), 0.4, 0.35], cpus: 4, memTotal: 8000, memAvail: 3600 + Math.round(r() * 1500), diskTotal: 160, diskUsed: 58, diskFree: 102, uptime: 31 * D / 1000 },
      services: (s.services || []).map((name) => ({ name, state: 'active' })), failed: [],
      containers: (s.containers || []).map((name) => ({ name, state: 'running' })), pm2: []
    } };
  }
  const sites = {};
  for (const s of config.sites || []) sites[s.id] = { ok: true, code: 200, ms: 140 + Math.round(r() * 260), certExpires: now + (40 + Math.round(r() * 40)) * D, at: now };
  const git = {};
  for (const g of config.groups || []) for (const it of g.items) {
    const subs = SUBJECTS[it.id] || ['chore: tidy up'];
    const lastAt = now - Math.round((1 + r() * 60) * H);
    git[it.id] = { lastAt, lastSubject: subs[0], week: Math.round(r() * 9), dirty: r() < 0.2 ? Math.ceil(r() * 6) : 0, version: it.version || null,
      recent: subs.map((s, i) => ({ at: lastAt - i * 7 * H, subject: s })) };
  }
  // 16 weeks of commits: busy weekdays, quiet weekends, a holiday gap, spread over the projects.
  const days = {}, perDay = {}, perItem = {}, byRepo = {};
  const items = (config.groups || []).flatMap((g) => g.items);
  for (let i = 0; i < 112; i++) {
    const d = new Date(now - i * D), dow = d.getDay();
    const base = dow === 0 || dow === 6 ? 0.25 : 1;
    const n = i > 52 && i < 62 ? 0 : Math.max(0, Math.round((r() * 9 - 2.2) * base));
    if (!n) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days[key] = n; perDay[key] = {};
    for (let k = 0; k < n; k++) {
      const it = items[Math.floor(Math.pow(r(), 1.7) * items.length)] || { id: 'x', name: 'Project' };
      perDay[key][it.name] = (perDay[key][it.name] || 0) + 1;
      perItem[it.id] = perItem[it.id] || {}; perItem[it.id][key] = (perItem[it.id][key] || 0) + 1;
      byRepo[it.name] = (byRepo[it.name] || 0) + 1;
    }
  }
  // Three hours of load samples per server, for the sparklines.
  const history = {};
  for (const id of Object.keys(servers)) {
    let v = 0.3 + r() * 0.3;
    history[`${id}.load`] = Array.from({ length: 90 }, (_, i) => { v = Math.max(0.05, v + (r() - 0.48) * 0.12); return [now - (90 - i) * 120000, +v.toFixed(2)]; });
  }
  return { servers, sites, git, history, firstSeen: {}, refreshedAt: now, refreshing: false,
    activity: { days, perDay, perItem, byRepo, weeks: 16, total: Object.values(days).reduce((a, b) => a + b, 0), at: now } };
}

// Claude Code usage for the Claude space: two weeks of a busy developer.
function usage() {
  const r = rng(7), now = Date.now(), perDay = {};
  for (let i = 0; i < 14; i++) {
    const d = new Date(now - i * D), wk = d.getDay() % 6 ? 1 : 0.3;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const msgs = Math.round((60 + r() * 220) * wk);
    perDay[key] = { in: msgs * 40, out: msgs * (900 + Math.round(r() * 900)), cacheRead: msgs * 52000, cacheWrite: msgs * 2600, msgs, prompts: Math.round(msgs / 14) };
  }
  return { perDay, models: { 'claude-opus-5-5': 7.4e6, 'claude-sonnet-5-5': 2.1e6, 'claude-haiku-5-5': 0.4e6 },
    folders: { '/home/alex/code/platform': 120, '/home/alex/code/storefront': 64, '/home/alex/code/habit': 31 }, sessions: 23, days: 14, at: now };
}

function agents() {
  const now = Date.now();
  return [
    { sessionId: '1b2c3d4e-0000-4000-8000-000000000001', title: 'Billing: proration', project: 'Billing API', item: 'billing', status: 'question', lastAt: now - 6 * 60000, localId: null, cwd: '',
      preview: 'Proration is in and tested. Ship it to staging first, or straight to production behind the flag?' },
    { sessionId: '1b2c3d4e-0000-4000-8000-000000000002', title: 'Mobile 3.0 release', project: 'Mobile app', item: 'mobile', status: 'working', lastAt: now - 20000, localId: null, cwd: '',
      preview: 'Running the end-to-end suite on the Android emulator…' },
    { sessionId: '1b2c3d4e-0000-4000-8000-000000000003', title: 'Checkout refactor', project: 'Checkout', item: 'checkout', status: 'blocked', tool: 'Bash', lastAt: now - 14 * 60000, localId: null, cwd: '',
      preview: 'Wants to run the database migration on staging.' },
    { sessionId: '1b2c3d4e-0000-4000-8000-000000000004', title: 'Admin portal accessibility', project: 'Admin portal', item: 'admin', status: 'done', lastAt: now - 2 * H, localId: null, cwd: '',
      preview: 'All tables are keyboard-navigable; 14 contrast issues fixed. Report in docs/a11y.md.' },
    { sessionId: '1b2c3d4e-0000-4000-8000-000000000005', title: 'Habit onboarding', project: 'Habit', item: 'habit', status: 'done', lastAt: now - 5 * H, localId: null, cwd: '',
      preview: 'Three onboarding screens done, with the streak explainer. Screenshots in the PR.' },
    { sessionId: '1b2c3d4e-0000-4000-8000-000000000006', title: 'Blog: offline sync post', project: 'Blog', item: 'blog', status: 'stopped', lastAt: now - 20 * H, localId: null, cwd: '',
      preview: 'Draft outline ready; stopped before the diagrams.' }
  ];
}

const TODOS = [
  ['billing', 'Ship proration behind the feature flag', true], ['billing', 'Reconcile last month’s invoices with Stripe'],
  ['auth', 'Rotate the SAML signing certificate (expires in 3 weeks)', true], ['admin', 'Review the accessibility report'],
  ['mobile', 'Submit 3.0 to TestFlight', true], ['mobile', 'Fix the deep link on Android 15'], ['reports', 'Add a yearly view'],
  ['infra', 'Test a restore from last night’s backup'], ['checkout', 'Approve the staging migration'], ['catalog', 'Throttle the supplier API to 5 req/s'],
  ['payments', 'Answer the gateway’s compliance questionnaire'], ['emails', 'Dark-mode version of the order emails'],
  ['habit', 'Reply to App Store review notes'], ['habit', 'Streak freeze: decide the price'], ['recipes', 'Compare two vision APIs on 50 photos'], ['blog', 'Finish the offline sync post']
];
function seed(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - 6 * D;
  const items = TODOS.map(([item, text, focus], i) => ({ id: `t_demo${String(i).padStart(2, '0')}`, item, text, done: false, focus: !!focus, by: i === 8 ? 'agent:Checkout refactor' : 'me', created: new Date(t0 + i * H).toISOString(), doneAt: null }));
  items.push({ id: 't_demo90', item: 'billing', text: 'Add idempotency keys to invoice creation', done: true, focus: false, by: 'me', created: new Date(t0).toISOString(), doneAt: new Date(Date.now() - 20 * H).toISOString() });
  items.push({ id: 't_demo91', item: 'mobile', text: 'Crash on logout with an expired session', done: true, focus: false, by: 'me', created: new Date(t0).toISOString(), doneAt: new Date(Date.now() - 22 * H).toISOString() });
  fs.writeFileSync(path.join(dir, 'todos.json'), JSON.stringify({ version: 1, items }, null, 2));
  const fs0 = Date.now() - 2 * D;
  fs.writeFileSync(path.join(dir, 'focus.json'), JSON.stringify({ version: 1, sessions: [
    { id: 'f_d1', item: 'billing', text: 'Proration', start: fs0, planned: 50, end: fs0 + 50 * 60000, completed: true, minutes: 50 },
    { id: 'f_d2', item: 'mobile', text: 'Offline drafts', start: fs0 + 3 * H, planned: 25, end: fs0 + 3 * H + 25 * 60000, completed: true, minutes: 25 },
    { id: 'f_d3', item: 'habit', text: 'Onboarding', start: Date.now() - 20 * H, planned: 25, end: Date.now() - 20 * H + 25 * 60000, completed: true, minutes: 25 }
  ] }, null, 2));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'auto', sing: true, breaks: true, breakMin: 90, focusMin: 25, onboarded: true, lastBrief: '', companion: { type: 'cy' } }, null, 2));
  // Money: a month and a half of a freelancer's ledger, plus subscriptions.
  const r = rng(11), entries = [];
  const day = (n) => new Date(Date.now() - n * D).toISOString().slice(0, 10);
  const OUT = [['Food', 'Groceries', 40, 90], ['Food', 'Lunch out', 9, 22], ['Transport', 'Fuel', 35, 60], ['Fun', 'Cinema', 12, 25], ['Shopping', 'Keyboard', 80, 140], ['Health', 'Pharmacy', 8, 30]];
  for (let n = 44; n >= 0; n--) {
    if (r() < 0.55) { const [c, note, a, b] = OUT[Math.floor(r() * OUT.length)]; entries.push({ id: `m_d${n}a`, kind: 'out', amount: Math.round(a + r() * (b - a)), category: c, note, date: day(n), created: day(n) }); }
    if (n % 30 === 3) entries.push({ id: `m_d${n}s`, kind: 'in', amount: 4200, category: 'Salary', note: 'Northwind retainer', date: day(n), created: day(n) });
    if (n % 30 === 12) entries.push({ id: `m_d${n}f`, kind: 'in', amount: 900, category: 'Freelance', note: 'Logo for a bakery', date: day(n), created: day(n) });
    if (n % 30 === 5) entries.push({ id: `m_d${n}r`, kind: 'out', amount: 1100, category: 'Housing', note: 'Rent', date: day(n), created: day(n) });
  }
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ version: 1, currency: 'EUR', budget: 2200, entries, recurring: [
    { id: 'r_d1', name: 'Claude Max', amount: 100, every: 'month', day: 4, category: 'Software' },
    { id: 'r_d2', name: 'VPS (2 servers)', amount: 24, every: 'month', day: 1, category: 'Servers' },
    { id: 'r_d3', name: 'Domain names', amount: 60, every: 'year', day: 15, category: 'Servers' },
    { id: 'r_d4', name: 'Spotify', amount: 11, every: 'month', day: 20, category: 'Fun' }
  ] }, null, 2));
  // Health: two weeks of screen time, breaks, water and mood.
  const days = {};
  for (let n = 13; n >= 0; n--) {
    const d = new Date(Date.now() - n * D), k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const wk = d.getDay() % 6 ? 1 : 0.35;
    days[k] = { activeMin: Math.round((300 + r() * 240) * wk), breaks: Math.round((3 + r() * 5) * wk), longest: Math.round(60 + r() * 90), water: Math.round(3 + r() * 6),
      stretches: Math.round(r() * 4), mood: 2 + Math.round(r() * 3), firstAt: null, lastAt: null };
  }
  const t = days[Object.keys(days).pop()];
  Object.assign(t, { activeMin: 214, breaks: 3, longest: 74, water: 4, stretches: 1, mood: 4 });
  fs.writeFileSync(path.join(dir, 'health.json'), JSON.stringify({ version: 1, goals: { water: 8, activeMax: 480, bedtime: '23:30' }, days }, null, 2));
}

function brief(config, todos) {
  const commits = [];
  for (const g of config.groups) for (const it of g.items) {
    const s = SUBJECTS[it.id];
    if (s && ['billing', 'mobile', 'checkout', 'habit', 'infra'].includes(it.id)) commits.push({ item: it.id, project: it.name, group: g.name, n: s.length, subjects: s });
  }
  const done = todos.items.filter((t) => t.done).map((t) => ({ text: t.text, item: t.item }));
  const today = todos.items.filter((t) => !t.done && t.focus).map((t) => ({ id: t.id, text: t.text, item: t.item }));
  const names = Object.fromEntries(config.groups.flatMap((g) => g.items.map((i) => [i.id, i.name])));
  const standup = ['Yesterday:', ...commits.map((c) => `- ${c.project}: ${c.n} commits (${c.subjects[0]})`), ...done.map((t) => `- Done: ${t.text}`),
    '', 'Today:', ...today.map((t) => `- ${t.text} (${names[t.item]})`), '', 'Blockers:', '- Habit: App Store review', '- Pantry: image recognition costs'].join('\n');
  return { label: 'Yesterday', commits, totalCommits: commits.reduce((a, c) => a + c.n, 0), done, focusMin: 25, today,
    waiting: agents().filter((a) => a.status === 'question' || a.status === 'blocked'), standup, builtAt: Date.now() };
}

module.exports = { status, agents, seed, brief, usage };
