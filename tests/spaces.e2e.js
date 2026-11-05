// v1.1: spaces (Claude, Servers, Money, Health, project dashboards), the heatmap tooltip and fit,
// the focus list and timer, Cy's new moves, a custom 3D companion, and the MCP server.
// Runs in demo mode (npm test): nothing real is touched, open actions are dry-run.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dir = path.join(__dirname, 'out');
fs.mkdirSync(dir, { recursive: true });
module.exports = async (h) => {
  h.dryRun();
  let failed = 0;
  const ok = (name, cond, extra = '') => { if (!cond) failed++; h.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ' :: ' + JSON.stringify(extra) : ''}`); };
  const n = (sel) => h.js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const text = (sel) => h.js(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`);
  const click = (sel) => h.js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const rect = (sel) => h.js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; })()`);
  // A test window hidden behind other windows can stop painting mid-transition: jump any running
  // animation to its end before measuring the final layout.
  const settle = () => h.js(`document.getAnimations().forEach((a) => { try { if (a.effect && a.effect.getTiming().iterations !== Infinity) a.finish(); } catch {} }); true`);
  await h.wait(8000);
  await h.js(`SETTINGS.lastBrief = dayKey(new Date()); Panels.close()`); await h.wait(300);

  // ---- heatmap fits its card, tooltip shows per-project commits
  const card = await rect('#activityCard');
  const lastCell = await h.js(`Math.max(...[...document.querySelectorAll('.heat .c')].map((c) => c.getBoundingClientRect().right))`);
  ok('heatmap stays inside its card', lastCell <= card.r - 8, { cell: Math.round(lastCell), card: Math.round(card.r) });
  ok('heatmap month labels inside the card', await h.js(`[...document.querySelectorAll('.heat .m')].every((m) => m.getBoundingClientRect().right <= document.querySelector('#activityCard').getBoundingClientRect().right - 4)`));
  const day = await h.js(`(() => { const c = [...document.querySelectorAll('.heat .c.c2, .heat .c.c3, .heat .c.c4')].pop(); c.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return c.dataset.day; })()`);
  await h.wait(250);
  ok('custom tooltip on a day', await h.js(`document.querySelector('#tip').classList.contains('on')`));
  const rows = await n('#tip .tip-r');
  const sum = await h.js(`[...document.querySelectorAll('#tip .tip-r em')].reduce((s, e) => s + +e.textContent, 0)`);
  const total = await h.js(`S.activity.days[${JSON.stringify(day)}]`);
  ok('tooltip breaks the day down by project', rows > 0 && sum >= total, { rows, sum, total });
  await h.shot(path.join(dir, 's_tooltip.png'));
  await h.js(`document.querySelector('#greet').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`); await h.wait(200);
  ok('tooltip hides', !(await h.js(`document.querySelector('#tip').classList.contains('on')`)));

  // ---- focus list: every pinned task reachable, new task scrolled to and flashed
  const pinned = await h.js(`openTodos().filter((t) => t.focus).length`);
  ok('every pinned task is in the list', (await n('#focusList .f-item:not(.next)')) === pinned, pinned);
  ok('focus list scrolls', (await h.js(`getComputedStyle(document.querySelector('#focusList')).overflowY`)) === 'auto');
  const added = [];
  for (let i = 0; i < 4; i++) {
    await h.js(`document.querySelector('#quickText').value = 'ZZTEST pinned ${i}'; document.querySelector('#quickAdd').requestSubmit()`);
    await h.wait(1300);
  }
  ok('new pinned tasks all listed', (await h.js(`[...document.querySelectorAll('#focusList .f-item .txt')].filter((t) => t.textContent.startsWith('ZZTEST pinned')).length`)) === 4);
  const lastVisible = await h.js(`(() => { const li = [...document.querySelectorAll('#focusList .f-item')].find((x) => x.textContent.includes('ZZTEST pinned 3')); const l = document.querySelector('#focusList').getBoundingClientRect(), r = li.getBoundingClientRect(); return r.top >= l.top - 1 && r.bottom <= l.bottom + 1; })()`);
  ok('the newest task is scrolled into view', lastVisible || (await h.wait(1200), await h.js(`(() => { const li = [...document.querySelectorAll('#focusList .f-item')].find((x) => x.textContent.includes('ZZTEST pinned 3')); const l = document.querySelector('#focusList').getBoundingClientRect(), r = li.getBoundingClientRect(); return r.top >= l.top - 1 && r.bottom <= l.bottom + 1; })()`)));
  await h.shot(path.join(dir, 's_focus_list.png'));
  for (const id of await h.js(`T.items.filter((t) => t.text.startsWith('ZZTEST pinned')).map((t) => t.id)`)) added.push(id);
  for (const id of added) await h.js(`window.cy.removeTodo(${JSON.stringify(id)})`);
  await h.wait(1200);

  // ---- focus timer: fits its card, amber, +5 works
  await h.js(`startFocus(document.querySelector('#focusList [data-start]').dataset.start, 25)`); await h.wait(1500);
  const fb = await rect('#focusBanner'), stop = await rect('#focusStop'), fcard = await rect('.card.focus');
  ok('timer buttons inside the banner', stop.r <= fb.r - 2 && fb.r <= fcard.r, { stop: Math.round(stop.r), banner: Math.round(fb.r), card: Math.round(fcard.r) });
  ok('timer is amber, not black', (await h.js(`getComputedStyle(document.querySelector('#focusBanner')).backgroundImage`)).includes('gradient'));
  const before = await h.js('FOCUS.planned');
  await click('#focusMore'); await h.wait(1000);
  ok('+5 minutes', (await h.js('FOCUS.planned')) === before + 5, await h.js('FOCUS.planned'));
  await h.shot(path.join(dir, 's_focus_timer.png'));
  await click('#focusStop'); await h.wait(1000);

  // ---- spaces
  const cyNormal = (await rect('#mascot')).w;
  const spaces = [['claude', '#spaceRight .bars .bar', 14], ['servers', '#spaceRight .srv-card', await h.js('Object.keys(C.servers).length')], ['money', '#spaceLeft .money-row', 1], ['health', '#spaceRight .bars .bar', 14]];
  for (const [name, sel, want] of spaces) {
    await click(`[data-space="${name}"]`); await h.wait(2300); await settle();
    const got = await n(sel);
    ok(`space ${name} opens with data`, (await h.js(`document.body.classList.contains('space') && Spaces.current()`)) === name && got >= want, { got, want });
    if (name === 'claude') {
      const st = await rect('#stage'), grid = await rect('.grid');
      ok('the stage takes the whole dashboard', st.w >= grid.w - 4, { stage: Math.round(st.w), grid: Math.round(grid.w) });
      const m = await rect('#mascot');
      ok('Cy stays in the middle', Math.abs((m.l + m.r) / 2 - (st.l + st.r) / 2) < 6);
      ok('Cy gets bigger', m.w > cyNormal * 1.1, { normal: Math.round(cyNormal), space: Math.round(m.w) });
      ok('Cy knows the space', (await h.js('Buddy.state.space')) === 'claude');
      const L = await rect('#spaceLeft'), R = await rect('#spaceRight');
      ok('panels on both sides of Cy', L.r <= m.l + m.w * 0.25 && R.l >= m.r - m.w * 0.25, { L: Math.round(L.r), cy: [Math.round(m.l), Math.round(m.r)], R: Math.round(R.l) });
      await click('[data-act="agents:you"]'); await h.wait(300);
      ok('sessions filter', (await n('#spaceLeft .sp-row.agent')) === (await h.js(`AGENTS.filter((a) => a.status === 'question' || a.status === 'blocked').length`)));
      await click('[data-act="claude:connect"]'); await h.wait(800);
      ok('connect Claude (dry run)', (await text('#connMsg')).includes('Connected'), await text('#connMsg'));
    }
    if (name === 'money') {
      const n0 = await h.js('document.querySelectorAll("#spaceLeft .money-row").length');
      await h.js(`document.querySelector('#mAmount').value = '42.5'; document.querySelector('#mNote').value = 'ZZTEST lunch'; document.querySelector('#moneyForm').requestSubmit()`); await h.wait(900);
      ok('money: add an expense', (await text('#spaceLeft')).includes('ZZTEST lunch'));
      const id = await h.js(`(([...document.querySelectorAll('#spaceLeft .money-row')].find((r) => r.textContent.includes('ZZTEST lunch'))||{}).querySelector('[data-act]')||{dataset:{}}).dataset.act`);
      await h.js(`document.querySelector('[data-act="${id}"]').click()`); await h.wait(700);
      ok('money: delete it', !(await text('#spaceLeft')).includes('ZZTEST lunch') && (await n('#spaceLeft .money-row')) === n0);
    }
    if (name === 'health') {
      const w0 = await h.js('document.querySelectorAll("#spaceLeft .glass.full").length');
      await click('#spaceLeft .glass:not(.full)'); await h.wait(700);
      ok('health: log a glass of water', (await n('#spaceLeft .glass.full')) === w0 + 1);
      ok('Cy drinks too', (await h.js('Buddy.state.activity')) === 'water', await h.js('Buddy.state.activity'));
      await h.js(`[...document.querySelectorAll('#spaceLeft .glass.full')].pop().click()`); await h.wait(600);
      ok('health: remove it again', (await n('#spaceLeft .glass.full')) === w0);
      await click('[data-act="health:mood:4"]'); await h.wait(600);
      ok('health: mood', (await n('#spaceLeft .mood.on')) === 1);
    }
    await h.shot(path.join(dir, `s_space_${name}.png`));
  }
  const why = await h.js(`({ modal: document.querySelector('#modal').className, active: document.activeElement.tagName + '#' + document.activeElement.id, space: Spaces.current() })`);
  await h.js(`document.activeElement && document.activeElement.blur(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await h.wait(900); await settle();
  ok('Esc closes the space', !(await h.js(`document.body.classList.contains('space')`)) && (await h.js('Buddy.state.space')) === null, why);
  const st2 = await rect('#stage'), grid2 = await rect('.grid');
  ok('layout comes back', st2.w < grid2.w * 0.5, { stage: Math.round(st2.w) });

  // ---- project dashboard
  const G = await h.js('C.groups[0].items[0]');
  await click(`#plist [data-open="${G.id}"]`); await h.wait(1600);
  ok('project opens as a space', (await h.js('Spaces.projectId()')) === G.id && (await text('#dTitle')) === G.name);
  ok('project KPIs', (await n('#spaceLeft .sp-kpi')) === 4);
  ok('project commits chart', (await n('#spaceRight .bars .bar')) === 16);
  await h.shot(path.join(dir, 's_project.png'));
  await click('[data-act="close"]'); await h.wait(800);

  // ---- Cy's new moves
  for (const a of ['dance', 'think', 'bow', 'peekaboo', 'coffee', 'nod']) {
    await h.js(`Buddy.run('${a}')`); await h.wait(300);
    const s = await h.js('Buddy.state');
    ok(`Cy ${a}`, s.activity === a, { activity: s.activity, look: s.look });
    await h.wait(a === 'think' || a === 'peekaboo' ? 3500 : 1200);
  }
  await h.js(`Buddy.run('dance')`); await h.wait(500);
  ok('dance uses the new poses', /dance_/.test(await h.js('Buddy.state.look')), await h.js('Buddy.state.look'));
  await h.wait(3500);

  // ---- a custom 3D companion
  const glb = path.join(__dirname, '..', 'docs', 'sample-robot.glb');
  await h.js(`window.cy.companionSet({ type: 'model', file: ${JSON.stringify(glb)}, name: 'sample-robot.glb' })`);
  let m = null;
  for (let i = 0; i < 30 && !(m && (m.clips || m.error)); i++) { await h.wait(500); m = await h.js('window.__model'); }
  ok('custom model loads', !!(m && m.clips), m);
  ok('its clips are mapped', !!(m && m.mapped && ['idle', 'wave', 'dance'].every((k) => m.mapped.includes(k))), m && m.mapped);
  ok('Cy goes headless, the model draws', (await h.js('Buddy.state.headless')) && (await n('#modelStage canvas')) === 1);
  await h.wait(1500);
  const painted = await h.js(`(() => { const c = document.querySelector('#modelStage canvas'); const g = document.createElement('canvas'); g.width = 64; g.height = 64; const x = g.getContext('2d'); x.drawImage(c, 0, 0, 64, 64); const d = x.getImageData(0, 0, 64, 64).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n; })()`);
  ok('the model is visible', painted > 150, painted);
  await h.shot(path.join(dir, 's_model.png'));
  await h.js(`window.cy.companionSet({ type: 'cy' })`); await h.wait(1200);
  ok('back to Cy', !(await h.js('Buddy.state.headless')) && (await n('#modelStage canvas')) === 0);

  // ---- MCP server (stdio), against the demo data
  const out = await new Promise((res) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'mcp.js')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    const msgs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cy_add_todo', arguments: { project: 'billing', text: 'ZZTEST from MCP', by: 'Test' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cy_complete_todo', arguments: { todo: 'ZZTEST from MCP' } } }
    ];
    p.stdin.end(msgs.map((x) => JSON.stringify(x)).join('\n') + '\n');
    p.on('close', () => res(buf.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })));
    setTimeout(() => p.kill(), 10000);
  });
  ok('MCP initialize', out[0] && out[0].result && out[0].result.serverInfo.name === 'cy-desk');
  ok('MCP lists 6 tools', out[1] && out[1].result.tools.length === 6);
  ok('MCP adds a to-do', out[2] && /Added t_/.test(out[2].result.content[0].text));
  ok('MCP completes it', out[3] && /Done: ZZTEST/.test(out[3].result.content[0].text));
  await h.wait(1500);
  ok('the dashboard saw it', (await h.js(`T.items.some((t) => t.text === 'ZZTEST from MCP' && t.done)`)));
  const zz = await h.js(`T.items.filter((t) => t.text === 'ZZTEST from MCP').map((t) => t.id)`);
  for (const id of zz) await h.js(`window.cy.removeTodo(${JSON.stringify(id)})`);

  h.log(`${failed ? 'FAILED' : 'ALL PASSED'}: ${failed} failure(s)`);
  if (failed) process.exitCode = 1;
};
