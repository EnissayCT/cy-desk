// v1.2: talking to Cy (demo answers), XP and outfits, reactions to Claude sessions, weather and
// time of day, the command palette, widgets, Settings > Cy / Widgets, and the quick-add window.
// Demo mode (npm test): nothing real is touched, open actions are dry-run.
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const dir = path.join(__dirname, 'out');
fs.mkdirSync(dir, { recursive: true });
module.exports = async (h) => {
  h.dryRun();
  let failed = 0;
  const ok = (name, cond, extra = '') => { if (!cond) failed++; h.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ' :: ' + JSON.stringify(extra) : ''}`); };
  const n = (sel) => h.js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const text = (sel) => h.js(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`);
  await h.wait(8000);
  await h.js(`SETTINGS.lastBrief = dayKey(new Date()); Panels.close()`); await h.wait(300);

  // ---- talking to Cy (demo brain)
  ok('chat box on the stage', (await n('#talk input')) === 1);
  await h.js(`document.querySelector('#talkIn').value = 'How was my week?'; document.querySelector('#talk').requestSubmit()`);
  await h.wait(2200);
  ok('Cy answers in the bubble', /commits/.test(await text('#bubbleText')), await text('#bubbleText'));
  ok('the snapshot Cy reads has the dashboard', await h.js(`CyLife.snapshot().then((s) => /Open tasks: \\d+/.test(s) && /System health/.test(s) && /Commits this week/.test(s))`));

  // ---- XP: a finished task, then a level up with an unlock
  const x0 = await h.js('CyLife.xp.xp');
  const tid = await h.js(`openTodos()[0].id`);
  await h.js(`window.cy.patchTodo(${JSON.stringify(tid)}, { done: true })`);
  await h.wait(2000);
  const x1 = await h.js('CyLife.xp.xp');
  ok('a finished task gives 20 XP', x1 - x0 === 20, { before: x0, after: x1 });
  await h.js(`window.cy.patchTodo(${JSON.stringify(tid)}, { done: false })`); await h.wait(1200);
  ok('ticking it again later gives nothing more', (await h.js('CyLife.xp.xp')) === x1);
  for (let i = 0; i < 5; i++) { await h.js(`window.cy.healthLog('stretch')`); }
  await h.wait(600);
  const lv = await h.js('CyLife.xp');
  ok('XP badge shows the level', (await text('#lvlN')) === String(lv.level) && (await text('#lvlXp')).includes(`${lv.into} / ${lv.need}`));
  // force a level up: finish tasks until level 2
  const ids = await h.js(`openTodos().slice(0, 6).map((t) => t.id)`);
  for (const id of ids) await h.js(`window.cy.patchTodo(${JSON.stringify(id)}, { done: true })`);
  await h.wait(3500);
  const lv2 = await h.js('CyLife.xp');
  ok('levels up', lv2.level >= 2, lv2.level);
  ok('the level-2 item unlocks', lv2.items.find((i) => i.id === 'sunglasses').unlocked);
  await h.wait(3000);
  ok('Cy puts it on', (await h.js('Buddy.wearing')).includes('sunglasses'), await h.js('Buddy.wearing'));
  ok('outfit drawn on the face', (await n('#face .wear path')) > 0);
  await h.js(`document.querySelector('#lvl').click()`); await h.wait(300);
  ok('wardrobe opens', (await h.js(`document.querySelector('#wardrobe').classList.contains('on')`)) && (await n('#wardrobe .wr-item')) >= 8);
  ok('locked items stay locked', (await n('#wardrobe .wr-item.locked')) >= 5);
  await h.js(`document.querySelector('[data-wear="sunglasses"]').click()`); await h.wait(800);
  ok('take it off', !(await h.js('Buddy.wearing')).includes('sunglasses'));
  await h.shot(path.join(dir, 'l_wardrobe.png'));
  await h.js(`document.body.click()`);
  for (const id of ids) await h.js(`window.cy.patchTodo(${JSON.stringify(id)}, { done: false })`);
  await h.wait(1200);

  // ---- Cy and Claude sessions: a sign for one waiting, typing along with one working
  await h.js(`Buddy.run('sign', { text: 'Billing: proration', onClick: () => window.cy.openAgent(AGENTS[0]) })`); await h.wait(1200);
  ok('Cy holds up a sign', /^sign_/.test(await h.js('Buddy.state.look')), await h.js('Buddy.state.look'));
  ok('the sign reads the session', (await text('.sign-text')) === 'Billing: proration' && (await h.js(`document.querySelector('.sign-text').classList.contains('on')`)));
  const box = await h.js(`(() => { const s = document.querySelector('.sign-text').getBoundingClientRect(), m = document.querySelector('#mascot').getBoundingClientRect(); return { w: s.width / m.width, top: (s.top - m.top) / m.height }; })()`);
  ok('text sits on the board', box.w > 0.3 && box.w < 0.6 && box.top > 0.4 && box.top < 0.65, box);
  await h.shot(path.join(dir, 'l_sign.png'));
  await h.js(`document.querySelector('.sign-text').click()`); await h.wait(300); // dry-run: logged as OPEN
  await h.js(`Buddy.cancel()`); await h.wait(500);
  await h.js(`Buddy.run('type', 'Typing along…')`); await h.wait(1200);
  ok('Cy types on a laptop', /^type_/.test(await h.js('Buddy.state.look')), await h.js('Buddy.state.look'));
  await h.shot(path.join(dir, 'l_type.png'));
  await h.js(`Buddy.cancel()`); await h.wait(600);

  // ---- weather and time of day
  h.send('weather', { ok: true, condition: 'rain', tempC: 13, summary: 'Light rain', place: 'Lisbon, Portugal' }); await h.wait(700);
  ok('weather pill in the top bar', (await text('.pill-wx')).includes('13°') && (await text('.pill-wx')).includes('Lisbon'));
  ok('rain on the stage', (await n('#sky .drop')) >= 10);
  h.send('weather', { ok: true, condition: 'snow', tempC: -1, summary: 'Snow', place: 'Lisbon, Portugal' }); await h.wait(700);
  ok('snow on the stage', (await n('#sky .flake')) >= 10 && (await n('#sky .drop')) === 0);
  ok('time of day on the body', ['dawn', 'day', 'dusk', 'night'].includes(await h.js('document.body.dataset.tod')));

  // ---- command palette
  await h.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`); await h.wait(300);
  ok('Ctrl+K opens the palette', await h.js(`document.querySelector('#palette').classList.contains('on')`));
  await h.js(`(() => { const i = document.querySelector('#palIn'); i.value = 'open mon'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await h.wait(150);
  ok('fuzzy match', (await text('#palList .pal-row.sel')).includes('Open Money'), await text('#palList .pal-row.sel'));
  await h.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`); await h.wait(1600);
  ok('Enter runs it', (await h.js('Spaces.current()')) === 'money');
  await h.js(`Spaces.close()`); await h.wait(900);
  await h.js(`(() => { CyLife.openPal(); const i = document.querySelector('#palIn'); i.value = '+ ZZTEST palette task'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await h.wait(150);
  ok('+ adds a task', (await text('#palList .pal-row.sel')).includes('Add task'));
  await h.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`); await h.wait(1600);
  ok('task added from the palette', await h.js(`T.items.some((t) => t.text === 'ZZTEST palette task' && t.focus)`));
  for (const id of await h.js(`T.items.filter((t) => t.text.startsWith('ZZTEST')).map((t) => t.id)`)) await h.js(`window.cy.removeTodo(${JSON.stringify(id)})`);
  await h.js(`CyLife.openPal()`); await h.wait(100);
  await h.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await h.wait(200);
  ok('Esc closes it', !(await h.js(`document.querySelector('#palette').classList.contains('on')`)));

  // ---- widgets (the example config runs `node --version`)
  let wv = null;
  for (let i = 0; i < 20 && !(wv && wv.ok); i++) { await h.wait(500); wv = await h.js('CyLife.widgets.node || null'); }
  ok('a command widget answers', !!(wv && wv.ok && /^v\d+/.test(wv.text || '')), wv);
  await h.js(`Spaces.open('widgets')`); await h.wait(2300);
  ok('widgets space lists them', (await n('#spacePanel .wd-val')) >= 2);
  await h.shot(path.join(dir, 'l_widgets.png'));
  await h.js(`Spaces.close()`); await h.wait(900);

  // ---- Settings > Cy and > Widgets
  await h.js(`Panels.openSettings('cy')`); await h.wait(500);
  ok('Settings › Cy: key, model, weather', (await n('#cyKey')) === 1 && (await n('[data-k="chatModel"] option')) === 3 && (await n('#cyPlace')) === 1);
  await h.js(`document.querySelector('#cyKey').value = 'not-a-key'; document.querySelector('#cyKeySave').click()`); await h.wait(500);
  ok('refuses something that is not a key', /does not look like/.test(await text('#cyMsg')), await text('#cyMsg'));
  await h.js(`document.querySelector('[data-stab="widgets"]').click()`); await h.wait(300);
  await h.js(`document.querySelector('#wgTitle').value = 'Stars'; document.querySelector('#wgSource').value = 'url'; document.querySelector('#wgWhat').value = 'ftp://nope'; document.querySelector('#wgAdd').click()`); await h.wait(200);
  ok('widget URL checked', /http/.test(await text('#wgOut')));
  await h.js(`Panels.close()`); await h.wait(300);

  // ---- quick add from anywhere
  await h.js(`window.cy.quickOpen()`); await h.wait(2500);
  const qw = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('quick add'));
  ok('quick-add window opens', !!qw);
  if (qw) {
    await qw.webContents.executeJavaScript(`document.querySelector('#qText').value = 'ZZTEST from quick add'; document.querySelector('#qForm').requestSubmit()`);
    await h.wait(1800);
    ok('quick add saves and closes', (await h.js(`T.items.some((t) => t.text === 'ZZTEST from quick add')`)) && (qw.isDestroyed() || !qw.isVisible()));
    for (const id of await h.js(`T.items.filter((t) => t.text.startsWith('ZZTEST')).map((t) => t.id)`)) await h.js(`window.cy.removeTodo(${JSON.stringify(id)})`);
  }

  h.log(`${failed ? 'FAILED' : 'ALL PASSED'}: ${failed} failure(s)`);
  if (failed) process.exitCode = 1;
};
