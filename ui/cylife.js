/* Cy's life: talking to Cy (Claude), XP and outfits, weather and time of day, reactions to Claude
   Code sessions, and the command palette (Ctrl+K). Uses the renderer state from app.js. */
(function () {
  const stageIn = $('#stageIn');
  let XP = null, WEATHER = null, HAS_KEY = false, MODELS = [], WIDGETS = {};
  const history = [];

  // ---------------------------------------------------------------- markup on the stage
  stageIn.insertAdjacentHTML('afterbegin', `
    <div class="cy-hud">
      <button class="lvl" id="lvl" data-tip="Cy's level · click for the wardrobe"><svg class="lvl-ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" class="track"/><circle cx="18" cy="18" r="15" class="fill" id="lvlFill"/></svg><b id="lvlN">1</b></button>
      <div class="lvl-txt"><b id="lvlName">Level 1</b><span id="lvlXp">0 / 100 XP</span></div>
    </div>
    <form class="talk" id="talk" autocomplete="off"><span class="talk-ic">${icon('message-circle')}</span><input id="talkIn" maxlength="500" placeholder="Talk to Cy…"><button type="submit" class="talk-go" aria-label="Send">${icon('arrow-right')}</button></form>
    <div class="wardrobe" id="wardrobe"></div>
    <div class="sky" id="sky" aria-hidden="true"></div>`);
  const xpFloat = (text) => {
    const n = document.createElement('span'); n.className = 'xp-float'; n.textContent = text;
    $('.cy-hud').appendChild(n); setTimeout(() => n.remove(), 1800);
  };

  // ---------------------------------------------------------------- XP and outfits
  function renderXp(x, event) {
    if (!x) return;
    XP = x;
    $('#lvlN').textContent = x.level;
    $('#lvlName').textContent = `Level ${x.level}`;
    $('#lvlXp').textContent = `${x.into} / ${x.need} XP`;
    const C2 = 2 * Math.PI * 15;
    const fill = $('#lvlFill');
    fill.style.strokeDasharray = C2.toFixed(1);
    fill.style.strokeDashoffset = (C2 * (1 - x.into / x.need)).toFixed(1);
    window.Buddy.setWear(x.equipped || []);
    if ($('#wardrobe').classList.contains('on')) renderWardrobe();
    if (!event) return;
    xpFloat(`+${event.gained} XP`);
    if (event.levelUp && event.levelUp.length) {
      const lv = event.levelUp[event.levelUp.length - 1];
      const it = event.unlocked && event.unlocked[0];
      $('#lvl').classList.remove('pulse'); void $('#lvl').offsetWidth; $('#lvl').classList.add('pulse');
      setTimeout(() => window.Buddy.celebrate(it ? `Level ${lv}! I unlocked the ${it.name.toLowerCase()}. Try it on?` : `Level ${lv}! Look at us go.`), 400);
      if (it) setTimeout(() => window.cy.equip(it.id, true), 2600);
    }
  }
  function renderWardrobe() {
    const box = $('#wardrobe');
    if (!XP) return;
    box.innerHTML = `<header><b>Wardrobe</b><span>Level ${XP.level} · ${XP.xp} XP in total</span></header>
      <div class="wr-grid">${XP.items.filter((it) => !it.builtin).map((it) => {
        const on = XP.equipped.includes(it.id);
        return `<button class="wr-item ${it.unlocked ? '' : 'locked'} ${on ? 'on' : ''}" data-wear="${it.id}" ${it.unlocked ? '' : 'disabled'}>
          <span>${it.unlocked ? esc(it.name) : `${icon('lock')}Level ${it.level}`}</span></button>`;
      }).join('')}</div>
      <p class="wr-how">XP: a finished task 20, a focus minute 1, a commit 4, a stretch 5, a glass of water 2.</p>`;
  }
  $('#lvl').addEventListener('click', (e) => { e.stopPropagation(); renderWardrobe(); $('#wardrobe').classList.toggle('on'); });
  document.addEventListener('click', (e) => {
    const w = e.target.closest('[data-wear]');
    if (w) { const on = !w.classList.contains('on'); window.cy.equip(w.dataset.wear, on); if (on) window.Buddy.react('happy', pick(['How do I look?', 'Fancy!', 'Very me.'])); return; }
    if (!e.target.closest('#wardrobe, #lvl')) $('#wardrobe').classList.remove('on');
  });

  // ---------------------------------------------------------------- talking to Cy
  // What Cy knows: a compact text snapshot of the dashboard, sent with every message.
  async function snapshot() {
    const L = [];
    const now = new Date();
    L.push(`Now: ${now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}. User: ${USER || 'unknown'}.`);
    if (WEATHER) L.push(`Weather in ${WEATHER.place}: ${WEATHER.summary} (${WEATHER.condition}${WEATHER.tempC !== null ? `, ${WEATHER.tempC}°C` : ''}).`);
    const checks = computeChecks(), alerts = alertsOf(checks);
    L.push(`System health: ${checks.filter((c) => c.ok).length}/${checks.length} checks pass.${alerts.length ? ' Alerts: ' + alerts.slice(0, 6).map((a) => a.text).join('; ') + '.' : ''}`);
    for (const [id, def] of Object.entries(C.servers || {})) { const s = S.servers[id]; L.push(`Server ${def.name}: ${!s ? 'not checked' : s.ok ? 'up' : 'unreachable'} (${serverMetric(id).row}).`); }
    const open = openTodos();
    L.push(`Open tasks: ${open.length}. Pinned for today: ${open.filter((t) => t.focus).map((t) => `"${t.text}" (${(items.get(t.item) || { item: { name: t.item } }).item.name})`).slice(0, 8).join(', ') || 'none'}.`);
    const byProject = {};
    for (const t of open) { const n = (items.get(t.item) || { item: { name: t.item } }).item.name; byProject[n] = (byProject[n] || 0) + 1; }
    L.push(`Open tasks per project: ${Object.entries(byProject).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, c]) => `${n} ${c}`).join(', ')}.`);
    const done = T.items.filter((t) => t.done && t.doneAt && Date.now() - Date.parse(t.doneAt) < 7 * 864e5);
    L.push(`Done in the last 7 days: ${done.length}${done.length ? ' (' + done.slice(-5).map((t) => `"${t.text}"`).join(', ') + ')' : ''}.`);
    L.push(`Commits this week: ${weekCommits()}. Focus this week: ${fmtMin(FOCUS_WEEK.total || 0)}${FOCUS ? `. Focus session running on "${FOCUS.text}"` : ''}.`);
    if (AGENTS.length) L.push(`Claude Code sessions: ${AGENTS.slice(0, 8).map((a) => `"${a.title}" (${a.status}, ${a.project})`).join(', ')}.`);
    if (VITALS) L.push(`This PC: CPU ${VITALS.cpu}%, memory ${VITALS.mem}%, working ${fmtMin(VITALS.activeMin)} without a break.`);
    try { const h = await window.cy.health(); L.push(`Health today: ${fmtMin(Math.round(h.today.activeMin))} at the screen, ${h.today.breaks} breaks, ${h.today.water}/${h.goals.water} glasses of water, mood ${h.today.mood || 'not logged'}.`); } catch {}
    try {
      const m = await window.cy.ledger(), month = dayKey(new Date()).slice(0, 7);
      const spent = m.entries.filter((e) => e.kind === 'out' && e.date.startsWith(month)).reduce((s, e) => s + e.amount, 0);
      L.push(`Money this month: spent ${spent} ${m.currency}${m.budget ? ` of a ${m.budget} budget` : ''}.`);
    } catch {}
    if (XP) L.push(`Cy is level ${XP.level}${XP.equipped.length ? ', wearing ' + XP.equipped.join(', ') : ''}.`);
    return L.join('\n');
  }
  const MOODS = { happy: 'happy', giggle: 'giggle', love: 'love', curious: 'curious', surprised: 'surprised', worried: 'worried', sleepy: 'sleepy', idea: 'idea' };
  let talking = false, lastTalk = 0;
  async function ask(text) {
    text = String(text || '').trim();
    if (!text || talking) return;
    if (!HAS_KEY && !window.__demo) {
      window.Buddy.say('Give me a Claude API key in Settings › Cy and I can talk for real!', 8000);
      window.Buddy.react('curious', 'Give me a Claude API key in Settings › Cy and I can talk for real!');
      return;
    }
    talking = true;
    $('#talk').classList.add('busy');
    window.Buddy.say('…', 30000);
    window.Buddy.run('think');
    const r = await window.cy.chat({ message: text, snapshot: await snapshot(), history });
    talking = false;
    $('#talk').classList.remove('busy');
    if (!r || !r.ok) {
      window.Buddy.react('worried', r && r.error === 'no-key' ? 'I need a Claude API key first: Settings › Cy.' : `I couldn't think just now: ${(r && r.error) || 'unknown error'}`);
      return;
    }
    lastTalk = Date.now();
    history.push({ role: 'user', text }, { role: 'cy', text: r.text });
    while (history.length > 12) history.shift();
    window.Buddy.cancel && window.Buddy.cancel();
    window.Buddy.react(MOODS[r.mood] || 'happy', r.text);
    window.Buddy.say(r.text, Math.min(30000, 5000 + r.text.length * 70));
  }
  $('#talk').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#talkIn').value; $('#talkIn').value = ''; ask(v); });
  $('#talkIn').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); $('#talkIn').blur(); } });

  // ---------------------------------------------------------------- weather and time of day
  const WX_ICON = { clear: 'sun', clouds: 'cloud', rain: 'droplet', storm: 'zap', snow: 'sparkles', fog: 'cloud', wind: 'activity' };
  function timeOfDay() { const h = new Date().getHours(); return h >= 6 && h < 9 ? 'dawn' : h >= 9 && h < 17 ? 'day' : h >= 17 && h < 20 ? 'dusk' : 'night'; }
  function renderSky() {
    const tod = timeOfDay();
    document.body.dataset.tod = tod;
    const sky = $('#sky'), cond = WEATHER ? WEATHER.condition : (tod === 'night' ? 'clear' : '');
    const key = `${tod}|${cond}`;
    if (sky.dataset.key === key) return;
    sky.dataset.key = key;
    sky.className = `sky ${cond ? `wx-${cond}` : ''}`;
    let html = '';
    if (cond === 'rain' || cond === 'storm') for (let i = 0; i < 12; i++) html += `<i class="drop" style="left:${(i * 8.3 + (i % 3) * 2).toFixed(1)}%;animation-delay:${(-(i * 0.37) % 1.2).toFixed(2)}s;animation-duration:${(0.9 + (i % 4) * 0.12).toFixed(2)}s"></i>`;
    if (cond === 'snow') for (let i = 0; i < 14; i++) html += `<i class="flake" style="left:${(i * 7.1 + (i % 2) * 3).toFixed(1)}%;animation-delay:${(-(i * 0.9) % 6).toFixed(2)}s;animation-duration:${(5 + (i % 5)).toFixed(1)}s"></i>`;
    if (cond === 'clouds' || cond === 'fog' || cond === 'storm' || cond === 'rain') html += '<i class="cloud c1"></i><i class="cloud c2"></i>';
    if (cond === 'clear' && tod === 'night') for (let i = 0; i < 9; i++) html += `<i class="star" style="left:${(8 + i * 10.5).toFixed(1)}%;top:${(6 + (i * 37) % 30).toFixed(1)}%;animation-delay:${(i * 0.7).toFixed(1)}s"></i>`;
    if (cond === 'clear' && tod !== 'night') html += '<i class="sunray"></i>';
    if (tod === 'night') html += '<i class="lamp"></i>';
    sky.innerHTML = html;
  }
  function weatherPill() {
    if (!WEATHER) return '';
    return `<div class="pill-srv pill-wx" data-tip="${esc(`${WEATHER.summary} · ${WEATHER.place} · found by Haiku with a web search`)}">${icon(WX_ICON[WEATHER.condition] || 'cloud')}${WEATHER.tempC !== null ? `${WEATHER.tempC}°` : ''}<span>${esc(WEATHER.place.split(',')[0])}</span></div>`;
  }
  let lastWxKey = '';
  function onWeather(w) {
    WEATHER = w && w.ok !== false ? w : null;
    renderSky();
    if (typeof renderTop === 'function' && S) renderTop(alertsOf(computeChecks()));
    const key = WEATHER ? WEATHER.condition : '';
    if (WEATHER && key !== lastWxKey && lastWxKey !== '') {
      const line = { rain: `Rain in ${WEATHER.place.split(',')[0]}. Cozy coding weather.`, snow: 'It is snowing! I am staying in my scarf.', clear: 'Clear skies out there.', storm: 'A storm outside. Good day to stay in and ship.', clouds: 'Cloudy outside. Perfect focus light.', fog: 'Foggy out. Take it slow.', wind: 'Windy out there. Hold on to your hat.' }[key];
      if (line) window.Buddy.say(line, 6000);
    }
    lastWxKey = key;
  }
  setInterval(renderSky, 5 * 60000);

  // ---------------------------------------------------------------- reacting to Claude Code sessions
  // A session waiting on you: Cy holds up a sign with its name (click it to open the session).
  // Sessions working: now and then Cy works along on a tiny laptop.
  // Not in the first minute: Cy says hello first.
  let lastSign = Date.now() - 150000 + 60000, lastType = Date.now() - 180000 + 60000;
  const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  setInterval(() => {
    const st = window.Buddy.state;
    if (st.paused || st.activity || st.singing || st.asleep || st.focus || talking || Date.now() - lastTalk < 45000) return;
    const waiting = AGENTS.filter((a) => a.status === 'question' || a.status === 'blocked');
    if (waiting.length && Date.now() - lastSign > 150000) {
      lastSign = Date.now();
      const a = waiting[0];
      window.Buddy.run('sign', { text: short(a.title, 26), say: waiting.length > 1 ? `${waiting.length} Claude sessions are waiting for you.` : `${a.title} is waiting for you. Click my sign!`,
        onClick: () => window.cy.openAgent(a) });
      return;
    }
    const working = AGENTS.filter((a) => a.status === 'working');
    if (working.length && Date.now() - lastType > 180000 && Math.random() < 0.6) {
      lastType = Date.now();
      window.Buddy.run('type', pick([`Typing along with ${short(working[0].title, 30)}…`, 'Claude is coding. Me too.', `${working.length} session${working.length > 1 ? 's' : ''} at work. I am helping. Sort of.`]));
    }
  }, 9000);

  // ---------------------------------------------------------------- command palette (Ctrl+K)
  const pal = document.createElement('div');
  pal.className = 'palette'; pal.id = 'palette';
  pal.innerHTML = `<div class="pal-box"><label class="pal-in">${icon('search')}<input id="palIn" placeholder="Type a command, a project, + a task, or ask Cy…" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></label><div class="pal-list" id="palList"></div></div>`;
  document.body.appendChild(pal);
  let palSel = 0, palItems = [];
  function commands(q) {
    const out = [];
    const s = q.trim(), low = s.toLowerCase();
    const add = (ic, label, sub, run, score = 0) => out.push({ ic, label, sub, run, score });
    if (s.startsWith('+') || /^add /i.test(s)) {
      const text = s.replace(/^\+\s*|^add\s+/i, '');
      const proj = $('#quickItem').value;
      if (text) add('plus', `Add task: ${text}`, `to ${(items.get(proj) || { item: { name: proj } }).item.name}, pinned to focus`, () => window.cy.addTodo({ item: proj, text, focus: true }).then(() => window.Buddy.run('nod')), 100);
    }
    if (s && (s.endsWith('?') || /^(ask|cy[ ,:])/i.test(s))) add('message-circle', `Ask Cy: ${s.replace(/^(ask|cy[ ,:])\s*/i, '')}`, HAS_KEY || window.__demo ? `answered by ${modelName()}` : 'needs a Claude API key (Settings › Cy)', () => ask(s.replace(/^(ask|cy[ ,:])\s*/i, '')), 90);
    const base = [
      ['bot', 'Open Claude', 'space', () => window.Spaces.open('claude')], ['server', 'Open Servers', 'space', () => window.Spaces.open('servers')],
      ['wallet', 'Open Money', 'space', () => window.Spaces.open('money')], ['heart-pulse', 'Open Health', 'space', () => window.Spaces.open('health')],
      ['gauge', 'Open Widgets', 'space', () => window.Spaces.open('widgets')], ['layout-grid', 'Back to the overview', 'Esc', () => window.Spaces.close()],
      ['sunrise', 'Daily brief', 'with a standup to copy', () => window.Panels.openBrief()], ['settings', 'Settings', '', () => window.Panels.openSettings('general')],
      ['message-circle', 'Talk to Cy', 'focus the chat', () => $('#talkIn').focus()], ['refresh-cw', 'Check everything now', 'servers, sites, git', () => window.cy.refresh()],
      ['moon', 'Switch light / dark', '', () => window.cy.setTheme(THEME === 'dark' ? 'light' : 'dark')], ['plus', 'Quick add window', 'Ctrl+Alt+N from any app', () => window.cy.quickOpen()],
      ['sparkles', 'Wardrobe', `level ${XP ? XP.level : 1}`, () => { renderWardrobe(); $('#wardrobe').classList.add('on'); }]
    ];
    for (const [ic, label, sub, run] of base) add(ic, label, sub, run);
    for (const [id, { item, group }] of items) add('folder', item.name, group.short || group.name.split(' · ').pop(), () => window.Spaces.open('project', id));
    for (const t of openTodos().slice(0, 40)) add('timer', `Focus on: ${t.text}`, `${SETTINGS.focusMin || 25} min`, () => startFocus(t.id, SETTINGS.focusMin || 25), -5);
    if (!low) return out.filter((x) => x.score >= 0).slice(0, 9);
    const words = low.split(/\s+/).filter(Boolean);
    return out.map((x) => {
      if (x.score >= 90) return x;
      const hay = `${x.label} ${x.sub}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      return { ...x, score: x.score + (x.label.toLowerCase().startsWith(words[0]) ? 20 : 0) + (hay.indexOf(words[0]) < 6 ? 5 : 0) };
    }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 9);
  }
  function renderPal() {
    palItems = commands($('#palIn').value);
    palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
    $('#palList').innerHTML = palItems.map((x, i) => `<div class="pal-row ${i === palSel ? 'sel' : ''}" data-pal="${i}">${icon(x.ic)}<span>${esc(x.label)}</span><small>${esc(x.sub || '')}</small></div>`).join('')
      || '<div class="pal-row empty"><span>Nothing matches. Start with + to add a task, end with ? to ask Cy.</span></div>';
  }
  function openPal() { pal.classList.add('on'); $('#palIn').value = ''; palSel = 0; renderPal(); setTimeout(() => $('#palIn').focus(), 20); }
  function closePal() { pal.classList.remove('on'); }
  function runPal(i) { const x = palItems[i]; closePal(); if (x) x.run(); }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); pal.classList.contains('on') ? closePal() : openPal(); return; }
    if (!pal.classList.contains('on')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePal(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palItems.length) % Math.max(1, palItems.length); renderPal(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPal(palSel); }
  }, true);
  pal.addEventListener('input', () => { palSel = 0; renderPal(); });
  pal.addEventListener('click', (e) => { const r = e.target.closest('[data-pal]'); if (r) runPal(+r.dataset.pal); else if (e.target === pal) closePal(); });
  const modelName = () => ((MODELS.find(([id]) => id === SETTINGS.chatModel) || [0, 'Haiku 5.5'])[1]).split(' · ')[0];

  // ---------------------------------------------------------------- wiring
  window.CyLife = {
    init(init) {
      HAS_KEY = !!init.hasKey; MODELS = init.models || []; WIDGETS = init.widgets || {};
      window.__demo = !!init.demo;
      renderXp(init.xp);
      onWeather(init.weather);
      renderSky();
      $('#talkIn').placeholder = HAS_KEY || init.demo ? `Talk to Cy (${modelName()})…` : 'Talk to Cy (add a key in Settings › Cy)…';
    },
    weatherPill, ask, openPal, closePal, renderWardrobe, snapshot,
    get xp() { return XP; }, get weather() { return WEATHER; }, get widgets() { return WIDGETS; },
    setHasKey(v) { HAS_KEY = !!v; $('#talkIn').placeholder = HAS_KEY ? `Talk to Cy (${modelName()})…` : 'Talk to Cy (add a key in Settings › Cy)…'; }
  };
  // app.js may have started before this file loaded: pick its init data up here.
  if (window.__init) window.CyLife.init(window.__init);
  window.cy.on('xp', (x) => renderXp(x, x.event));
  window.cy.on('weather', onWeather);
  window.cy.on('widgets', (w) => { WIDGETS = w || {}; if (window.Spaces && window.Spaces.current() === 'widgets') window.Spaces.refresh(); });
})();
