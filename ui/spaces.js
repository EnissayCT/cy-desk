/* Spaces: Claude, Servers, Money, Health, and one per project. Opening one makes the stage take
   the whole dashboard: the side columns fold away, Cy stands up in the middle (bigger), and two
   panels open on either side of it. Uses the renderer state from app.js (C, S, T, AGENTS…). */
(function () {
  const body = document.body;
  const L = $('#spaceLeft'), R = $('#spaceRight');
  let cur = null;               // { name, id }
  let usage = null, cstatus = null, money = null, healthData = null, agentFilter = 'all';

  // ---------------------------------------------------------------- helpers
  const fmtTok = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n || 0)));
  const shortDay = (k) => new Date(`${k}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 2);
  const longDay = (k) => new Date(`${k}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
  const lastDays = (n) => { const out = []; for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(Date.now() - i * 86400000))); return out; };
  const head = (ic, title, sub, extra = '') => `<header class="sp-head"><div class="sp-ic">${icon(ic)}</div><div class="sp-title"><h2>${esc(title)}</h2><p>${sub}</p></div>${extra}</header>`;
  const kpi = (value, label, ic, cls = '') => `<div class="sp-kpi ${cls}"><b>${value}</b><span>${icon(ic)}${esc(label)}</span></div>`;
  const card = (title, inner, extra = '', cls = '') => `<section class="sp-card ${cls}"><header><h3>${title}</h3>${extra}</header>${inner}</section>`;
  const closeBtn = `<button class="icon-btn sp-x" data-act="close" data-tip="Back to the overview (Esc)">${icon('x')}</button>`;
  // Vertical bars; each item { v, label, tip, cls }. goal draws a dashed line at that value.
  function bars(list, { goal = null, h = 7.5 } = {}) {
    const max = Math.max(1, goal || 0, ...list.map((x) => x.v || 0));
    return `<div class="bars" style="--h:${h}rem">${goal ? `<em class="goal" style="bottom:${(goal / max) * 100}%"></em>` : ''}${list.map((x) =>
      `<div class="bar ${x.cls || ''}" data-tip="${esc(x.tip || '')}"><i style="height:${Math.max(x.v ? 3 : 0, (x.v / max) * 100)}%"></i><span>${esc(x.label || '')}</span></div>`).join('')}</div>`;
  }
  function hbars(list, fmt = (v) => fmtN(v)) {
    const max = Math.max(1, ...list.map((x) => x.v));
    return `<div class="hbars">${list.map((x) => `<div class="hbar" ${x.tip ? `data-tip="${esc(x.tip)}"` : ''}><span>${esc(x.label)}</span><i><b class="${x.cls || ''}" style="width:${Math.max(2, (x.v / max) * 100)}%"></b></i><em>${fmt(x.v)}</em></div>`).join('')}</div>`;
  }
  function spark(points, cls = '') {
    if (!points || points.length < 2) return '<div class="spark empty">collecting…</div>';
    const vs = points.map((p) => p[1]), min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
    const d = vs.map((v, i) => `${((i / (vs.length - 1)) * 100).toFixed(1)},${(28 - ((v - min) / span) * 24).toFixed(1)}`).join(' ');
    return `<svg class="spark ${cls}" viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points="${d}"/></svg>`;
  }
  const emptyState = (text) => `<div class="empty">${esc(text)}</div>`;

  // ---------------------------------------------------------------- open / close
  const LINES = {
    claude: () => { const n = AGENTS.filter((a) => a.status === 'question' || a.status === 'blocked').length; return n ? `${n} Claude session${n > 1 ? 's are' : ' is'} waiting for you.` : 'Your Claude corner. Everyone is busy or done.'; },
    servers: () => 'Here is everything I keep an eye on.',
    money: () => pick(['Let us look at the money.', 'Wallet time. No judging.', 'Counting coins with you.']),
    health: () => pick(['How are you doing, really?', 'Body check. Water, breaks, mood.', 'You matter more than the servers.']),
    project: (id) => { const it = items.get(id); return it ? `${it.item.name}. Let us see how it is going.` : ''; }
  };
  function open(name, id = null) {
    if (name === 'project' && !items.has(id)) return;
    const was = cur;
    cur = { name, id };
    if (name !== 'project') { try { localStorage.setItem('cy.space', name); } catch {} }
    body.classList.add('space');
    body.dataset.openSpace = name;
    document.querySelectorAll('.nav-btn[data-space]').forEach((b) => b.classList.toggle('on', b.dataset.space === name));
    document.querySelectorAll('[data-nav="overview"]').forEach((b) => b.classList.remove('on'));
    $('#spacePanel').setAttribute('aria-hidden', 'false');
    hideTip();
    render(true);
    load(name);
    window.Buddy.setSpace(name, LINES[name] ? LINES[name](id) : '');
    if (!was) setTimeout(() => window.Buddy.relayout(), 700);
  }
  function close() {
    if (!cur) return;
    cur = null;
    body.classList.remove('space');
    delete body.dataset.openSpace;
    $('#spacePanel').setAttribute('aria-hidden', 'true');
    document.querySelectorAll('.nav-btn[data-space]').forEach((b) => b.classList.remove('on'));
    document.querySelectorAll('[data-nav="overview"]').forEach((b) => b.classList.add('on'));
    hideTip();
    window.Buddy.setSpace(null);
    setTimeout(() => { L.innerHTML = ''; R.innerHTML = ''; window.Buddy.relayout(); }, 650);
  }
  const toggle = (name) => (cur && cur.name === name ? close() : open(name));

  // Async data per space; renders again when it arrives.
  async function load(name) {
    if (name === 'claude') {
      [usage, cstatus] = await Promise.all([window.cy.claudeUsage(false), window.cy.claudeStatus()]);
    } else if (name === 'money') money = await window.cy.ledger();
    else if (name === 'health') healthData = await window.cy.health();
    else return;
    if (cur && cur.name === name) render(false);
  }

  function render(entering) {
    if (!cur || !C || !S) return;
    // Don't redraw under someone typing in a form.
    const active = document.activeElement;
    if (!entering && active && $('#spacePanel').contains(active) && /INPUT|SELECT|TEXTAREA/.test(active.tagName)) return;
    const f = { claude: claudeSpace, servers: serversSpace, money: moneySpace, health: healthSpace, project: projectSpace }[cur.name];
    const [left, right] = f(cur.id);
    const keepL = L.scrollTop, keepR = R.scrollTop;
    L.innerHTML = left; R.innerHTML = right;
    if (!entering) { L.scrollTop = keepL; R.scrollTop = keepR; }
    else { L.scrollTop = 0; R.scrollTop = 0; L.classList.add('enter'); R.classList.add('enter'); setTimeout(() => { L.classList.remove('enter'); R.classList.remove('enter'); }, 900); }
    fadeEdges(L); fadeEdges(R);
  }
  function refresh() { if (cur) render(false); }

  // ---------------------------------------------------------------- Claude
  const AGENT_TAGS = { question: ['accent', 'Needs you'], blocked: ['warn', 'Blocked'], working: ['info', 'Working'], done: ['ok', 'Done'], stopped: ['muted', 'Stopped'] };
  function agentRows(list, limit = 8) {
    return list.slice(0, limit).map((a) => {
      const [cls, label] = AGENT_TAGS[a.status] || AGENT_TAGS.stopped;
      const i = AGENTS.indexOf(a);
      return `<button class="sp-row agent" data-agent="${i}"><div class="sp-row-main"><b>${a.status === 'working' ? '<i class="spin-dot"></i>' : ''}${esc(a.title)}</b>
        <small>${esc(a.project)} · ${esc(ago(a.lastAt))}${a.tool ? ` · waiting on ${esc(a.tool)}` : ''}</small><p>${esc(a.preview)}</p></div><span class="tag ${cls}">${label}</span></button>`;
    }).join('') || emptyState('No Claude Code sessions in the last 3 days.');
  }
  function claudeSpace() {
    const u = usage || { perDay: {}, models: {}, folders: {}, sessions: 0 };
    const days = lastDays(14), today = u.perDay[days[13]] || {};
    const waiting = AGENTS.filter((a) => a.status === 'question' || a.status === 'blocked');
    const outWeek = days.slice(7).reduce((s, k) => s + ((u.perDay[k] || {}).out || 0), 0);
    const filt = { all: () => true, you: (a) => a.status === 'question' || a.status === 'blocked', working: (a) => a.status === 'working', done: (a) => a.status === 'done' || a.status === 'stopped' }[agentFilter];
    const st = cstatus || {};
    const folders = [];
    for (const [it, g] of [...items.values()].map((x) => [x.item, x.group])) { const dir = itemFolder(it, g); if (dir && !folders.some((f) => f.dir === dir)) folders.push({ dir, name: it.name }); }
    const left = head('bot', 'Claude', usage ? `Claude Code${st.version ? ` ${esc(st.version)}` : ''} · ${u.sessions} session${u.sessions === 1 ? '' : 's'} in 14 days` : 'Reading your transcripts…') +
      `<div class="sp-kpis">${kpi(fmtN(waiting.length), 'Waiting on you', 'message-circle', waiting.length ? 'hot' : '')}${kpi(fmtN(today.prompts || 0), 'Prompts today', 'terminal')}${kpi(fmtTok(today.out || 0), 'Tokens out today', 'zap')}${kpi(fmtTok(outWeek), 'Out, last 7 days', 'chart-column')}</div>` +
      card('Sessions', `<div class="chips">${[['all', 'All'], ['you', 'Needs you'], ['working', 'Working'], ['done', 'Done']].map(([k, l]) => `<button class="chip ${agentFilter === k ? 'on' : ''}" data-act="agents:${k}">${l}</button>`).join('')}</div>
        <div class="sp-list">${agentRows(AGENTS.filter(filt))}</div>`) +
      card('Start a session', folders.length ? `<div class="sp-form"><select id="spNewDir">${folders.map((f) => `<option value="${esc(f.dir)}">${esc(f.name)}</option>`).join('')}</select>
        <button class="btn-dark sm" data-act="claude:new">${icon('square-terminal')}New Claude session</button></div><small class="sp-note">Opens a terminal in that folder with <code>claude</code> running.</small>`
        : emptyState('Add project folders in Settings to start sessions from here.'));
    const models = Object.entries(u.models || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const tops = Object.entries(u.folders || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const right = `<div class="sp-tools">${closeBtn}</div>` +
      card('Usage, last 14 days', usage ? bars(days.map((k, i) => { const d = u.perDay[k] || {}; return { v: d.out || 0, label: shortDay(k), cls: i === 13 ? 'now' : '',
        tip: `${longDay(k)}: ${fmtTok(d.out || 0)} tokens out, ${fmtN(d.prompts || 0)} prompts, ${fmtN(d.msgs || 0)} replies, ${fmtTok(d.cacheRead || 0)} read from cache` }; })) + '<small class="sp-note">Output tokens per day, from the transcripts on this computer.</small>'
        : '<div class="skeleton"></div>', '', 'wide') +
      card('Models', models.length ? hbars(models.map(([m, v]) => ({ label: m.replace(/^claude-/, ''), v })), fmtTok) : emptyState('No usage yet.')) +
      card('Where you work', tops.length ? hbars(tops.map(([dir, v]) => ({ label: dir.split(/[\\/]/).filter(Boolean).pop(), v, tip: dir })), (v) => `${v} prompts`) : emptyState('No sessions yet.')) +
      card('Connection', `<div class="conn">
        <div class="conn-row"><i class="dot ${st.installed ? 'ok' : 'bad'}"></i><div><b>Claude Code</b><small>${st.installed ? `Installed${st.version ? `, version ${esc(st.version)}` : ''}` : 'Not found on the PATH: install it from claude.com/code'}</small></div></div>
        <div class="conn-row"><i class="dot ${st.transcripts ? 'ok' : 'warn'}"></i><div><b>Session transcripts</b><small>${st.transcripts ? 'Read locally for the agents board and usage' : 'None yet: run a session first'}</small></div></div>
        <div class="conn-row"><i class="dot ${st.mcp ? 'ok' : ''}"></i><div><b>CY Desk tools in Claude</b><small>${st.mcp ? 'Connected: sessions can read and add your to-dos' : 'Let sessions read and add to-dos, check servers, log expenses'}</small></div>
          <button class="btn-${st.mcp ? 'ghost' : 'dark'} sm" data-act="claude:connect" ${st.installed ? '' : 'disabled'}>${icon('plug-zap')}${st.mcp ? 'Reconnect' : 'Connect'}</button></div>
        <div class="conn-row"><i class="dot ${st.claudeMd ? 'ok' : ''}"></i><div><b>Note in CLAUDE.md</b><small>${st.claudeMd ? 'Sessions know to log only important to-dos' : 'Tells sessions what is worth a to-do (and never secrets)'}</small></div>
          <button class="btn-ghost sm" data-act="claude:md:${st.claudeMd ? 'off' : 'on'}">${st.claudeMd ? 'Remove' : 'Add'}</button></div>
        <small class="sp-note conn-msg" id="connMsg"></small></div>`);
    return [left, right];
  }

  // ---------------------------------------------------------------- Servers
  function serverCard(id, alerts) {
    const def = C.servers[id], s = srv(id), d = data(id), st = serverState(id, alerts);
    const h = d && d.host;
    const mem = h && h.memTotal ? Math.round(100 * (1 - h.memAvail / h.memTotal)) : null;
    const disk = h && h.diskTotal ? Math.round((100 * (h.diskTotal - h.diskFree)) / h.diskTotal) : null;
    const mine = alerts.filter((a) => a.scope === id);
    const chips = [];
    for (const x of (d && d.services) || []) chips.push(`<span class="tag ${x.state === 'active' ? 'ok' : 'bad'}">${esc(x.name)}</span>`);
    for (const x of (d && d.containers) || []) if (!def.containers || !def.containers.length || def.containers.includes(x.name)) chips.push(`<span class="tag ${x.state === 'running' ? 'ok' : 'bad'}">${icon('box')}${esc(x.name)}</span>`);
    for (const x of (d && d.pm2) || []) chips.push(`<span class="tag ${x.status === 'online' ? 'ok' : 'bad'}">${esc(x.name)}</span>`);
    const extra = def.probe === 'odoo' && d ? `<div class="srv-facts"><span>${icon('users')}${fmtN(d.users)} online</span><span>${icon('gauge')}${(d.httpTime || 0).toFixed(2)} s login page</span><span>${icon('database')}${d.dbSize ? `${(d.dbSize / 1e9).toFixed(1)} GB` : '—'}</span>${d.backupAt ? `<span>${icon('history')}backup ${ago(d.backupAt)}</span>` : ''}</div>`
      : def.probe === 'plugins' && d ? `<div class="srv-facts"><span>${icon('shopping-bag')}${fmtN(d.activeShops)} shops</span><span>${icon('package')}${fmtN(d.today)} parcels today</span></div>${d.trend && d.trend.length ? bars(d.trend.map((x) => ({ v: x.n, label: x.day.slice(8), tip: `${x.day}: ${fmtN(x.n)} parcels` })), { h: 4 }) : ''}` : '';
    return `<section class="sp-card srv-card ${st.cls}"><header><h3><i class="dot ${st.cls}"></i>${esc(def.name || id)}</h3><span class="tag ${st.cls === 'ok' ? 'ok' : st.cls === 'warn' ? 'warn' : st.cls === 'bad' ? 'bad' : 'muted'}">${esc(st.label)}</span></header>
      <p class="srv-sub">${esc(def.sub || def.host)}${s && s.ms ? ` · checked in ${(s.ms / 1000).toFixed(1)} s` : ''}${s && !s.ok && s.error ? ` · ${esc(s.error)}` : ''}</p>
      ${h ? `<div class="srv-meters">
        <div><span>Load</span><b>${h.load[0] !== undefined ? h.load[0].toFixed(2) : '—'}<small>/${h.cpus || '?'} cpu</small></b>${spark(S.history[`${id}.load`])}</div>
        <div><span>Memory</span><b>${mem !== null ? `${mem}%` : '—'}</b><div class="meter"><i class="${mem >= 90 ? 'warn' : ''}" style="width:${mem || 0}%"></i></div></div>
        <div><span>Disk</span><b>${h.diskFree !== null ? `${h.diskFree} GB free` : '—'}</b><div class="meter"><i class="${disk >= 90 ? 'warn' : ''}" style="width:${disk || 0}%"></i></div></div>
        <div><span>Up for</span><b>${h.uptime ? fmtUptime(h.uptime) : '—'}</b></div></div>` : ''}
      ${extra}${chips.length ? `<div class="chips tight">${chips.join('')}</div>` : ''}
      ${mine.length ? `<div class="srv-alerts">${mine.map((a) => `<div class="a-row"><i class="dot ${a.level}"></i><div>${esc(a.text)}${a.sub ? `<small>${esc(a.sub)}</small>` : ''}</div></div>`).join('')}</div>` : ''}</section>`;
  }
  const fmtUptime = (s) => (s > 86400 ? `${Math.floor(s / 86400)} d` : `${Math.floor(s / 3600)} h`);
  function serversSpace() {
    const checks = computeChecks(), alerts = alertsOf(checks), ok = checks.filter((c) => c.ok).length;
    const ids = Object.keys(C.servers);
    const up = ids.filter((id) => srv(id) && srv(id).ok).length;
    const sitesUp = C.sites.filter((s) => S.sites[s.id] && S.sites[s.id].ok).length;
    const left = head('server', 'Servers', `${ok} of ${checks.length} checks passing · updated ${esc(ago(S.refreshedAt))}`) +
      `<div class="sp-kpis">${kpi(`${checks.length ? Math.round((ok / checks.length) * 100) : 0}%`, 'Checks passing', 'shield-check', alerts.some((a) => a.level === 'bad') ? 'bad' : alerts.length ? 'hot' : '')}${kpi(`${up}/${ids.length}`, 'Servers up', 'server')}${kpi(`${sitesUp}/${C.sites.length}`, 'Sites up', 'globe')}${kpi(fmtN(alerts.length), 'Alerts', 'bell', alerts.length ? 'hot' : '')}</div>` +
      card('Alerts', alerts.length ? alerts.map((a) => `<div class="a-row"><i class="dot ${a.level}"></i><div>${esc(a.text)}${a.sub ? `<small>${esc(a.sub)}</small>` : ''}</div></div>`).join('')
        : `<div class="a-row"><i class="dot ok"></i><div>All systems normal<small>Next check in about ${C.refreshMinutes || 2} min</small></div></div>`, `<button class="btn-ghost sm" data-act="refresh">${icon('refresh-cw')}Check now</button>`) +
      card('Websites', C.sites.length ? C.sites.map((s) => { const r = S.sites[s.id]; const cd = r && r.certExpires ? days(r.certExpires) : null;
        return `<div class="site-row"><i class="dot ${!r ? '' : r.ok ? 'ok' : 'bad'}"></i><div><b>${esc(s.host)}</b><small>${!r ? 'not checked yet' : r.ok ? `HTTP ${r.code} · ${r.ms} ms` : esc(r.error || `HTTP ${r.code}`)}</small></div>
          ${cd !== null ? `<span class="tag ${cd < 7 ? 'bad' : cd < 20 ? 'warn' : 'muted'}" data-tip="TLS certificate expiry">${icon('lock')}${cd} d</span>` : ''}</div>`; }).join('') : emptyState('No websites yet. Add them in Settings.'));
    const right = `<div class="sp-tools">${closeBtn}</div>` + (ids.length ? ids.map((id) => serverCard(id, alerts)).join('') : card('No servers yet', emptyState('Add a server in Settings: CY Desk connects over SSH with your key and only runs read-only checks.')));
    return [left, right];
  }

  // ---------------------------------------------------------------- Money
  function moneyFmt(v, cur) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v); } catch { return `${fmtN(Math.round(v))} ${cur}`; }
  }
  function moneySpace() {
    if (!money) return [head('wallet', 'Money', 'Opening your ledger…') + '<div class="skeleton"></div>', `<div class="sp-tools">${closeBtn}</div>`];
    const m = money, cur = m.currency, f = (v) => moneyFmt(v, cur);
    const month = dayKey(new Date()).slice(0, 7);
    const inMonth = m.entries.filter((e) => e.date.startsWith(month));
    const spent = inMonth.filter((e) => e.kind === 'out').reduce((s, e) => s + e.amount, 0);
    const earned = inMonth.filter((e) => e.kind === 'in').reduce((s, e) => s + e.amount, 0);
    const monthly = m.recurring.reduce((s, r) => s + (r.every === 'year' ? r.amount / 12 : r.amount), 0);
    const left = head('wallet', 'Money', `${new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} · your own ledger, stored on this computer`,
      `<select class="sp-cur" data-act="money:currency">${['USD', 'EUR', 'GBP', 'MAD', 'CAD', 'CHF', 'JPY', 'INR', 'AUD'].concat(['USD', 'EUR', 'GBP', 'MAD', 'CAD', 'CHF', 'JPY', 'INR', 'AUD'].includes(cur) ? [] : [cur]).map((c) => `<option ${c === cur ? 'selected' : ''}>${c}</option>`).join('')}</select>`) +
      `<div class="sp-kpis">${kpi(f(spent), 'Spent this month', 'trending-down')}${kpi(f(earned), 'Earned this month', 'trending-up')}${kpi(f(earned - spent), 'Balance', 'piggy-bank', earned - spent < 0 ? 'bad' : '')}${kpi(m.budget ? f(Math.max(0, m.budget - spent)) : '—', m.budget ? 'Left in budget' : 'No budget set', 'target', m.budget && spent > m.budget ? 'bad' : '')}</div>` +
      card('Add', `<form class="money-form" id="moneyForm" autocomplete="off">
          <div class="seg2"><button type="button" class="${moneyKind === 'out' ? 'on' : ''}" data-act="money:kind:out">${icon('minus')}Expense</button><button type="button" class="${moneyKind === 'in' ? 'on' : ''}" data-act="money:kind:in">${icon('plus')}Income</button></div>
          <input id="mAmount" type="number" min="0" step="0.01" placeholder="Amount (${esc(cur)})" required>
          <select id="mCat">${(m.categories[moneyKind] || []).map((c) => `<option>${esc(c)}</option>`).join('')}</select>
          <input id="mNote" placeholder="What for? (optional)" maxlength="120">
          <input id="mDate" type="date" value="${dayKey(new Date())}">
          <button class="btn-dark sm" type="submit">${icon('check')}Add</button></form>`) +
      card('Recent', `<div class="sp-list">${m.entries.slice().sort((a, b) => (b.date + b.created).localeCompare(a.date + a.created)).slice(0, 12).map((e) =>
        `<div class="money-row"><i class="mk ${e.kind}">${icon(e.kind === 'in' ? 'trending-up' : 'receipt')}</i><div><b>${esc(e.note || e.category)}</b><small>${esc(e.category)} · ${esc(new Date(`${e.date}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))}</small></div>
          <em class="${e.kind}">${e.kind === 'in' ? '+' : '−'}${f(e.amount)}</em><button class="act-x" data-act="money:del:${esc(e.id)}" data-tip="Delete">${icon('trash-2')}</button></div>`).join('') || emptyState('Nothing logged yet. Add your first expense above, or ask Claude to log one.')}</div>`);
    // Right: by category, six months, recurring.
    const byCat = {};
    for (const e of inMonth) if (e.kind === 'out') byCat[e.category] = (byCat[e.category] || 0) + e.amount;
    const months = [];
    for (let i = 5; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }
    const right = `<div class="sp-tools">${closeBtn}</div>` +
      card('This month by category', Object.keys(byCat).length ? hbars(Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([label, v]) => ({ label, v })), f) : emptyState('No expenses this month.'),
        m.budget ? `<span class="tag ${spent > m.budget ? 'bad' : 'muted'}">budget ${f(m.budget)}</span>` : `<button class="btn-ghost sm" data-act="money:budget">${icon('target')}Set budget</button>`) +
      card('Last 6 months', `<div class="duo">${bars(months.map((mk) => { const o = m.entries.filter((e) => e.kind === 'out' && e.date.startsWith(mk)).reduce((s, e) => s + e.amount, 0);
        const label = new Date(`${mk}-15T12:00:00`).toLocaleDateString('en-GB', { month: 'short' });
        return { v: o, label, cls: mk === month ? 'now' : '', tip: `${label}: spent ${f(o)}, earned ${f(m.entries.filter((e) => e.kind === 'in' && e.date.startsWith(mk)).reduce((s, e) => s + e.amount, 0))}` }; }), { goal: m.budget || null, h: 6.5 })}</div>
        <small class="sp-note">Spent per month${m.budget ? '; the dashed line is your budget' : ''}. Hover a month for income.</small>`, '', 'wide') +
      card(`Recurring <span class="sp-count">${f(monthly)}/month</span>`, `<div class="sp-list">${m.recurring.map((r) => { const next = nextDue(r);
        return `<div class="money-row"><i class="mk rec">${icon('repeat')}</i><div><b>${esc(r.name)}</b><small>${esc(r.category)} · every ${r.every} · next ${esc(next)}</small></div><em class="out">${f(r.amount)}</em><button class="act-x" data-act="money:del:${esc(r.id)}" data-tip="Delete">${icon('trash-2')}</button></div>`; }).join('') || emptyState('Subscriptions, servers, rent: add what comes back every month.')}</div>
        <form class="money-form rec" id="recForm" autocomplete="off"><input id="rName" placeholder="Name (e.g. Claude Max)" maxlength="40" required><input id="rAmount" type="number" min="0" step="0.01" placeholder="Amount" required>
          <select id="rEvery"><option value="month">Monthly</option><option value="year">Yearly</option></select><input id="rDay" type="number" min="1" max="28" placeholder="Day" value="1"><button class="btn-ghost sm" type="submit">${icon('plus')}Add</button></form>`);
    return [left, right];
  }
  let moneyKind = 'out';
  function nextDue(r) {
    const d = new Date(), t = new Date(d.getFullYear(), d.getMonth(), r.day);
    if (t < new Date(d.getFullYear(), d.getMonth(), d.getDate())) t.setMonth(t.getMonth() + (r.every === 'year' ? 12 : 1));
    const n = Math.round((t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    return n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
  }

  // ---------------------------------------------------------------- Health
  const MOODS = [[1, 'angry', 'Rough'], [2, 'frown', 'Meh'], [3, 'meh', 'Okay'], [4, 'smile', 'Good'], [5, 'laugh', 'Great']];
  function healthSpace() {
    if (!healthData) return [head('heart-pulse', 'Health', 'Checking on you…') + '<div class="skeleton"></div>', `<div class="sp-tools">${closeBtn}</div>`];
    const hd = healthData, t = hd.today, g = hd.goals;
    const v = VITALS || {};
    const left = head('heart-pulse', 'Health', 'Screen time and breaks come from keyboard and mouse activity only. The rest is what you log.') +
      `<div class="sp-kpis">${kpi(fmtMin(Math.round(t.activeMin)), 'At the screen today', 'monitor', t.activeMin > g.activeMax ? 'hot' : '')}${kpi(fmtN(t.breaks), 'Breaks (5 min+)', 'coffee')}${kpi(fmtMin(Math.max(t.longest, hd.stretchMin || 0)), 'Longest stretch', 'hourglass', t.longest >= 120 ? 'hot' : '')}${kpi(`${t.water}/${g.water}`, 'Glasses of water', 'glass-water', t.water >= g.water ? 'good' : '')}</div>` +
      card('Water', `<div class="water">${Array.from({ length: Math.max(g.water, t.water) }, (_, i) => `<button class="glass ${i < t.water ? 'full' : ''}" data-act="health:water:${i < t.water ? 'minus' : 'plus'}" data-tip="${i < t.water ? 'Remove a glass' : 'I drank a glass'}">${icon('glass-water')}</button>`).join('')}</div>
        <small class="sp-note">${t.water >= g.water ? 'Goal reached. Cy is proud of you.' : `${g.water - t.water} to go today.`}</small>`) +
      card('Mood', `<div class="moods">${MOODS.map(([n, ic, label]) => `<button class="mood ${t.mood === n ? 'on' : ''}" data-act="health:mood:${n}">${icon(ic)}<span>${label}</span></button>`).join('')}</div>
        <div class="mood-week">${hd.days.slice(-7).map((d) => `<span data-tip="${esc(longDay(d.day))}: ${d.mood ? MOODS[d.mood - 1][2] : 'not logged'}"><i class="m${d.mood || 0}"></i>${shortDay(d.day)}</span>`).join('')}</div>`) +
      card('Move', `<div class="move"><div><b>${fmtN(t.stretches)}</b><small>stretches today</small></div><button class="btn-dark sm" data-act="health:stretch">${icon('footprints')}I stretched</button></div>
        <small class="sp-note">${SETTINGS.breaks !== false ? `Cy suggests a break after ${fmtMin(SETTINGS.breakMin || 90)} of work.` : 'Break reminders are off (Settings).'}</small>`);
    const right = `<div class="sp-tools">${closeBtn}</div>` +
      card('Screen time, 14 days', bars(hd.days.map((d, i) => ({ v: Math.round(d.activeMin), label: shortDay(d.day), cls: i === hd.days.length - 1 ? 'now' : d.activeMin > g.activeMax ? 'over' : '',
        tip: `${longDay(d.day)}: ${fmtMin(Math.round(d.activeMin))} at the screen, ${d.breaks} break${d.breaks === 1 ? '' : 's'}, ${d.water} glass${d.water === 1 ? '' : 'es'} of water` })), { goal: g.activeMax }) +
        `<small class="sp-note">The dashed line is your daily limit (${fmtMin(g.activeMax)}).</small>`, `<select class="sp-cur" data-act="health:max">${[240, 360, 480, 600].map((m) => `<option value="${m}" ${m === g.activeMax ? 'selected' : ''}>${fmtMin(m)} limit</option>`).join('')}</select>`, 'wide') +
      card('Bedtime', `<div class="bed"><div><b>${esc(g.bedtime)}</b><small>Cy yawns and reminds you 30 minutes before.</small></div><input type="time" id="bedtime" value="${esc(g.bedtime)}" data-act="health:bedtime"></div>`) +
      card('This PC', v.cpu !== undefined ? `<div class="srv-meters two">
        <div><span>CPU</span><b>${v.cpu}%</b><div class="meter"><i class="${v.cpu >= 85 ? 'warn' : ''}" style="width:${v.cpu}%"></i></div></div>
        <div><span>Memory</span><b>${v.mem}%</b><div class="meter"><i class="${v.mem >= 90 ? 'warn' : ''}" style="width:${v.mem}%"></i></div></div>
        ${v.disk ? `<div><span>Disk</span><b>${v.disk.free} GB free</b><div class="meter"><i style="width:${Math.round(100 - (100 * v.disk.free) / v.disk.total)}%"></i></div></div>` : ''}
        ${BATTERY ? `<div><span>Battery</span><b>${Math.round(BATTERY.level * 100)}%${BATTERY.charging ? ' ⚡' : ''}</b><div class="meter"><i style="width:${Math.round(BATTERY.level * 100)}%"></i></div></div>` : ''}</div>` : emptyState('Measuring…'));
    return [left, right];
  }

  // ---------------------------------------------------------------- a project
  let projectId = null;
  function projectSpace(id) {
    projectId = id;
    const { item: it, group } = items.get(id);
    const g = S.git[it.id] || {};
    const A = S.activity || {};
    const per = (A.perItem || {})[it.id] || {};
    const folder = itemFolder(it, group);
    const mine = T.items.filter((t) => t.item === it.id);
    const open = mine.filter((t) => !t.done), done = mine.filter((t) => t.done).sort((a, b) => Date.parse(b.doneAt || 0) - Date.parse(a.doneAt || 0)).slice(0, 5);
    const commits16 = Object.values(per).reduce((s, n) => s + n, 0);
    const focused = (FOCUS_WEEK.per || {})[it.id] || 0;
    const acts = [];
    if (it.session) acts.push(`<button class="btn-dark sm" data-session="${esc(it.session)}">${icon('message-circle')}Open chat</button>`);
    if (folder) acts.push(`<button class="btn-${it.session ? 'ghost' : 'dark'} sm" data-claude="${esc(folder)}">${icon('square-terminal')}New Claude here</button>`, `<button class="btn-ghost sm" data-folder="${esc(folder)}">${icon('folder')}Folder</button>`);
    if (it.url) acts.push(`<button class="btn-ghost sm" data-url="${esc(it.url)}">${icon('external-link')}Website</button>`);
    const ver = g.version || it.version;
    const tags = [];
    if (it.stage) tags.push(`<span class="tag ${it.stage === 'live' ? 'ok' : it.stage === 'beta' ? 'info' : 'accent'}">${esc(it.stage)}</span>`);
    if (it.status) tags.push(`<span class="tag ${STATUS_TAG[it.status] || 'muted'}">${esc(STATUS_LABEL[it.status] || it.status)}</span>`);
    if (ver) tags.push(`<span class="tag muted">${esc(/^\d/.test(ver) ? `v${ver}` : ver)}</span>`);
    if (g.dirty) tags.push(`<span class="tag warn">${g.dirty} uncommitted</span>`);
    const left = `<header class="sp-head project"><div class="sp-ic">${icon('folder')}</div><div class="sp-title"><small class="sp-group">${esc(group.name)}</small><h2 id="dTitle">${esc(it.name)}</h2>
        <p>${esc(it.tagline || (it.paths && it.paths.length ? it.paths.join(' · ') : folder || ''))}</p></div></header>
      <div class="sp-tags">${tags.join('')}</div><div class="sp-actions" id="dActions">${acts.join('')}</div>` +
      `<div class="sp-kpis">${kpi(fmtN(open.length), 'Open tasks', 'list-todo', open.length ? 'hot' : '')}${kpi(fmtN(commits16), 'Commits, 16 weeks', 'git-commit-horizontal')}${kpi(g.lastAt ? ago(g.lastAt) : '—', 'Last commit', 'clock')}${kpi(focused ? fmtMin(focused) : '0 min', 'Focused this week', 'timer')}</div>` +
      card(`To-do <span class="sp-count" id="dCount">${open.length || ''}</span>`, `<ul class="todo-list" id="dTodos">${open.length ? open.map((t) => todoRow(t, true)).join('') : '<li class="empty">No open tasks. Add one below.</li>'}</ul>
        <form id="dAdd" autocomplete="off"><input id="dAddText" placeholder="Add a task to ${esc(it.name)}…" maxlength="300"></form>
        ${done.length ? `<h4 class="sp-sub">Done recently</h4><ul class="todo-list done" id="dDone">${done.map((t) => todoRow(t, false)).join('')}</ul>` : ''}`);
    // Right: activity per week, health, recent commits, Claude sessions.
    const weeks = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const mon = new Date(today); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    for (let w = 15; w >= 0; w--) {
      const s0 = new Date(mon); s0.setDate(s0.getDate() - w * 7);
      let n = 0; for (let i = 0; i < 7; i++) { const x = new Date(s0); x.setDate(x.getDate() + i); n += per[dayKey(x)] || 0; }
      weeks.push({ v: n, label: w % 4 === 0 ? s0.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '', cls: w === 0 ? 'now' : '', tip: `Week of ${s0.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}: ${n} commit${n === 1 ? '' : 's'}` });
    }
    const scopes = groupScopes(group).concat(it.site ? [`site:${it.site}`] : []);
    const alerts = alertsOf(computeChecks()).filter((a) => scopes.includes(a.scope));
    const healthRows = [];
    for (const sid of group.servers || []) { const st = serverState(sid, alertsOf(computeChecks())); healthRows.push(`<div class="site-row"><i class="dot ${st.cls}"></i><div><b>${esc((C.servers[sid] || {}).name || sid)}</b><small>${esc(st.alert ? st.alert.text : serverMetric(sid).row)}</small></div></div>`); }
    for (const sid of new Set((group.sites || []).concat(it.site ? [it.site] : []))) {
      const s = C.sites.find((x) => x.id === sid), r = S.sites[sid];
      if (s) healthRows.push(`<div class="site-row"><i class="dot ${!r ? '' : r.ok ? 'ok' : 'bad'}"></i><div><b>${esc(s.host)}</b><small>${!r ? 'not checked yet' : r.ok ? `up · ${r.ms} ms` : 'down'}</small></div></div>`);
    }
    const sessions = AGENTS.filter((a) => a.item === it.id || (a.project && a.project === it.name));
    const right = `<div class="sp-tools">${closeBtn}</div>` +
      card('Commits per week', commits16 ? bars(weeks, { h: 6 }) : emptyState(folder || it.paths ? 'No commits in the last 16 weeks.' : 'Link a git folder in Settings to see its activity.'), '', 'wide') +
      card(`Health ${alerts.length ? `<span class="sp-count bad">${alerts.length}</span>` : ''}`, healthRows.length ? healthRows.join('') + alerts.map((a) => `<div class="a-row"><i class="dot ${a.level}"></i><div>${esc(a.text)}</div></div>`).join('')
        : emptyState('No servers or sites linked to this project.')) +
      card('Recent commits', (g.recent || []).length ? `<ul class="commits">${g.recent.map((c) => `<li><time>${esc(ago(c.at))}</time><span>${esc(c.subject)}</span></li>`).join('')}</ul>` : emptyState('No commits to show.')) +
      card('Claude sessions', sessions.length ? `<div class="sp-list">${agentRows(sessions, 4)}</div>` : emptyState(folder ? 'No recent sessions here. Start one with "New Claude here".' : 'No recent sessions.'));
    return [left, right];
  }

  // ---------------------------------------------------------------- actions
  async function act(a, el) {
    if (a === 'close') return close();
    if (a === 'refresh') { window.cy.refresh(); window.Buddy.say('Checking everything…', 3000); return; }
    if (a.startsWith('agents:')) { agentFilter = a.slice(7); render(false); return; }
    if (a === 'claude:new') { const dir = $('#spNewDir').value; await window.cy.openClaude(dir); window.Buddy.say('New session coming up.', 3500); return; }
    if (a === 'claude:connect') {
      const m = $('#connMsg'); m.textContent = 'Connecting…'; m.className = 'sp-note conn-msg';
      const r = await window.cy.claudeConnect();
      cstatus = await window.cy.claudeStatus(); render(false);
      const m2 = $('#connMsg'); if (m2) { m2.textContent = r.ok ? 'Connected. New Claude sessions have the cy-desk tools.' : r.error; m2.className = `sp-note conn-msg ${r.ok ? 'ok' : 'bad'}`; }
      if (r.ok) window.Buddy.celebrate('Claude and I are friends now.');
      return;
    }
    if (a.startsWith('claude:md:')) { await window.cy.claudeMd(a.endsWith(':on')); cstatus = await window.cy.claudeStatus(); render(false); return; }
    if (a.startsWith('money:kind:')) { moneyKind = a.slice(11); render(false); return; }
    if (a.startsWith('money:del:')) { money = { ...money, ...(await window.cy.ledgerRemove(a.slice(10))) }; render(false); return; }
    if (a === 'money:budget') {
      // An inline field (Electron has no prompt()).
      el.outerHTML = `<form class="inline-form" id="budgetForm"><input id="budgetVal" type="number" min="0" placeholder="Monthly budget"><button class="btn-dark sm" type="submit">${icon('check')}</button></form>`;
      setTimeout(() => $('#budgetVal') && $('#budgetVal').focus(), 30);
      return;
    }
    if (a.startsWith('health:water:')) {
      healthData = await window.cy.healthLog('water', a.endsWith('plus') ? 1 : -1); render(false);
      if (a.endsWith('plus')) { window.Buddy.run('water'); if (healthData.today.water === healthData.goals.water) setTimeout(() => window.Buddy.celebrate('Water goal reached!'), 3500); }
      return;
    }
    if (a.startsWith('health:mood:')) {
      const n = +a.slice(12); healthData = await window.cy.healthLog('mood', n); render(false);
      if (n <= 2) window.Buddy.react('worried', pick(['Sorry it is a rough one. Small steps today?', 'Want me to keep things quiet for a while?']));
      else if (n >= 4) window.Buddy.celebrate(pick(['Love that!', 'Good days are the best days.']));
      else window.Buddy.say('Okay is okay.', 3000);
      return;
    }
    if (a === 'health:stretch') { healthData = await window.cy.healthLog('stretch'); render(false); window.Buddy.run('stretch'); window.Buddy.say('Stretching with you!', 3000); return; }
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('#spacePanel [data-act]');
    if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
    e.preventDefault();
    act(el.dataset.act, el);
  });
  document.addEventListener('change', async (e) => {
    const el = e.target.closest('#spacePanel [data-act]');
    if (!el) return;
    if (el.dataset.act === 'money:currency') { money = { ...money, ...(await window.cy.ledgerOptions({ currency: el.value })) }; render(false); }
    if (el.dataset.act === 'health:bedtime') { healthData = await window.cy.healthGoals({ bedtime: el.value }); render(false); window.Buddy.say(`Bedtime ${el.value}. I will remind you.`, 3500); }
    if (el.dataset.act === 'health:max') { healthData = await window.cy.healthGoals({ activeMax: +el.value }); render(false); }
  });
  document.addEventListener('submit', async (e) => {
    const id = e.target.id;
    if (!['moneyForm', 'recForm', 'budgetForm'].includes(id)) return;
    e.preventDefault();
    if (id === 'moneyForm') {
      const r = await window.cy.ledgerAdd({ kind: moneyKind, amount: $('#mAmount').value, category: $('#mCat').value, note: $('#mNote').value, date: $('#mDate').value });
      if (!r.ok) { window.Buddy.say(r.error, 3500); return; }
      money = { ...money, ...r.ledger };
      document.activeElement && document.activeElement.blur();
      render(false);
      const spent = money.entries.filter((x) => x.kind === 'out' && x.date.startsWith(dayKey(new Date()).slice(0, 7))).reduce((s, x) => s + x.amount, 0);
      if (r.entry.kind === 'in') window.Buddy.celebrate(pick(['Money in! Nice.', 'Ka-ching!']));
      else if (money.budget && spent > money.budget) window.Buddy.react('worried', 'That puts you over this month\'s budget.');
      else window.Buddy.run('nod');
    } else if (id === 'recForm') {
      const r = await window.cy.ledgerRecurring({ name: $('#rName').value, amount: $('#rAmount').value, every: $('#rEvery').value, day: $('#rDay').value, category: 'Bills' });
      if (!r.ok) { window.Buddy.say(r.error, 3500); return; }
      money = { ...money, ...r.ledger }; document.activeElement && document.activeElement.blur(); render(false);
    } else if (id === 'budgetForm') {
      money = { ...money, ...(await window.cy.ledgerOptions({ budget: $('#budgetVal').value })) }; document.activeElement && document.activeElement.blur(); render(false);
    }
  });
  [L, R].forEach((p) => p.addEventListener('scroll', () => fadeEdges(p)));

  // Health is live (screen time ticks): refresh it every minute while the space is open, and keep
  // an eye on bedtime from anywhere.
  setInterval(async () => {
    if (cur && cur.name === 'health') { healthData = await window.cy.health(); render(false); }
  }, 60000);
  let bedWarned = '';
  setInterval(async () => {
    const hd = healthData || await window.cy.health().catch(() => null);
    if (!hd) return;
    const [hh, mm] = (hd.goals.bedtime || '23:30').split(':').map(Number);
    const now = new Date(), bed = new Date(now); bed.setHours(hh, mm, 0, 0);
    const mins = (bed - now) / 60000, today = dayKey(now);
    if (mins <= 30 && mins > -60 && bedWarned !== today && !FOCUS) {
      bedWarned = today;
      window.Buddy.run('stretch');
      window.Buddy.say(mins > 0 ? `Bedtime in ${Math.round(mins)} minutes. Start wrapping up?` : 'It is past your bedtime. Tomorrow-you says thanks for stopping.', 12000);
    }
  }, 5 * 60000);

  window.Spaces = { open, close, toggle, refresh, current: () => (cur ? cur.name : null), projectId: () => (cur && cur.name === 'project' ? cur.id : null) };
})();
