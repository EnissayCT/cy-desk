/* Overlays: the daily brief, settings, and the first-run setup wizard.
   Uses the renderer state from app.js (C, S, T, SETTINGS, AGENTS…) and window.cy. */
(function () {
  const modal = $('#modal'), scrim = $('#modalScrim');
  let onClose = null;
  function open(html, cls = '', closeFn = null) {
    modal.className = `modal on ${cls}`;
    modal.innerHTML = html;
    scrim.classList.add('on');
    onClose = closeFn;
    modal.querySelectorAll('[data-icon]').forEach((i) => { i.outerHTML = icon(i.dataset.icon); });
  }
  function close() {
    modal.className = 'modal'; scrim.classList.remove('on');
    const f = onClose; onClose = null; if (f) f();
  }
  scrim.addEventListener('click', () => { if (!modal.classList.contains('wizard')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('on') && !modal.classList.contains('wizard')) close(); });
  const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'x';
  function uniqueId(base, taken) { let id = slug(base), i = 2; while (taken.has(id)) id = `${slug(base)}-${i++}`; return id; }
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ------------------------------------------------------------ daily brief
  async function openBrief(auto = false) {
    open(`<div class="m-head"><div class="m-ic">${icon('sunrise')}</div><div><h2>${esc(greetingWord())}, ${esc(USER)}</h2><p>${esc(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))} · your daily brief</p></div>
      <button class="icon-btn m-x" data-close>${icon('x')}</button></div><div class="m-body"><div class="empty">Reading your git history…</div></div>`, 'brief');
    const b = await window.cy.buildBrief(alertsOf(computeChecks()).map((a) => ({ level: a.level, text: a.text })));
    const checks = computeChecks(), ok = checks.filter((c) => c.ok).length;
    const o = dataOf('odoo');
    const up = [];
    if (o && o.backupNext) up.push(`Backup in ${Math.max(0, days(o.backupNext))} d`);
    if (o && o.certs && o.certs.length) { const c = o.certs.reduce((x, y) => (x.expires < y.expires ? x : y)); up.push(`${c.name} cert ${days(c.expires)} d`); }
    modal.querySelector('.m-body').innerHTML = `
      <div class="b-stats">
        <div><b>${b.totalCommits}</b><span>commits · ${esc(b.label.toLowerCase())}</span></div>
        <div><b>${b.done.length}</b><span>tasks done</span></div>
        <div><b>${b.focusMin ? fmtMin(b.focusMin) : '0 min'}</b><span>focused</span></div>
        <div><b>${checks.length ? Math.round((ok / checks.length) * 100) : 0}%</b><span>system health</span></div>
      </div>
      <div class="b-cols">
        <section><h3>${esc(b.label)}</h3>
          ${b.commits.slice(0, 6).map((c) => `<div class="b-row"><span class="p-count">${c.n}</span><div><b>${esc(c.project)}</b><small>${esc(c.subjects[0])}</small></div></div>`).join('') || '<div class="empty">No commits.</div>'}
          ${b.done.slice(0, 4).map((t) => `<div class="b-row"><span class="check on"></span><div><b>${esc(t.text)}</b></div></div>`).join('')}
        </section>
        <section><h3>Today</h3>
          ${b.today.slice(0, 5).map((t) => `<div class="b-row"><span class="dot accent"></span><div><b>${esc(t.text)}</b><small>${esc((items.get(t.item) || { item: { name: t.item } }).item.name)}</small></div></div>`).join('') || '<div class="empty">Nothing pinned yet. Star a few tasks.</div>'}
          ${b.waiting.length ? `<h3 class="sub">Waiting for you</h3>${b.waiting.slice(0, 3).map((a) => `<div class="b-row"><span class="dot warn"></span><div><b>${esc(a.title)}</b><small>${esc(a.preview)}</small></div></div>`).join('')}` : ''}
          ${up.length ? `<h3 class="sub">Coming up</h3><div class="b-up">${up.map((x) => `<span class="tag muted">${esc(x)}</span>`).join('')}</div>` : ''}
        </section>
      </div>
      <div class="m-foot"><button class="btn-dark" id="copyStandup">${icon('clipboard-copy')}Copy standup</button><button class="btn-ghost" data-close>Close</button></div>`;
    modal.querySelector('#copyStandup').onclick = async (e) => {
      const btn = e.currentTarget; // gone from the event once we await
      await window.cy.copy(b.standup);
      btn.innerHTML = `${icon('check')}Copied`;
      window.Buddy.say('Standup copied. Paste away!', 4000);
    };
    if (!auto) window.Buddy.say("Here's your brief.", 3000);
  }
  const greetingWord = () => { const h = new Date().getHours(); return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
  // Once a day, on the first sign of life after 6:00.
  function maybeAutoBrief() {
    const today = dayKey(new Date());
    if (SETTINGS.onboarded === false || SETTINGS.lastBrief === today || new Date().getHours() < 6 || modal.classList.contains('on')) return;
    SETTINGS.lastBrief = today;
    window.cy.setSettings({ lastBrief: today });
    setTimeout(() => { openBrief(true); window.Buddy.run('wave'); window.Buddy.say(`${greetingWord()}! Here's where things stand.`, 6000); }, 1200);
  }
  let lastMove = 0;
  window.cy.on('cursor', () => { const t = Date.now(); if (t - lastMove > 1500) { lastMove = t; maybeAutoBrief(); } });

  // ------------------------------------------------------------ settings
  const PROBES = [['linux', 'Linux server (any)'], ['vps', 'Linux + systemd services'], ['odoo', 'Odoo in Docker (settings: vars)'], ['plugins', 'Shopify app: PM2 + MySQL (settings: vars)']];
  let draft = null, sTab = 'general';
  async function openSettings(tabName = 'general') {
    draft = clone(C); sTab = tabName;
    draft.profile = draft.profile || { name: USER, fullName: USER, role: '' };
    const login = await window.cy.getLogin();
    open(`<div class="m-head"><div class="m-ic">${icon('settings')}</div><div><h2>Settings</h2><p>CY Desk ${esc(window.__version || '')}</p></div><button class="icon-btn m-x" data-close>${icon('x')}</button></div>
      <div class="s-tabs">${['general', 'servers', 'sites', 'projects', 'about'].map((t) => `<button data-stab="${t}" class="${t === sTab ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <div class="m-body s-body" id="sBody"></div>
      <div class="m-foot"><span class="s-msg" id="sMsg"></span><button class="btn-ghost" data-close>Cancel</button><button class="btn-dark" id="sSave">${icon('check')}Save</button></div>`, 'settings');
    modal.dataset.login = login ? '1' : '';
    renderSettings();
    modal.querySelector('#sSave').onclick = saveSettings;
  }
  const field = (label, html, hint = '') => `<label class="fld"><span>${esc(label)}</span>${html}${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
  const sel = (name, opts, value) => `<select data-k="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const toggle = (name, on, label) => `<button class="tgl ${on ? 'on' : ''}" data-tgl="${name}" type="button"><i></i>${esc(label)}</button>`;
  function renderSettings() {
    modal.querySelectorAll('[data-stab]').forEach((b) => b.classList.toggle('on', b.dataset.stab === sTab));
    const body = modal.querySelector('#sBody');
    if (sTab === 'general') {
      body.innerHTML = `<div class="grid2">
        ${field('First name (what Cy calls you)', `<input data-p="name" value="${esc(draft.profile.name || '')}">`)}
        ${field('Full name', `<input data-p="fullName" value="${esc(draft.profile.fullName || '')}">`)}
        ${field('Role line', `<input data-p="role" value="${esc(draft.profile.role || '')}">`, 'Shown under your name, top right.')}
        ${field('Theme', sel('theme', [['auto', 'Follow Windows'], ['light', 'Light'], ['dark', 'Dark']], SETTINGS.theme || 'auto'))}
        ${field('Default focus session', sel('focusMin', [[15, '15 min'], [25, '25 min'], [50, '50 min'], [90, '90 min']], SETTINGS.focusMin || 25))}
        ${field('Suggest a break after', sel('breakMin', [[45, '45 min'], [60, '1 h'], [90, '1 h 30'], [120, '2 h']], SETTINGS.breakMin || 90), 'Counts keyboard and mouse activity; 5 idle minutes reset it.')}
      </div>
      <div class="tgls">${toggle('sing', SETTINGS.sing !== false, 'Cy sings along to music')}${toggle('breaks', SETTINGS.breaks !== false, 'Break reminders')}${toggle('login', modal.dataset.login === '1', 'Start with Windows')}</div>`;
    } else if (sTab === 'servers') {
      const rows = Object.entries(draft.servers).map(([id, s]) => `<div class="s-row" data-sid="${esc(id)}">
          <div><b>${esc(s.name || id)}</b><small>${esc(s.host)} · ${esc((PROBES.find((p) => p[0] === s.probe) || [0, s.probe])[1])}</small></div>
          <span class="s-test" data-testout="${esc(id)}"></span>
          <button class="btn-ghost sm" data-test="${esc(id)}">${icon('plug')}Test</button>
          <button class="btn-ghost sm" data-edit-srv="${esc(id)}">${icon('pencil')}</button>
          <button class="btn-ghost sm" data-del-srv="${esc(id)}">${icon('trash-2')}</button></div>`).join('');
      body.innerHTML = `${rows || '<div class="empty">No servers yet. Add one below: CY Desk connects over SSH with your key and only runs read-only checks.</div>'}
        <div class="s-form" id="srvForm">${srvForm()}</div>`;
    } else if (sTab === 'sites') {
      body.innerHTML = `${draft.sites.map((s, i) => `<div class="s-row"><div><b>${esc(s.host)}</b><small>${esc(s.url)}</small></div><button class="btn-ghost sm" data-del-site="${i}">${icon('trash-2')}</button></div>`).join('') || '<div class="empty">No websites yet.</div>'}
        <div class="s-add">${field('Website address', '<input id="siteUrl" placeholder="https://example.com">', 'Checked every 2 minutes: status, response time and certificate.')}<button class="btn-dark sm" id="addSite">${icon('plus')}Add</button></div>`;
    } else if (sTab === 'projects') {
      body.innerHTML = draft.groups.map((g, gi) => `<div class="s-group">
          <div class="s-ghead"><input class="s-gname" data-gname="${gi}" value="${esc(g.name)}"><small>${g.items.length} project${g.items.length === 1 ? '' : 's'}</small>
            <button class="btn-ghost sm" data-addproj="${gi}">${icon('folder-plus')}Add folder</button>${draft.groups.length > 1 && !g.items.length ? `<button class="btn-ghost sm" data-del-group="${gi}">${icon('trash-2')}</button>` : ''}</div>
          ${g.items.map((it, ii) => `<div class="s-row"><div><input class="s-iname" data-iname="${gi}:${ii}" value="${esc(it.name)}"><small>${esc(it.repo || it.folder || (it.paths || []).join(', ') || 'no folder')}${it.session ? ' · linked to a Claude session' : ''}</small></div>
            ${sel(`status:${gi}:${ii}`, [['', '—'], ['build', 'Build'], ['testing', 'Testing'], ['beta', 'Beta'], ['live', 'Live'], ['review', 'In review']], it.stage || it.status || '')}
            <button class="btn-ghost sm" data-del-proj="${gi}:${ii}">${icon('trash-2')}</button></div>`).join('')}
        </div>`).join('') + `<button class="btn-ghost" id="addGroup">${icon('plus')}New group</button>`;
    } else {
      body.innerHTML = `<div class="about">
        <p><b>CY Desk</b> turns the Windows desktop into a live dashboard with a companion. Everything runs on this computer.</p>
        <ul>
          <li>Servers: one read-only SSH connection per server every 2 minutes, with your own key.</li>
          <li>Claude agents: read from the session transcripts on this disk; nothing is sent anywhere.</li>
          <li>Singing: Windows' volume-mixer levels only. Nothing is recorded.</li>
          <li>This PC: CPU, memory, disk, battery, and input idle time for break reminders.</li>
        </ul>
        <button class="btn-ghost" id="rerunSetup">${icon('rocket')}Run the setup wizard again</button></div>`;
    }
    modal.querySelectorAll('[data-icon]').forEach((i) => { i.outerHTML = icon(i.dataset.icon); });
  }
  let editingSrv = null;
  function srvForm() {
    const s = editingSrv ? draft.servers[editingSrv] : { name: '', host: '', key: '~/.ssh/id_ed25519', probe: 'linux', services: [] };
    return `<h3>${editingSrv ? `Edit ${esc(s.name || editingSrv)}` : 'Add a server'}</h3><div class="grid2">
      ${field('Name', `<input id="fName" value="${esc(s.name || '')}" placeholder="Production">`)}
      ${field('SSH login', `<input id="fHost" value="${esc(s.host || '')}" placeholder="ubuntu@203.0.113.10">`)}
      ${field('Private key', `<div class="row-in"><input id="fKey" value="${esc(s.key || '')}"><button class="btn-ghost sm" id="fKeyPick" type="button">${icon('key-round')}</button></div>`)}
      ${field('What runs there', `<select id="fProbe">${PROBES.map(([v, l]) => `<option value="${v}" ${v === s.probe ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}
      ${field('Services to watch', `<input id="fServices" value="${esc((s.services || []).join(', '))}" placeholder="nginx, postgresql">`, 'systemd unit names, comma separated (Linux types).')}
      ${field('Containers to watch', `<input id="fContainers" value="${esc((s.containers || []).join(', '))}" placeholder="app, db">`, 'Docker container names (Linux server type).')}
    </div><div class="s-formfoot"><span class="s-test" id="fTestOut"></span><button class="btn-ghost sm" id="fTest" type="button">${icon('plug')}Test connection</button>
      ${editingSrv ? `<button class="btn-ghost sm" id="fCancel" type="button">Cancel</button>` : ''}<button class="btn-dark sm" id="fAdd" type="button">${icon(editingSrv ? 'check' : 'plus')}${editingSrv ? 'Update' : 'Add server'}</button></div>`;
  }
  function readSrvForm() {
    const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
    return { name: $('#fName').value.trim(), host: $('#fHost').value.trim(), key: $('#fKey').value.trim(), probe: $('#fProbe').value,
      services: list($('#fServices').value), containers: list($('#fContainers').value) };
  }
  function msg(text, bad = false) { const m = modal.querySelector('#sMsg'); if (m) { m.textContent = text; m.className = `s-msg ${bad ? 'bad' : ''}`; } }
  async function saveSettings() {
    const res = await window.cy.saveConfig(draft);
    if (!res.ok) { msg(res.error, true); return; }
    msg('Saved.');
    window.Buddy.say('Settings saved.', 3000);
    setTimeout(close, 450);
  }
  modal.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.p) draft.profile[t.dataset.p] = t.value;
    if (t.dataset.gname !== undefined) draft.groups[+t.dataset.gname].name = t.value;
    if (t.dataset.iname) { const [gi, ii] = t.dataset.iname.split(':').map(Number); draft.groups[gi].items[ii].name = t.value; }
  });
  modal.addEventListener('change', async (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    if (k.startsWith('status:')) {
      const [, gi, ii] = k.split(':').map(Number), it = draft.groups[gi].items[ii], v = e.target.value;
      if (['build', 'testing', 'beta'].includes(v) || (v === 'live' && it.stage)) it.stage = v; else { it.status = v; }
      return;
    }
    const v = ['focusMin', 'breakMin'].includes(k) ? Number(e.target.value) : e.target.value;
    SETTINGS = await window.cy.setSettings({ [k]: v });
  });
  modal.addEventListener('click', async (e) => {
    const b = e.target.closest('button, [data-close]');
    if (!b) return;
    const d = b.dataset;
    if (d.close !== undefined) { close(); return; }
    if (d.stab) { sTab = d.stab; editingSrv = null; renderSettings(); return; }
    if (d.tgl) {
      const on = !b.classList.contains('on'); b.classList.toggle('on', on);
      if (d.tgl === 'login') await window.cy.setLogin(on);
      else { SETTINGS = await window.cy.setSettings({ [d.tgl]: on }); if (d.tgl === 'sing') window.Buddy.setSinging(on); }
      return;
    }
    if (d.test) {
      const out = modal.querySelector(`[data-testout="${CSS.escape(d.test)}"]`); out.textContent = 'Testing…'; out.className = 's-test';
      const r = await window.cy.testServer(draft.servers[d.test]);
      out.textContent = r.ok ? `OK · ${r.ms} ms · ${r.summary}` : r.error; out.className = `s-test ${r.ok ? 'ok' : 'bad'}`;
      return;
    }
    if (d.editSrv) { editingSrv = d.editSrv; $('#srvForm').innerHTML = srvForm(); return; }
    if (d.delSrv) { delete draft.servers[d.delSrv]; for (const g of draft.groups) if (g.servers) g.servers = g.servers.filter((x) => x !== d.delSrv); renderSettings(); return; }
    if (b.id === 'fCancel') { editingSrv = null; $('#srvForm').innerHTML = srvForm(); return; }
    if (b.id === 'fKeyPick') { const k = await window.cy.pickKey(); if (k) $('#fKey').value = k; return; }
    if (b.id === 'fTest') {
      const out = $('#fTestOut'); out.textContent = 'Testing…'; out.className = 's-test';
      const r = await window.cy.testServer(readSrvForm());
      out.textContent = r.ok ? `Connected · ${r.ms} ms · ${r.summary}` : r.error; out.className = `s-test ${r.ok ? 'ok' : 'bad'}`;
      return;
    }
    if (b.id === 'fAdd') {
      const f = readSrvForm();
      if (!f.name || !/^[\w.-]+@[\w.-]+$/.test(f.host)) { $('#fTestOut').textContent = 'Give it a name and a login like user@address.'; $('#fTestOut').className = 's-test bad'; return; }
      const id = editingSrv || uniqueId(f.name, new Set(Object.keys(draft.servers)));
      draft.servers[id] = { ...(draft.servers[id] || {}), ...f, sub: (draft.servers[id] && draft.servers[id].sub) || f.host.split('@')[1] };
      editingSrv = null; renderSettings(); msg('Server added. Save to apply.');
      return;
    }
    if (b.id === 'addSite') {
      const url = $('#siteUrl').value.trim();
      if (!/^https:\/\/[^/\s]+/.test(url)) { msg('The address must start with https://', true); return; }
      const host = url.replace(/^https:\/\//, '').split('/')[0];
      draft.sites.push({ id: uniqueId(host, new Set(draft.sites.map((x) => x.id))), url, host });
      renderSettings(); return;
    }
    if (d.delSite !== undefined) { draft.sites.splice(+d.delSite, 1); renderSettings(); return; }
    if (d.addproj !== undefined) {
      const f = await window.cy.pickFolder(); if (!f) return;
      const taken = new Set(draft.groups.flatMap((g) => g.items.map((i) => i.id)));
      draft.groups[+d.addproj].items.push({ id: uniqueId(f.name, taken), name: f.name, [f.git ? 'repo' : 'folder']: f.dir });
      renderSettings(); return;
    }
    if (d.delProj) { const [gi, ii] = d.delProj.split(':').map(Number); draft.groups[gi].items.splice(ii, 1); renderSettings(); return; }
    if (d.delGroup !== undefined) { draft.groups.splice(+d.delGroup, 1); renderSettings(); return; }
    if (b.id === 'addGroup') { draft.groups.push({ id: uniqueId('group', new Set(draft.groups.map((g) => g.id))), name: 'New group', items: [] }); renderSettings(); return; }
    if (b.id === 'rerunSetup') { close(); openWizard(); return; }
  });

  // ------------------------------------------------------------ first-run wizard
  let wz = null;
  function openWizard() {
    wz = { step: 0, draft: clone(C), folders: [] };
    wz.draft.profile = wz.draft.profile || { name: '', fullName: '', role: '' };
    open('', 'wizard');
    renderWizard();
    window.Buddy.run('wave');
    window.Buddy.say("Hi! I'm Cy. Let's set things up.", 8000);
  }
  function renderWizard() {
    const st = ['Welcome', 'Projects', 'Servers', 'Done'];
    const dots = `<div class="wz-steps">${st.map((s, i) => `<span class="${i === wz.step ? 'on' : i < wz.step ? 'done' : ''}">${i < wz.step ? icon('check') : i + 1}<em>${s}</em></span>`).join('')}</div>`;
    let body = '';
    if (wz.step === 0) {
      body = `<h2>Welcome to CY Desk</h2><p>Your desktop becomes a dashboard: your projects and to-dos, your servers, your Claude agents, and Cy keeping an eye on all of it.</p>
        <div class="grid2">${field('What should Cy call you?', `<input id="wName" value="${esc(wz.draft.profile.name || '')}" placeholder="First name">`)}${field('What do you do? (optional)', `<input id="wRole" value="${esc(wz.draft.profile.role || '')}" placeholder="Developer · Company">`)}</div>`;
    } else if (wz.step === 1) {
      const all = wz.draft.groups.flatMap((g) => g.items);
      body = `<h2>Your projects</h2><p>Add the folders you work in. Git repositories get their commits, versions and activity on the dashboard.</p>
        <div class="wz-list">${all.map((it) => `<div class="s-row"><div><b>${esc(it.name)}</b><small>${esc(it.repo || it.folder || '')}${it.repo ? ' · git' : ''}</small></div></div>`).join('') || '<div class="empty">No folders yet.</div>'}</div>
        <button class="btn-ghost" id="wAddFolder">${icon('folder-plus')}Add a folder</button>`;
    } else if (wz.step === 2) {
      body = `<h2>Servers (optional)</h2><p>CY Desk can watch Linux servers over SSH with your key: up or down, load, disk, services. Read-only, every 2 minutes. You can skip this and add them later in Settings.</p>
        <div class="s-form">${srvFormWizard()}</div>
        <div class="wz-list">${Object.values(wz.draft.servers).map((s) => `<div class="s-row"><div><b>${esc(s.name)}</b><small>${esc(s.host)}</small></div><span class="tag ok">added</span></div>`).join('')}</div>`;
    } else {
      body = `<h2>You're all set${wz.draft.profile.name ? `, ${esc(wz.draft.profile.name)}` : ''}!</h2><p>A few things worth knowing:</p>
        <ul class="wz-tips"><li>${icon('star')}Star tasks to pin them in <b>My focus</b>, press ${icon('play')} to start a focus session.</li>
        <li>${icon('bot')}The <b>Agents</b> tab shows your Claude Code sessions and which ones are waiting for you.</li>
        <li>${icon('sunrise')}Every morning Cy opens a <b>daily brief</b> with a standup you can copy.</li>
        <li>${icon('sparkles')}Play some music: Cy sings along. Poke Cy if you're bored.</li></ul>`;
    }
    modal.innerHTML = `${dots}<div class="m-body wz-body">${body}</div>
      <div class="m-foot">${wz.step > 0 && wz.step < 3 ? `<button class="btn-ghost" id="wBack">Back</button>` : '<span></span>'}<span class="s-msg" id="sMsg"></span>
        ${wz.step === 2 ? `<button class="btn-ghost" id="wSkip">Skip</button>` : ''}<button class="btn-dark" id="wNext">${wz.step === 3 ? 'Open my desk' : 'Continue'}${icon('arrow-right')}</button></div>`;
  }
  function srvFormWizard() {
    return `<div class="grid2">${field('Name', '<input id="fName" placeholder="Production">')}${field('SSH login', '<input id="fHost" placeholder="ubuntu@203.0.113.10">')}
      ${field('Private key', `<div class="row-in"><input id="fKey" value="~/.ssh/id_ed25519"><button class="btn-ghost sm" id="fKeyPick" type="button">${icon('key-round')}</button></div>`)}
      ${field('Services to watch (optional)', '<input id="fServices" placeholder="nginx, postgresql">')}</div>
      <div class="s-formfoot"><span class="s-test" id="fTestOut"></span><button class="btn-ghost sm" id="wTest" type="button">${icon('plug')}Test</button><button class="btn-dark sm" id="wAddSrv" type="button">${icon('plus')}Add</button></div>`;
  }
  modal.addEventListener('click', async (e) => {
    if (!modal.classList.contains('wizard')) return;
    const b = e.target.closest('button'); if (!b) return;
    const f = () => ({ name: $('#fName').value.trim(), host: $('#fHost').value.trim(), key: $('#fKey').value.trim(), probe: 'linux',
      services: $('#fServices').value.split(',').map((x) => x.trim()).filter(Boolean), containers: [] });
    if (b.id === 'wAddFolder') {
      const r = await window.cy.pickFolder(); if (!r) return;
      const g = wz.draft.groups[0] || (wz.draft.groups[0] = { id: 'work', name: 'Projects', items: [] });
      const taken = new Set(wz.draft.groups.flatMap((x) => x.items.map((i) => i.id)));
      g.items.push({ id: uniqueId(r.name, taken), name: r.name, [r.git ? 'repo' : 'folder']: r.dir });
      renderWizard(); return;
    }
    if (b.id === 'wTest') { const out = $('#fTestOut'); out.textContent = 'Testing…'; const r = await window.cy.testServer(f()); out.textContent = r.ok ? `Connected · ${r.ms} ms` : r.error; out.className = `s-test ${r.ok ? 'ok' : 'bad'}`; return; }
    if (b.id === 'wAddSrv') {
      const s = f();
      if (!s.name || !/^[\w.-]+@[\w.-]+$/.test(s.host)) { $('#fTestOut').textContent = 'Give it a name and a login like user@address.'; $('#fTestOut').className = 's-test bad'; return; }
      wz.draft.servers[uniqueId(s.name, new Set(Object.keys(wz.draft.servers)))] = { ...s, sub: s.host.split('@')[1] };
      renderWizard(); return;
    }
    if (b.id === 'wBack') { wz.step--; renderWizard(); return; }
    if (b.id === 'wSkip') { wz.step = 3; renderWizard(); return; }
    if (b.id === 'wNext') {
      if (wz.step === 0) {
        const name = $('#wName').value.trim();
        if (!name) { msg('Tell Cy your name first.', true); return; }
        wz.draft.profile = { ...wz.draft.profile, name, fullName: wz.draft.profile.fullName && wz.draft.profile.name === name ? wz.draft.profile.fullName : name, role: $('#wRole').value.trim() };
        window.Buddy.say(`Nice to meet you, ${name}!`, 5000);
      }
      if (wz.step === 3) {
        const res = await window.cy.saveConfig(wz.draft);
        if (!res.ok) { msg(res.error, true); return; }
        SETTINGS = await window.cy.setSettings({ onboarded: true });
        modal.classList.remove('wizard'); close();
        window.Buddy.celebrate('Welcome home!');
        return;
      }
      wz.step++; renderWizard();
    }
  });

  // ------------------------------------------------------------ wiring
  $('#briefBtn').addEventListener('click', () => openBrief(false));
  $('#settingsBtn').addEventListener('click', () => openSettings('general'));
  window.Panels = { openBrief, openSettings, openWizard, close };
  // First run: the wizard; later runs: nothing until the first sign of life (brief).
  const waitInit = setInterval(() => {
    if (!C) return;
    clearInterval(waitInit);
    if (SETTINGS.onboarded === false) setTimeout(openWizard, 1500);
  }, 200);
})();
