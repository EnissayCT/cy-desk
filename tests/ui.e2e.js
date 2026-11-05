// End-to-end UI test for the premium layout. Open actions are dry-run (logged).
const fs = require('fs');
const dir = require('path').join(__dirname, 'out');
fs.mkdirSync(dir, { recursive: true });
module.exports = async (h) => {
  let failed = 0;
  const origLog = h.log;
  h.log = (...a) => { if (String(a[0]).startsWith('FAIL')) failed++; origLog(...a); };
  h.dryRun();
  const ok = (name, cond, extra = '') => h.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
  const n = (sel) => h.js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const text = (sel) => h.js(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`);
  const has = (sel, cls) => h.js(`!!(document.querySelector(${JSON.stringify(sel)})||{classList:{contains:()=>false}}).classList.contains(${JSON.stringify(cls)})`);
  const click = (sel) => h.js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  await h.wait(9000);

  ok('icons hydrated', (await n('svg.ic')) > 10 && (await n('[data-icon]')) === 0);
  const nSrv = Math.min(4, await h.js('Object.keys(C.servers).length'));
  ok('server pills (+ this PC)', (await n('#serverPills .pill-srv')) === nSrv + 1, nSrv);
  ok('health rows', (await n('#health .srv-row')) === nSrv);
  ok('gauge ticks', (await n('#health .gauge line')) === 34);
  ok('hero stats', (await n('#stats .stat')) === 4);
  ok('heatmap cells', (await n('#heat .c')) === 112);
  ok('activity subtitle', (await text('#activitySub')).includes('commits'), await text('#activitySub'));
  ok('mascot drawn', (await h.js(`Buddy.state.look`)).length > 0, await h.js(`Buddy.state.look`));
  ok('bubble has text', (await text('#bubbleText')).length > 1, await text('#bubbleText'));
  await h.shot(`${dir}\\v_full.png`);

  await click('#bell'); await h.wait(200);
  ok('alerts popover opens', await has('#alertsPop', 'on'));
  await h.js(`document.body.click()`); await h.wait(150);
  ok('alerts popover closes', !(await has('#alertsPop', 'on')));

  // Expectations come from the config, so the suite runs on any setup (npm test uses the demo).
  const G = await h.js('C.groups.map((g) => ({ id: g.id, n: g.items.length }))');
  await h.js(`document.querySelector('.nav [data-nav]:not([data-nav="overview"])').click()`); await h.wait(500);
  ok('sidebar -> first group', (await n('#plist .prow')) === G[0].n, G[0]);
  await click(`[data-tab="${G[1].id}"]`); await h.wait(500);
  ok('second tab', (await n('#plist .prow')) === G[1].n, G[1]);
  await click(`[data-tab="${G[2].id}"]`); await h.wait(500);
  ok('third tab', (await n('#plist .prow')) === G[2].n, G[2]);

  const first = await h.js('C.groups[2].items[0]');
  await click(`#plist [data-open="${first.id}"]`); await h.wait(700);
  ok('drawer opens', await has('#drawer', 'on'));
  ok('drawer title', (await text('#dTitle')) === first.name);
  // Buttons follow what the project has: a Claude session, a folder, a website.
  const want = { 'data-session': !!first.session, 'data-claude': !!(first.repo || first.folder), 'data-folder': !!(first.repo || first.folder), 'data-url': !!first.url };
  for (const [attr, expected] of Object.entries(want)) {
    ok(`button ${attr} ${expected ? 'shown' : 'hidden'}`, (await n(`#dActions [${attr}]`)) === (expected ? 1 : 0));
    if (expected) await click(`#dActions [${attr}]`);
  }
  await h.shot(`${dir}\\v_drawer.png`);

  const T1 = 'ZZTEST drawer task';
  await h.js(`document.querySelector('#dAddText').value = ${JSON.stringify(T1)}; document.querySelector('#dAdd').requestSubmit()`);
  await h.wait(1600);
  const id = await h.js(`(([...document.querySelectorAll('#dTodos .todo')].find(li => li.textContent.includes(${JSON.stringify(T1)}))||{}).dataset||{}).id`);
  ok('add in drawer', !!id, id);
  await h.js(`(() => { const el = document.querySelector('[data-edit="${id}"]'); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); el.textContent = 'ZZTEST edited'; el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await h.wait(1600);
  ok('edit', (await text(`[data-edit="${id}"]`)).includes('ZZTEST edited'));
  await click(`#dTodos [data-focus="${id}"]`); await h.wait(1600);
  ok('pin to focus', (await text('#focusList')).includes('ZZTEST edited'));
  await click(`#dTodos [data-toggle="${id}"]`); await h.wait(1800);
  ok('tick -> done list', (await text('#dDone')).includes('ZZTEST edited'));
  ok('Cy celebrates', (await h.js(`Buddy.state.emote`)) === 'love', await h.js(`Buddy.state.emote`));
  await click(`#dDone [data-del="${id}"]`); await h.wait(1600);
  ok('delete', !(await text('#drawer')).includes('ZZTEST edited'));
  await h.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`); await h.wait(600);
  ok('Esc closes drawer', !(await has('#drawer', 'on')));

  const T2 = 'ZZTEST quick task';
  await h.js(`document.querySelector('#quickItem').value = C.groups[0].items[0].id; document.querySelector('#quickText').value = ${JSON.stringify(T2)}; document.querySelector('#quickAdd').requestSubmit()`);
  await h.wait(1600);
  ok('quick add pinned', (await text('#focusList')).includes(T2));
  const id2 = await h.js(`window.__t = null; (([...document.querySelectorAll('#focusList .f-item')].find(li => li.textContent.includes(${JSON.stringify(T2)}))||{}).querySelector('[data-done]')||{dataset:{}}).dataset.done`);
  await h.js(`window.cy.removeTodo(${JSON.stringify(id2)})`); await h.wait(1600);
  ok('quick add cleanup', !(await text('#focusList')).includes(T2));

  await h.js(`const s = document.querySelector('#search'); s.value = ${JSON.stringify(first.name.slice(0, 4))}; s.dispatchEvent(new Event('input'))`); await h.wait(200);
  ok('search finds the project', (await text('#searchResults')).includes(first.name));
  await h.js(`document.querySelector('#search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`); await h.wait(700);
  ok('search Enter opens it', (await text('#dTitle')) === first.name);
  await click('#dClose'); await h.wait(500);

  for (let i = 0; i < 5; i++) { await click('#mascot'); await h.wait(120); }
  await h.wait(300);
  ok('5 pokes -> angry', (await h.js(`Buddy.state.emote`)) === 'angry');
  
  for (let i = 0; i < 8; i++) { await h.send('cursor', { x: 300 + i * 90, y: 300 }); await h.wait(50); }
  
  ok('cursor raises Cy interest', (await h.js('Buddy.state.interest')) > 0, await h.js('Buddy.state.interest'));
  await h.send('covered', true); await h.wait(200);
  ok('pauses when covered', await h.js(`document.body.classList.contains('paused')`));
  await h.send('covered', false);
  await click('#themeBtn'); await h.wait(500);
  ok('theme button', (await h.js(`document.body.dataset.theme`)) === 'dark');
  await h.js(`window.cy.setTheme('auto')`); await h.wait(300);
  await click('#refresh'); await h.wait(300);
  await h.wait(400);
  ok('refresh acknowledged', (await text('#bubbleText')).includes('Checking'), await text('#bubbleText'));
  await h.wait(9000);
  h.log(`${failed ? 'FAILED' : 'ALL PASSED'}: ${failed} failure(s)`);
  if (failed) process.exitCode = 1;
};
