/* CY Desk renderer. All data comes from the main process through window.cy. */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-US'));
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24">${(window.ICONS || {})[name] || ''}</svg>`;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

let C = null, T = { items: [] }, S = null, USER = '', THEME = 'light';
let AGENTS = [], VITALS = null, BATTERY = null, FOCUS = null, FOCUS_WEEK = { per: {}, total: 0 }, SETTINGS = {};
let openId = null;
let tab = 'odoo';
try { tab = localStorage.getItem('cy.tab') || 'odoo'; } catch {}
const items = new Map(); // id -> { item, group }

const STAGES = ['build', 'testing', 'beta', 'live'];
const STATUS_LABEL = { live: 'Live', review: 'In review', private: 'Private', built: 'Built', manual: 'Manual' };
const STATUS_TAG = { live: 'ok', review: 'warn', private: 'info', built: 'info', manual: 'muted' };
// A group's alerts: its servers and sites (config groups[].servers / .sites).
const groupScopes = (g) => (g.servers || []).concat((g.sites || []).map((x) => `site:${x}`));
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`);

// ---------- helpers ----------
function ago(ts) {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} d ago`;
}
const days = (ts) => Math.floor((ts - Date.now()) / 86400000);
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function indexItems() {
  items.clear();
  for (const g of C.groups) for (const it of g.items) items.set(it.id, { item: it, group: g });
}
const openTodos = (id) => T.items.filter((t) => !t.done && (!id || t.item === id));
const doneThisWeek = () => T.items.filter((t) => t.done && t.doneAt && Date.now() - Date.parse(t.doneAt) < 7 * 86400000).length;
const srv = (id) => (S && S.servers[id]) || null;
const data = (id) => (srv(id) && srv(id).data) || null;
const groupOf = (id) => C.groups.find((g) => g.id === id);
// Servers are found by what they run (their probe), not by their id in the config.
const firstOf = (probe) => Object.keys((C && C.servers) || {}).find((id) => C.servers[id].probe === probe) || null;
const dataOf = (probe) => { const id = firstOf(probe); return id ? data(id) : null; };

// ---------- checks & alerts ----------
// Every check the dashboard runs; alerts are the failing ones, health is the share passing.
function computeChecks() {
  const checks = [];
  const add = (ok, level, scope, text, sub) => checks.push({ ok, level, scope, text, sub });
  if (!S || !S.refreshedAt) return checks;
  for (const [id, s] of Object.entries(S.servers)) add(s.ok, 'bad', id, `${C.servers[id] ? C.servers[id].name : id} server unreachable`, s.error);

  const oid = firstOf('odoo'), o = oid ? data(oid) : null;
  if (o) {
    const ov = C.servers[oid].vars || {};
    add(o.httpCode === 200, 'bad', oid, `Odoo not answering (HTTP ${o.httpCode || 'none'})`, 'Right after a restart a short outage is normal');
    if (o.httpCode === 200) add(!(o.httpTime > 2), 'warn', oid, `Odoo slow: ${(o.httpTime || 0).toFixed(1)} s for the login page`);
    for (const c of o.containers || []) {
      if ([ov.ODOO || 'odoo', ov.PG || 'db'].includes(c.name)) add(c.state === 'running', 'bad', oid, `Container ${c.name} is ${c.state}`);
    }
    if (o.host.diskFree !== null) add(o.host.diskFree >= 35, o.host.diskFree < 30 ? 'bad' : 'warn', oid, `Odoo disk: ${o.host.diskFree} GB free`, 'Backups refuse to run under 30 GB');
    for (const c of o.certs || []) { const d = days(c.expires); add(d >= 20, d < 7 ? 'bad' : 'warn', oid, `Certificate ${c.name} expires in ${d} d`); }
    if (o.backupAt) add(Date.now() - o.backupAt <= 8 * 86400000, 'bad', oid, `No completed backup for ${Math.floor((Date.now() - o.backupAt) / 86400000)} days`, 'The backup job has not reported a completed run');
    add(!(o.cronLate > 0), 'warn', oid, `${o.cronLate} scheduled action${o.cronLate > 1 ? 's' : ''} late by over 10 min`);
    const mailSince = S.firstSeen && S.firstSeen['odoo.mail'];
    add(!(o.mailOutgoing > 0 && mailSince && Date.now() - mailSince > 30 * 60000), 'warn', oid, `${o.mailOutgoing} mails stuck in the queue`, mailSince ? `since ${ago(mailSince)}` : '');
    add(!(o.locks > 0), 'warn', oid, `${o.locks} blocked database lock${o.locks > 1 ? 's' : ''}`);
    add(!(o.pgLongest > 900), 'warn', oid, `A database transaction has run for ${Math.round((o.pgLongest || 0) / 60)} min`);
  }
  const pid = firstOf('plugins'), p = pid ? data(pid) : null;
  if (p) {
    const byName = {};
    for (const x of p.pm2 || []) byName[x.name] = byName[x.name] && byName[x.name] !== 'online' ? byName[x.name] : x.status;
    for (const [n, st] of Object.entries(byName)) add(st === 'online', 'bad', pid, `PM2 app ${n} is ${st}`);
    if (p.host.diskTotal) add(p.host.diskFree / p.host.diskTotal >= 0.1, 'warn', pid, `${C.servers[pid].name} disk: ${p.host.diskFree} GB free`);
  }
  for (const [id, srvDef] of Object.entries(C.servers)) {
    if (!['vps', 'linux'].includes(srvDef.probe)) continue;
    const v = data(id);
    if (!v) continue;
    const name = srvDef.name || id;
    for (const s of v.services || []) add(s.state === 'active', 'bad', id, `${name}: service ${s.name} is ${s.state}`);
    for (const f of v.failed || []) add(false, 'warn', id, `${name}: failed unit ${f}`);
    for (const c of v.containers || []) if ((srvDef.containers || []).includes(c.name)) add(c.state === 'running', 'bad', id, `${name}: container ${c.name} is ${c.state}`);
    for (const x of v.pm2 || []) add(x.status === 'online', 'bad', id, `${name}: PM2 app ${x.name} is ${x.status}`);
    if (v.host.diskTotal) add(v.host.diskFree / v.host.diskTotal >= 0.1, 'warn', id, `${name}: disk ${v.host.diskFree} GB free`);
  }
  for (const site of C.sites) {
    const r = S.sites[site.id];
    if (!r) continue;
    add(r.ok, 'bad', `site:${site.id}`, `${site.host} is down`, r.error || `HTTP ${r.code}`);
    // Odoo and jobs sit behind Cloudflare: their origin certificates are checked above.
    if (r.ok && r.certExpires && !['odoo', 'jobs'].includes(site.id)) {
      const d = days(r.certExpires);
      add(d >= 20, d < 7 ? 'bad' : 'warn', `site:${site.id}`, `Certificate ${site.host} expires in ${d} d`);
    }
  }
  add(Date.now() - S.refreshedAt <= 10 * 60000, 'warn', 'app', `Data is ${ago(S.refreshedAt)}`, 'The laptop may have been asleep or offline');
  return checks;
}
const alertsOf = (checks) => checks.filter((c) => !c.ok).sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));

function serverState(id, alerts) {
  const s = srv(id);
  if (!s) return { cls: '', label: 'Waiting' };
  const scopes = new Set([id]);
  for (const g of C.groups) if ((g.servers || []).includes(id)) for (const x of g.sites || []) scopes.add(`site:${x}`);
  const mine = alerts.filter((a) => scopes.has(a.scope));
  if (!s.ok || mine.some((a) => a.level === 'bad')) return { cls: 'bad', label: s.ok ? 'Problem' : 'Offline', alert: mine[0] };
  if (mine.length) return { cls: 'warn', label: 'Attention', alert: mine[0] };
  return { cls: 'ok', label: 'Running' };
}

// ---------- the mascot's mood ----------
function facts() {
  const L = ['All systems normal.'];
  const focus = openTodos().filter((t) => t.focus).length;
  L.push(focus ? `${focus} task${focus > 1 ? 's' : ''} in focus today.` : 'Nothing pinned for today. Star a task?');
  const o = dataOf('odoo'), p = dataOf('plugins');
  if (o && o.users > 0) L.push(`${o.users} ${o.users > 1 ? 'people are' : 'person is'} on Odoo right now.`);
  if (p && p.trend && p.trend.length) L.push(`Shopify: about ${fmtN(Math.round(p.trend.reduce((a, b) => a + b.n, 0) / p.trend.length))} parcels a day.`);
  if (p && p.today) L.push(`${fmtN(p.today)} Shopify parcels so far today.`);
  if (o && o.backupNext) L.push(`Next backup in ${Math.max(0, days(o.backupNext))} days.`);
  if (S.activity) { const w = weekCommits(); if (w) L.push(`${w} commits this week. Nice pace.`); }
  L.push(`${openTodos().length} open tasks across all projects.`);
  const h = new Date().getHours();
  if (h < 6) L.push(`It's late${USER ? `, ${USER}` : ''}. Get some sleep?`);
  else if (h < 12) L.push(`Good morning, ${USER}.`);
  return L;
}
let lastMoodKey = '';
function updateMood(alerts) {
  if (!S || !S.refreshedAt) return;
  const bad = alerts.filter((a) => a.level === 'bad'), warn = alerts.filter((a) => a.level === 'warn');
  const next = bad.length ? { mood: 'angry', level: 'bad', lines: bad.map((a) => `${a.text}!`) }
    : warn.length ? { mood: 'worried', level: 'warn', lines: warn.map((a) => `${a.text}.`) }
    : { mood: 'happy', level: 'ok', lines: facts() };
  const key = JSON.stringify(next);
  if (key !== lastMoodKey) { lastMoodKey = key; window.Buddy.setBase(next); }
}
function weekCommits() {
  if (!S.activity) return 0;
  let n = 0;
  for (let i = 0; i < 7; i++) { const d = new Date(Date.now() - i * 86400000); n += S.activity.days[dayKey(d)] || 0; }
  return n;
}

// ---------- per-probe metrics ----------
function serverMetric(id) {
  const def = C.servers[id] || {}, d = data(id);
  if (!d) return { pill: '…', row: '…' };
  if (def.probe === 'odoo') return { pill: `${d.users} online`, row: `${d.users} online · ${(d.httpTime || 0).toFixed(2)} s` };
  if (def.probe === 'plugins') {
    const avg = d.trend && d.trend.length ? Math.round(d.trend.reduce((a, b) => a + b.n, 0) / d.trend.length) : null;
    return { pill: `${fmtN(d.activeShops)} shops`, row: avg !== null ? `${fmtN(avg)} parcels/day` : `${fmtN(d.activeShops)} shops` };
  }
  const svc = d.services || [], up = svc.filter((x) => x.state === 'active').length;
  const sites = C.groups.filter((g) => (g.servers || []).includes(id)).flatMap((g) => g.sites || []);
  const sitesUp = sites.filter((x) => S.sites[x] && S.sites[x].ok).length;
  return {
    pill: svc.length ? `${up}/${svc.length} up` : `load ${d.host.load[0].toFixed(1)}`,
    row: [svc.length ? `${up}/${svc.length} services` : `load ${d.host.load[0].toFixed(2)}`, sites.length ? `${sitesUp}/${sites.length} sites` : `${d.host.diskFree} GB free`].join(' · ')
  };
}

// ---------- rendering ----------
function renderTop(alerts) {
  const pill = (id) => { const st = serverState(id, alerts); const def = C.servers[id]; return `<div class="pill-srv" title="${esc(def.sub || st.label)}"><i class="dot ${st.cls}"></i>${esc(def.short || def.name)}<span>${esc(serverMetric(id).pill)}</span></div>`; };
  $('#serverPills').innerHTML = Object.keys(C.servers).slice(0, 4).map(pill).join('') + pcPill();
  const n = $('#bellN');
  n.textContent = alerts.length || '';
  n.className = `bell-n${alerts.length ? ' on' : ''}${alerts.length && !alerts.some((a) => a.level === 'bad') ? ' warn' : ''}`;
  $('#alertsPop').innerHTML = `<h3>Alerts</h3>` + (alerts.length
    ? alerts.map((a) => `<div class="a-row"><i class="dot ${a.level}"></i><div>${esc(a.text)}${a.sub ? `<small>${esc(a.sub)}</small>` : ''}</div></div>`).join('')
    : `<div class="a-row"><i class="dot ok"></i><div>All systems normal<small>Updated ${esc(ago(S.refreshedAt))}</small></div></div>`);
}

function renderHero() {
  const h = new Date().getHours();
  const part = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('#greet').textContent = `${part}, ${USER} 👋`;
  const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#sub').textContent = `${date} · here's your workspace at a glance.`;
  const st = (value, label, ic) => `<div class="stat"><b>${value}</b><span>${icon(ic)}${esc(label)}</span></div>`;
  $('#stats').innerHTML = [
    st(fmtN(openTodos().length), 'Open tasks', 'list-checks'),
    st(fmtN(doneThisWeek()), 'Done this week', 'circle-check'),
    st(fmtN(weekCommits()), 'Commits this week', 'git-commit-horizontal'),
    st(FOCUS_WEEK.total ? fmtMin(FOCUS_WEEK.total) : '0 min', 'Focused this week', 'timer')
  ].join('');
}

function gaugeSvg(pct) {
  const n = 34, cx = 100, cy = 98, r1 = 78, r2 = 92;
  let lines = '';
  const on = Math.round((pct / 100) * n);
  for (let i = 0; i < n; i++) {
    const a = Math.PI * (1 - i / (n - 1));
    const x1 = cx + r1 * Math.cos(a), y1 = cy - r1 * Math.sin(a), x2 = cx + r2 * Math.cos(a), y2 = cy - r2 * Math.sin(a);
    lines += `<line class="${i < on ? 'on' : 'off'}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }
  const a = Math.PI * (1 - Math.max(0, on - 1) / (n - 1));
  const kx = cx + ((r1 + r2) / 2) * Math.cos(a), ky = cy - ((r1 + r2) / 2) * Math.sin(a);
  return `<svg class="gauge" viewBox="0 0 200 104">${lines}<circle class="knob" cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="6"/></svg>`;
}

function renderHealth(checks, alerts) {
  const ok = checks.filter((c) => c.ok).length;
  const pct = checks.length ? Math.round((ok / checks.length) * 100) : 0;
  const label = !S.refreshedAt ? 'Checking…' : alerts.some((a) => a.level === 'bad') ? 'Something is down' : alerts.length ? 'Needs attention' : 'Everything healthy';
  const row = (id) => {
    const st = serverState(id, alerts), def = C.servers[id];
    return `<div class="srv-row ${st.alert ? 'alert' : ''}"><i class="dot ${st.cls}"></i><div><b>${esc(def.name)}</b><span>${esc(def.sub || '')}</span></div><em>${esc(st.alert ? st.alert.text : serverMetric(id).row)}</em></div>`;
  };
  $('#health').innerHTML = `
    <div class="card-head"><div><h2>System health</h2><p>${ok} of ${checks.length} checks passing · ${esc(ago(S.refreshedAt))}</p></div></div>
    <div class="gauge-wrap">${gaugeSvg(pct)}<div class="gauge-num"><b>${pct}<small>%</small></b><span>${esc(label)}</span></div></div>
    <div class="srv-rows">${Object.keys(C.servers).length ? Object.keys(C.servers).slice(0, 4).map(row).join('') : `<div class="srv-row"><i class="dot"></i><div><b>No servers yet</b><span>add one in Settings</span></div><em></em></div>`}</div>`;
}

function renderFocus() {
  const open = openTodos();
  const focus = open.filter((t) => t.focus);
  $('#focusSub').textContent = `${focus.length} pinned · ${open.length} open${FOCUS_WEEK.total ? ` · ${fmtMin(FOCUS_WEEK.total)} focused this week` : ''}`;
  const list = $('#focusList');
  const row = (t, it, next) => `<li class="f-item ${next ? 'next' : ''}"><button class="check" data-done="${esc(t.id)}" title="Done"></button>
      <div><div class="txt">${esc(t.text)}</div><div class="from" data-open="${esc(t.item)}">${icon('folder')}${esc(it ? it.name : t.item)}</div></div>
      <span class="f-acts">${FOCUS ? '' : `<button class="f-play" data-start="${esc(t.id)}" data-min="${SETTINGS.focusMin || 25}" title="Focus on it for ${SETTINGS.focusMin || 25} min">${icon('play')}${SETTINGS.focusMin || 25}</button>`}${next ? `<button class="pin" data-focus="${esc(t.id)}" title="Pin to focus">${icon('star')}</button>` : ''}</span></li>`;
  let html = focus.length ? focus.map((t) => row(t, items.get(t.item) && items.get(t.item).item, false)).join('')
    : `<li class="empty">Nothing pinned for today. Star a task in any project, or add one above.</li>`;
  const next = [];
  for (const g of C.groups) for (const it of g.items) { const t = open.find((x) => x.item === it.id && !x.focus); if (t) next.push({ t, it }); }
  if (next.length) html += `<li class="f-sep">Up next</li>` + next.slice(0, 6).map(({ t, it }) => row(t, it, true)).join('');
  list.innerHTML = html;
  // Keep only what fits: no half-cut rows.
  while (list.scrollHeight > list.clientHeight + 1 && list.lastElementChild && list.lastElementChild.classList.contains('next')) list.lastElementChild.remove();
  if (list.lastElementChild && list.lastElementChild.classList.contains('f-sep')) list.lastElementChild.remove();

  const sel = $('#quickItem'), keep = sel.value;
  sel.innerHTML = C.groups.map((g) => `<optgroup label="${esc(g.name)}">${g.items.map((it) => `<option value="${esc(it.id)}">${esc(it.name)}</option>`).join('')}</optgroup>`).join('');
  if (keep && items.has(keep)) sel.value = keep;
}

function renderStageCaption(alerts) {
  $('#caption').textContent = !S.refreshedAt ? 'Checking your servers…'
    : alerts.length ? `${alerts.length} thing${alerts.length > 1 ? 's' : ''} need${alerts.length > 1 ? '' : 's'} you · updated ${ago(S.refreshedAt)}`
    : `All systems normal · updated ${ago(S.refreshedAt)}`;
}

function renderActivity() {
  const A = S.activity;
  const weeks = 16;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7; // Monday = 0
  const start = new Date(today); start.setDate(start.getDate() - dow - (weeks - 1) * 7);
  let total = 0;
  const cells = [], months = [];
  for (let w = 0; w < weeks; w++) {
    const first = new Date(start); first.setDate(first.getDate() + w * 7);
    months.push(first.getDate() <= 7 ? first.toLocaleDateString('en-GB', { month: 'short' }) : '');
  }
  for (let d = 0; d < 7; d++) {
    const row = [];
    for (let w = 0; w < weeks; w++) {
      const day = new Date(start); day.setDate(day.getDate() + w * 7 + d);
      const n = (A && A.days[dayKey(day)]) || 0;
      if (day <= today) total += n;
      const lvl = n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 10 ? 3 : 4;
      row.push(`<i class="c c${lvl}${+day === +today ? ' today' : ''}${day > today ? ' future' : ''}" title="${day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}: ${n} commit${n === 1 ? '' : 's'}"></i>`);
    }
    cells.push(row);
  }
  const labels = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];
  $('#heat').innerHTML = `<span></span>${months.map((m) => `<span class="m">${m}</span>`).join('')}` +
    cells.map((row, d) => `<span class="d">${labels[d]}</span>${row.join('')}`).join('');
  $('#activitySub').textContent = A ? `${fmtN(total)} commits in the last ${weeks} weeks · ${Object.keys(A.byRepo).length} repos` : 'Reading git history…';
}

function renderProjects(alerts, animate) {
  const ids = C.groups.map((g) => g.id).slice(0, 3).concat(['agents']);
  if (!ids.includes(tab)) tab = ids[0];
  const idx = ids.indexOf(tab);
  const seg = $('#tabs');
  seg.style.gridTemplateColumns = `repeat(${ids.length}, 1fr)`;
  const needYou = AGENTS.filter((a) => a.status === 'question' || a.status === 'blocked').length;
  seg.innerHTML = `<i class="seg-thumb" style="width: calc((100% - 0.5rem) / ${ids.length}); transform: translateX(${idx * 100}%)"></i>` + C.groups.slice(0, 3).map((g) => {
    const n = openTodos().filter((t) => items.get(t.item) && items.get(t.item).group.id === g.id).length;
    const scopes = groupScopes(g);
    const mine = alerts.filter((a) => scopes.includes(a.scope));
    const issue = mine.some((a) => a.level === 'bad') ? 'bad' : mine.length ? 'warn' : '';
    return `<button class="${g.id === tab ? 'on' : ''}" data-tab="${esc(g.id)}">${issue ? `<i class="dot ${issue}"></i>` : ''}${esc(g.short || g.name.split(' · ').pop())}<span class="n">${n || ''}</span></button>`;
  }).join('') + `<button class="${tab === 'agents' ? 'on' : ''}" data-tab="agents">${needYou ? '<i class="dot accent"></i>' : ''}Agents<span class="n">${needYou || ''}</span></button>`;
  if (tab === 'agents') { renderAgents(animate); return; }
  document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === tab));

  const g = groupOf(tab);
  if (!g) return;
  const total = openTodos().length;
  $('#projSub').textContent = `${C.groups.reduce((a, x) => a + x.items.length, 0)} projects · ${total} open tasks`;
  const count = (n) => `<span class="p-count ${n ? '' : 'zero'}">${n}</span>`;
  // Each project picks its row from what it is: a product with a stage (track + blocker),
  // something released with a status (tag), or a code module (version, commits).
  const html = g.items.map((it) => {
    const n = openTodos(it.id).length, gs = S.git[it.id], top = openTodos(it.id)[0];
    if (it.stage) {
      const site = it.site && S.sites[it.site];
      const pct = Math.round(((STAGES.indexOf(it.stage) + 1) / STAGES.length) * 100);
      return `<button class="prow p-big" data-open="${esc(it.id)}"><div class="p-main"><div class="p-name">${esc(it.name)} <span class="p-meta" style="display:inline">${esc(it.tagline || '')}</span></div>
          <div class="p-block">${it.blocker ? `${esc(it.blocker)}` : ''}</div></div>
        <div style="text-align:right"><span class="tag ${it.stage === 'live' ? 'ok' : it.stage === 'beta' ? 'info' : 'accent'}">${esc(it.stage)}</span>
          <div class="p-bar" style="margin-top:0.5rem"><i style="width:${pct}%"></i></div>
          <div class="p-meta" style="margin-top:0.35rem">${site ? (site.ok ? `site ${site.ms} ms` : '<span style="color:var(--bad)">site down</span>') : gs && gs.lastAt ? `commit ${ago(gs.lastAt)}` : ''}</div></div>${count(n)}</button>`;
    }
    if (it.status) {
      const ver = it.version ? (/^\d/.test(it.version) ? `v${it.version}` : it.version) : '';
      return `<button class="prow" data-open="${esc(it.id)}"><div class="p-main"><div class="p-name">${esc(it.name)}</div><div class="p-meta">${esc([ver, top ? top.text : gs && gs.lastAt ? `commit ${ago(gs.lastAt)}` : ''].filter(Boolean).join(' · '))}</div></div>
        <span class="tag ${STATUS_TAG[it.status] || 'muted'}">${esc(STATUS_LABEL[it.status] || it.status)}</span>${count(n)}</button>`;
    }
    const meta = gs && gs.lastAt ? `${gs.version ? `${esc(gs.version.replace(/^16\.0\./, 'v'))} · ` : ''}${ago(gs.lastAt)}${gs.week ? ` · ${gs.week} this week` : ''}${gs.dirty ? ` · <span class="dirty">${gs.dirty} uncommitted</span>` : ''}`
      : !(it.paths && it.paths.length) && !it.repo ? 'Chat & to-dos' : '—';
    return `<button class="prow" data-open="${esc(it.id)}"><div class="p-main"><div class="p-name">${esc(it.name)}</div><div class="p-meta">${meta}</div></div><span></span>${count(n)}</button>`;
  }).join('');
  const box = $('#plist');
  box.className = `plist${animate ? ' enter' : ''}`;
  box.innerHTML = html;
}

// ---------- drawer ----------
function itemFolder(it, group) { return it.repo || it.folder || group.repo || null; }
function openDrawer(id) {
  if (!items.has(id)) return;
  openId = id;
  renderDrawer();
  $('#drawer').classList.add('on'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#scrim').classList.add('on');
  setTimeout(() => $('#dAddText').focus(), 400);
}
function closeDrawer() {
  openId = null;
  $('#drawer').classList.remove('on'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#scrim').classList.remove('on');
}
function todoRow(t, draggable) {
  const by = t.by && t.by.startsWith('agent:') ? `<span class="by">${esc(t.by.replace(/^agent:/, 'from '))}</span>` : '';
  return `<li class="todo" data-id="${esc(t.id)}" ${draggable ? 'draggable="true"' : ''}>
    <button class="check ${t.done ? 'on' : ''}" data-toggle="${esc(t.id)}" title="${t.done ? 'Reopen' : 'Done'}"></button>
    <div class="txt" data-edit="${esc(t.id)}" title="Double-click to edit">${esc(t.text)}${by}</div>
    ${t.done ? '<span></span>' : `<button class="act star ${t.focus ? 'on' : ''}" data-focus="${esc(t.id)}" title="${t.focus ? 'Unpin from focus' : 'Pin to focus'}">${icon('star')}</button>`}
    <button class="act" data-del="${esc(t.id)}" title="Delete">${icon('trash-2')}</button></li>`;
}
function renderDrawer() {
  if (!openId || !items.has(openId)) return;
  const { item: it, group } = items.get(openId);
  const g = S.git[it.id];
  $('#dGroup').textContent = group.name;
  $('#dTitle').textContent = it.name;
  $('#dSub').textContent = it.tagline || (it.status ? STATUS_LABEL[it.status] || it.status : it.paths && it.paths.length ? it.paths.join(' · ') : '');
  const folder = itemFolder(it, group);
  const acts = [];
  if (it.session) acts.push(`<button class="btn-dark" data-session="${esc(it.session)}">${icon('message-circle')}Open chat</button>`);
  if (folder) acts.push(`<button class="btn-ghost" data-claude="${esc(folder)}">${icon('square-terminal')}New Claude here</button>`, `<button class="btn-ghost" data-folder="${esc(folder)}">${icon('folder')}Folder</button>`);
  if (it.url) acts.push(`<button class="btn-ghost" data-url="${esc(it.url)}">${icon('external-link')}Website</button>`);
  $('#dActions').innerHTML = acts.join('');
  const chips = [];
  if (it.blocker) chips.push(`<span class="tag accent">${esc(it.blocker)}</span>`);
  if (it.stage) chips.push(`<span class="tag muted">Stage: ${esc(it.stage)}</span>`);
  const ver = (g && g.version) || it.version;
  if (ver) chips.push(`<span class="tag muted">${esc(/^\d/.test(ver) ? `v${ver}` : ver)}</span>`);
  if (g && g.lastAt) chips.push(`<span class="tag muted">Last commit ${ago(g.lastAt)}</span>`);
  if (g && g.week) chips.push(`<span class="tag muted">${g.week} commit${g.week > 1 ? 's' : ''} this week</span>`);
  if (g && g.dirty) chips.push(`<span class="tag warn">${g.dirty} uncommitted file${g.dirty > 1 ? 's' : ''}</span>`);
  const site = it.site && S.sites[it.site];
  if (site) chips.push(`<span class="tag ${site.ok ? 'ok' : 'bad'}">${site.ok ? `Site up · ${site.ms} ms` : 'Site down'}</span>`);
  $('#dChips').innerHTML = chips.join('');
  const mine = T.items.filter((t) => t.item === it.id);
  const open = mine.filter((t) => !t.done);
  const done = mine.filter((t) => t.done).sort((a, b) => Date.parse(b.doneAt || 0) - Date.parse(a.doneAt || 0)).slice(0, 6);
  $('#dCount').textContent = open.length || '';
  $('#dTodos').innerHTML = open.length ? open.map((t) => todoRow(t, true)).join('') : `<li class="empty">No open tasks. Add one below.</li>`;
  $('#dDoneSec').style.display = done.length ? '' : 'none';
  $('#dDone').innerHTML = done.map((t) => todoRow(t, false)).join('');
  const commits = (g && g.recent) || [];
  $('#dCommitsSec').style.display = commits.length ? '' : 'none';
  $('#dCommits').innerHTML = commits.map((c) => `<li><time>${esc(ago(c.at))}</time><span>${esc(c.subject)}</span></li>`).join('');
}

// ---------- search ----------
let searchSel = 0, searchHits = [];
function runSearch() {
  const q = $('#search').value.trim().toLowerCase();
  const box = $('#searchResults');
  if (!q) { box.classList.remove('on'); searchHits = []; return; }
  const hits = [];
  for (const [id, { item, group }] of items) if ((item.name + ' ' + (item.tagline || '')).toLowerCase().includes(q)) hits.push({ id, label: item.name, sub: group.short || group.name.split(' · ').pop(), kind: 'folder' });
  for (const t of T.items) if (!t.done && t.text.toLowerCase().includes(q)) { const it = items.get(t.item); hits.push({ id: t.item, label: t.text, sub: it ? it.item.name : t.item, kind: 'list-checks' }); }
  searchHits = hits.slice(0, 8);
  searchSel = 0;
  box.innerHTML = searchHits.length ? searchHits.map((h, i) => `<div class="sr ${i === 0 ? 'sel' : ''}" data-open="${esc(h.id)}">${icon(h.kind)}<span>${esc(h.label)}</span><small>${esc(h.sub)}</small></div>`).join('')
    : `<div class="sr"><span>No match</span></div>`;
  box.classList.add('on');
}

// ---------- ideas (what Cy suggests when it has a lightbulb moment) ----------
function ideas() {
  const out = [];
  const open = openTodos();
  const focus = open.filter((t) => t.focus);
  if (focus.length) out.push(`Idea: start with “${focus[0].text.slice(0, 60)}${focus[0].text.length > 60 ? '…' : ''}”.`);
  const quick = open.filter((t) => t.text.length < 48).sort((a, b) => a.text.length - b.text.length)[0];
  if (quick) out.push(`Quick win: “${quick.text}”.`);
  for (const [id, { item }] of items) {
    const g = S.git[id];
    if (g && g.lastAt && Date.now() - g.lastAt > 5 * 86400000 && openTodos(id).length) {
      out.push(`${item.name} hasn't had a commit in ${Math.floor((Date.now() - g.lastAt) / 86400000)} days. Maybe today?`);
    }
  }
  if (S.activity) {
    let streak = 0;
    for (let i = 0; i < 60; i++) { if (S.activity.days[dayKey(new Date(Date.now() - i * 86400000))]) streak++; else if (i > 0) break; }
    if (streak >= 3) out.push(`${streak}-day commit streak. Keep it going!`);
  }
  const o = dataOf('odoo');
  if (o && o.backupNext) { const d = Math.max(0, days(o.backupNext)); if (d <= 1) out.push(`The backup runs ${d ? 'tomorrow' : 'tonight'}. Avoid deploying around then.`); }
  if (o && o.certs && o.certs.length) { const c = o.certs.reduce((a, b) => (a.expires < b.expires ? a : b)); const d = days(c.expires); if (d < 40) out.push(`${c.name} renews itself in about ${Math.max(0, d - 30)} days. Worth a glance then.`); }
  out.push(pick(['Stand up and stretch for a minute?', 'Water break? I will guard the servers.', 'Close a few tabs. Future you says thanks.']));
  return pick(out);
}

// ---------- this PC ----------
function pcPill() {
  const v = VITALS;
  if (!v) return '';
  const b = BATTERY;
  const bat = b ? ` · ${b.charging ? '⚡' : ''}${Math.round(b.level * 100)}%` : '';
  const cls = v.cpu >= 85 || (b && !b.charging && b.level < 0.15) ? 'warn' : 'ok';
  return `<button class="pill-srv" id="pcPill" title="This PC"><i class="dot ${cls}"></i>This PC<span>CPU ${v.cpu}% · RAM ${v.mem}%${bat}</span></button>`;
}
function renderPcPop() {
  const v = VITALS, b = BATTERY;
  if (!v) return;
  const bar = (pct, cls = '') => `<div class="meter"><i class="${cls}" style="width:${Math.min(100, pct)}%"></i></div>`;
  const breakIn = SETTINGS.breaks !== false ? Math.max(0, (SETTINGS.breakMin || 90) - v.activeMin) : null;
  $('#pcPop').innerHTML = `<h3>This PC</h3>
    <div class="pc-row">${icon('cpu')}<span>CPU</span><b>${v.cpu}%</b>${bar(v.cpu, v.cpu >= 85 ? 'warn' : '')}</div>
    <div class="pc-row">${icon('memory-stick')}<span>Memory</span><b>${v.mem}% of ${v.memTotal} GB</b>${bar(v.mem, v.mem >= 90 ? 'warn' : '')}</div>
    ${v.disk ? `<div class="pc-row">${icon('hard-drive')}<span>Disk</span><b>${v.disk.free} GB free</b>${bar(100 - (100 * v.disk.free) / v.disk.total, v.disk.free < 15 ? 'warn' : '')}</div>` : ''}
    ${b ? `<div class="pc-row">${icon(b.charging ? 'battery-charging' : b.level < 0.2 ? 'battery-low' : 'battery')}<span>Battery</span><b>${Math.round(b.level * 100)}%${b.charging ? ' · charging' : ''}</b>${bar(b.level * 100, !b.charging && b.level < 0.15 ? 'warn' : '')}</div>` : ''}
    <div class="pc-foot">${icon('coffee')}<span>${v.activeMin ? `Working for ${fmtMin(v.activeMin)} without a break` : 'Fresh start: no long stretch yet'}${breakIn !== null && v.activeMin ? ` · break suggested in ${fmtMin(breakIn)}` : ''}</span></div>`;
}
// Cy reacts to the machine: a hot CPU, a low battery, a long stretch without a break.
const pcState = { hot: 0, lastHot: 0, lowWarned: false, charging: null, lastBreak: 0 };
function reactToPc() {
  const v = VITALS, b = BATTERY;
  if (!v) return;
  pcState.hot = v.cpu >= 85 ? pcState.hot + 1 : 0;
  if (pcState.hot === 4 && Date.now() - pcState.lastHot > 20 * 60000) {
    pcState.lastHot = Date.now();
    window.Buddy.react('worried', `Your laptop is working hard: CPU at ${v.cpu}% for a while.`);
  }
  if (b) {
    if (!b.charging && b.level < 0.15 && !pcState.lowWarned) { pcState.lowWarned = true; window.Buddy.react('sleepy', `Battery at ${Math.round(b.level * 100)}%. Plug me in?`); }
    if (b.charging && pcState.charging === false) { pcState.lowWarned = false; window.Buddy.react('happy', 'Charging. Thank you!'); }
    pcState.charging = b.charging;
  }
  const need = SETTINGS.breakMin || 90;
  if (SETTINGS.breaks !== false && !FOCUS && v.activeMin >= need && Date.now() - pcState.lastBreak > 30 * 60000) {
    pcState.lastBreak = Date.now();
    window.Buddy.run('stretch');
    window.Buddy.say(`${fmtMin(v.activeMin)} without a break. Stand up and stretch for 2 minutes?`, 12000);
  }
}

// ---------- agents board ----------
const AGENT_TAG = { question: ['accent', 'Needs you'], blocked: ['warn', 'Blocked'], working: ['info', 'Working'], done: ['ok', 'Done'], stopped: ['muted', 'Stopped'] };
function renderAgents(animate) {
  const n = AGENTS.filter((a) => a.status === 'question' || a.status === 'blocked').length;
  $('#projSub').textContent = AGENTS.length ? `${AGENTS.length} sessions in the last 3 days · ${n ? `${n} need${n > 1 ? '' : 's'} you` : 'none waiting on you'}` : 'No Claude sessions in the last 3 days';
  const box = $('#plist');
  box.className = `plist${animate ? ' enter' : ''}`;
  box.innerHTML = AGENTS.slice(0, 7).map((a, i) => {
    const [cls, label] = AGENT_TAG[a.status] || AGENT_TAG.stopped;
    return `<button class="prow agent" data-agent="${i}" title="${esc(a.localId ? 'Open in Claude' : 'Resume in a terminal')}">
      <div class="p-main"><div class="p-name">${a.status === 'working' ? '<i class="spin-dot"></i>' : ''}${esc(a.title)}</div>
        <div class="p-meta">${esc(a.project)} · ${esc(ago(a.lastAt))}${a.tool ? ` · waiting on ${esc(a.tool)}` : ''}</div>
        <div class="p-prev">${esc(a.preview)}</div></div>
      <span class="tag ${cls}">${label}</span><span class="p-go">${icon(a.localId ? 'message-circle' : 'square-terminal')}</span></button>`;
  }).join('') || `<div class="empty">When Claude Code sessions run on this computer, they show up here with their state.</div>`;
}
let agentSeen = null;
function reactToAgents(list) {
  // Tell about sessions that just finished or started waiting for an answer.
  const now = new Map(list.map((a) => [a.sessionId, a.status]));
  if (agentSeen) {
    for (const a of list) {
      const before = agentSeen.get(a.sessionId);
      if (before === 'working' && (a.status === 'question' || a.status === 'blocked')) { window.Buddy.notify(`${a.title} needs your answer.`); break; }
      if (before === 'working' && a.status === 'done') { window.Buddy.notify(`${a.title} is done.`); break; }
    }
  }
  agentSeen = now;
}

// ---------- focus sessions ----------
function renderFocusBanner() {
  const box = $('#focusBanner');
  if (!FOCUS) { box.className = 'focus-banner hidden'; box.innerHTML = ''; return; }
  const left = Math.max(0, FOCUS.endsAt - Date.now());
  const total = FOCUS.planned * 60000;
  const pct = 1 - left / total;
  const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
  const C2 = 2 * Math.PI * 15;
  box.className = 'focus-banner';
  box.innerHTML = `<svg class="ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" class="track"/><circle cx="18" cy="18" r="15" class="fill" style="stroke-dasharray:${C2.toFixed(1)};stroke-dashoffset:${(C2 * (1 - pct)).toFixed(1)}"/></svg>
    <div class="fb-main"><b>${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}</b><span>${esc(FOCUS.text)}</span></div>
    <button class="btn-ghost sm" id="focusStop">${icon('square')}Stop</button>`;
}
setInterval(() => { if (FOCUS) renderFocusBanner(); }, 1000);
function startFocus(todoId, minutes) {
  const t = T.items.find((x) => x.id === todoId);
  if (!t) return;
  window.cy.focusStart({ todoId, item: t.item, text: t.text, minutes });
}

// ---------- render all ----------
function render() {
  if (!C || !S) return;
  const checks = computeChecks(), alerts = alertsOf(checks);
  renderTop(alerts);
  renderHero();
  renderHealth(checks, alerts);
  renderFocus();
  renderStageCaption(alerts);
  renderActivity();
  renderProjects(alerts, false);
  updateMood(alerts);
  $('#refresh').classList.toggle('spin', !!(S && S.refreshing));
  if (openId && !$('#drawer [contenteditable="true"]')) renderDrawer();
}

// The mascot reacts to to-dos finished or added anywhere (here or by a Claude session).
let known = new Map();
function snapshotTodos() { known = new Map(T.items.map((t) => [t.id, t.done])); }
function reactToTodos(next) {
  const added = next.items.filter((t) => !known.has(t.id));
  const finished = next.items.filter((t) => t.done && known.get(t.id) === false);
  const left = next.items.filter((t) => !t.done).length;
  if (finished.length) window.Buddy.celebrate(pick(['Nice!', 'Done and dusted.', 'One less thing.', 'Look at you go.']) + ` ${left} to go.`);
  else if (added.length === 1 && added[0].by && added[0].by.startsWith('agent:')) {
    const it = items.get(added[0].item);
    window.Buddy.notify(`New task for ${it ? it.item.name : added[0].item}, from ${added[0].by.slice(6)}.`);
  }
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  if (!e.target.closest('#bell, #alertsPop')) $('#alertsPop').classList.remove('on');
  if (!e.target.closest('.search')) $('#searchResults').classList.remove('on');
  if (!e.target.closest('#pcPill, #pcPop')) $('#pcPop').classList.remove('on');
  if (e.target.closest('#pcPill')) { renderPcPop(); $('#pcPop').classList.toggle('on'); return; }
  if (e.target.closest('#focusStop')) { window.cy.focusStop(); return; }
  const ag = e.target.closest('[data-agent]');
  if (ag) { const a = AGENTS[+ag.dataset.agent]; if (a) window.cy.openAgent(a); return; }
  const st = e.target.closest('[data-start]');
  if (st) { startFocus(st.dataset.start, +st.dataset.min || 25); return; }
  const el = e.target.closest('[data-open],[data-done],[data-toggle],[data-focus],[data-del],[data-session],[data-claude],[data-folder],[data-url],[data-tab],[data-nav]');
  if (!el) return;
  const d = el.dataset;
  if (d.tab || (d.nav && d.nav !== 'overview')) {
    const t = d.tab || d.nav;
    if (t !== tab) { tab = t; try { localStorage.setItem('cy.tab', tab); } catch {} renderProjects(alertsOf(computeChecks()), true); }
  }
  else if (d.nav === 'overview') { closeDrawer(); document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === 'overview')); }
  else if (d.open) { $('#searchResults').classList.remove('on'); $('#search').value = ''; openDrawer(d.open); }
  else if (d.done) { el.classList.add('on'); setTimeout(() => window.cy.patchTodo(d.done, { done: true }), 260); }
  else if (d.toggle) {
    const t = T.items.find((x) => x.id === d.toggle);
    if (t) { if (!t.done) el.classList.add('on'); setTimeout(() => window.cy.patchTodo(t.id, { done: !t.done }), t.done ? 0 : 220); }
  }
  else if (d.focus) { const t = T.items.find((x) => x.id === d.focus); if (t) window.cy.patchTodo(t.id, { focus: !t.focus }); }
  else if (d.del) window.cy.removeTodo(d.del);
  else if (d.session) window.cy.openSession(d.session);
  else if (d.claude) window.cy.openClaude(d.claude);
  else if (d.folder) window.cy.openFolder(d.folder);
  else if (d.url) window.cy.openUrl(d.url);
});

document.addEventListener('dblclick', (e) => {
  const el = e.target.closest('[data-edit]');
  if (!el) return;
  const t = T.items.find((x) => x.id === el.dataset.edit);
  if (!t) return;
  el.textContent = t.text;
  el.contentEditable = 'true';
  el.focus();
  document.getSelection().selectAllChildren(el);
  const finish = (save) => {
    el.removeEventListener('keydown', onKey); el.removeEventListener('blur', onBlur);
    el.contentEditable = 'false';
    const text = el.textContent.trim();
    if (save && text && text !== t.text) window.cy.patchTodo(t.id, { text });
    else renderDrawer();
  };
  const onKey = (k) => { if (k.key === 'Enter') { k.preventDefault(); finish(true); } if (k.key === 'Escape') { k.stopPropagation(); finish(false); } };
  const onBlur = () => finish(true);
  el.addEventListener('keydown', onKey); el.addEventListener('blur', onBlur);
});

let dragId = null;
$('#dTodos').addEventListener('dragstart', (e) => { const li = e.target.closest('.todo'); if (!li) return; dragId = li.dataset.id; li.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; });
$('#dTodos').addEventListener('dragend', (e) => { const li = e.target.closest('.todo'); if (li) li.classList.remove('drag'); dragId = null; });
$('#dTodos').addEventListener('dragover', (e) => {
  const li = e.target.closest('.todo'); if (!li || !dragId) return;
  e.preventDefault();
  document.querySelectorAll('.todo.over').forEach((x) => x.classList.remove('over'));
  li.classList.add('over');
});
$('#dTodos').addEventListener('drop', (e) => {
  e.preventDefault();
  const li = e.target.closest('.todo');
  document.querySelectorAll('.todo.over').forEach((x) => x.classList.remove('over'));
  if (!li || !dragId || li.dataset.id === dragId) return;
  const ids = [...$('#dTodos').querySelectorAll('.todo')].map((x) => x.dataset.id).filter((x) => x !== dragId);
  window.cy.moveTodo(dragId, ids.indexOf(li.dataset.id));
});

$('#quickAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#quickText').value.trim();
  if (!text) return;
  await window.cy.addTodo({ item: $('#quickItem').value, text, focus: true });
  $('#quickText').value = '';
  window.Buddy.say('Got it. Pinned to your focus.', 4000);
});
$('#newTask').addEventListener('click', () => $('#quickText').focus());
$('#dAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#dAddText').value.trim();
  if (!text || !openId) return;
  await window.cy.addTodo({ item: openId, text });
  $('#dAddText').value = '';
});
$('#dClose').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
$('#refresh').addEventListener('click', () => { window.cy.refresh(); window.Buddy.say('Checking everything…', 3000); });
$('#bell').addEventListener('click', () => $('#alertsPop').classList.toggle('on'));
$('#themeBtn').addEventListener('click', () => window.cy.setTheme(THEME === 'dark' ? 'light' : 'dark'));
$('#search').addEventListener('input', runSearch);
$('#search').addEventListener('keydown', (e) => {
  const rows = [...document.querySelectorAll('#searchResults .sr[data-open]')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    searchSel = (searchSel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(rows.length, 1);
    rows.forEach((r, i) => r.classList.toggle('sel', i === searchSel));
  } else if (e.key === 'Enter' && rows[searchSel]) rows[searchSel].click();
  else if (e.key === 'Escape') { $('#search').value = ''; runSearch(); $('#search').blur(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openId) closeDrawer(); });

function renderProfile() {
  const p = C.profile || { name: USER };
  const full = p.fullName || p.name || '';
  $('#meName').textContent = full;
  $('#meRole').textContent = p.role || '';
  $('#meAvatar').textContent = full.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '·';
}

function setTheme(th) {
  THEME = th;
  document.body.dataset.theme = th;
  $('#themeBtn').innerHTML = icon(th === 'dark' ? 'sun' : 'moon');
}

// ---------- boot ----------
(async function boot() {
  document.querySelectorAll('[data-icon]').forEach((i) => { i.outerHTML = icon(i.dataset.icon); });
  const init = await window.cy.init();
  C = init.config; T = init.todos; S = init.status; USER = (init.config.profile && init.config.profile.name) || init.user || '';
  AGENTS = init.agents || []; VITALS = init.vitals; FOCUS = init.focus; FOCUS_WEEK = init.focusWeek || FOCUS_WEEK; SETTINGS = init.settings || {};
  agentSeen = new Map(AGENTS.map((a) => [a.sessionId, a.status]));
  renderProfile();
  window.__version = init.version;
  setTheme(init.theme || 'light');
  if (FOCUS) { window.Buddy.setFocus(true); renderFocusBanner(); }
  if (init.covered) window.Buddy.setPaused(true);
  indexItems();
  // Sidebar shortcuts: one per group (up to three), whatever the groups are called.
  document.querySelectorAll('.nav [data-nav]:not([data-nav="overview"])').forEach((b, i) => {
    const g = C.groups[i];
    if (g) { b.dataset.nav = g.id; b.title = g.name; } else b.style.display = 'none';
  });
  snapshotTodos();
  render();
  renderProjects(alertsOf(computeChecks()), true);
  const h = new Date().getHours();
  window.Buddy.say(`${h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Hi' : 'Good evening'}, ${USER}!`, 5000);
  window.cy.on('status', (s) => { S = s; render(); });
  window.cy.on('todos', (t) => { reactToTodos(t); T = t; snapshotTodos(); render(); });
  window.cy.on('config', (c) => { C = c; USER = (c.profile && c.profile.name) || c.user || USER; indexItems(); renderProfile(); render(); });
  window.cy.on('theme', setTheme);
  window.cy.on('cursor', (p) => window.Buddy.onCursor(p));
  window.cy.on('covered', (c) => window.Buddy.setPaused(c));
  window.cy.on('audio', (a) => window.Buddy.onAudio(a));
  window.cy.on('agents', (list) => { reactToAgents(list); AGENTS = list; renderProjects(alertsOf(computeChecks()), false); });
  window.cy.on('vitals', (v) => { VITALS = v; renderTop(alertsOf(computeChecks())); if ($('#pcPop').classList.contains('on')) renderPcPop(); reactToPc(); });
  window.cy.on('focus', (f) => {
    FOCUS = f.active; FOCUS_WEEK = f.week || FOCUS_WEEK;
    window.Buddy.setFocus(!!FOCUS);
    if (f.active) window.Buddy.say(`Focus: ${f.active.planned} min on “${f.active.text.slice(0, 50)}”. I'll keep quiet.`, 7000);
    else if (f.ended && !f.stopped) window.Buddy.celebrate(`${f.ended.minutes} focused minutes! Take 5.`);
    else if (f.stopped) window.Buddy.say(`Stopped after ${f.ended ? f.ended.minutes : 0} min. No worries.`, 4000);
    renderFocusBanner(); renderFocus(); renderHero();
  });
  if (navigator.getBattery) navigator.getBattery().then((b) => {
    const upd = () => { BATTERY = b.level === 1 && b.charging && b.chargingTime === 0 && !b.dischargingTime ? null : { level: b.level, charging: b.charging }; renderTop(alertsOf(computeChecks())); reactToPc(); };
    ['levelchange', 'chargingchange'].forEach((ev) => b.addEventListener(ev, upd)); upd();
  }).catch(() => {});
  window.cy.on('sing', (on) => window.Buddy.setSinging(on));
  window.Buddy.setSinging(init.sing !== false);
  window.Buddy.ideaSource = ideas;
  setInterval(renderHero, 30000);
  setInterval(render, 60000); // keeps "x min ago" texts fresh
})();
