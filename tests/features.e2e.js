// New features: agents board, this PC, focus sessions, daily brief, settings, setup wizard.
// Open actions are dry-run; the focus session and settings changes are undone at the end.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'out');
fs.mkdirSync(dir, { recursive: true });
module.exports = async (h) => {
  h.dryRun();
  let failed = 0;
  const ok = (name, cond, extra = '') => { if (!cond) failed++; h.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ' :: ' + JSON.stringify(extra) : ''}`); };
  const n = (sel) => h.js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const text = (sel) => h.js(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`);
  const has = (sel, cls) => h.js(`!!(document.querySelector(${JSON.stringify(sel)})||{classList:{contains:()=>false}}).classList.contains(${JSON.stringify(cls)})`);
  const click = (sel) => h.js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const cfgBefore = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  await h.wait(9000);

  // agents board
  await click('[data-tab="agents"]'); await h.wait(500);
  const rows = await n('#plist .prow.agent');
  ok('agents tab lists Claude sessions', rows > 0, rows);
  ok('agents show a state tag', (await n('#plist .prow.agent .tag')) === rows);
  await h.shot(path.join(dir, 'agents.png'));
  await click('#plist .prow.agent'); await h.wait(300); // dry-run: logged as OPEN session/resume
  await h.js(`document.querySelector('[data-tab="' + C.groups[0].id + '"]').click()`); await h.wait(300);

  // this PC
  ok('this PC pill', (await text('#pcPill')).includes('CPU'), await text('#pcPill'));
  await click('#pcPill'); await h.wait(300);
  ok('this PC popover', await has('#pcPop', 'on') && (await n('#pcPop .pc-row')) >= 3);
  await h.shot(path.join(dir, 'pc.png'));
  await h.js(`document.body.click()`); await h.wait(200);

  // focus session
  const firstFocus = await h.js(`(document.querySelector('#focusList [data-start]')||{dataset:{}}).dataset.start`);
  ok('focus rows have a start button', !!firstFocus);
  await h.js(`startFocus(${JSON.stringify(firstFocus)}, 25)`); await h.wait(1500);
  ok('focus banner runs', !(await has('#focusBanner', 'hidden')) && /\d\d:\d\d/.test(await text('#focusBanner')), await text('#focusBanner .fb-main b'));
  ok('Cy goes quiet', (await h.js('Buddy.state.focus')) === true);
  await h.shot(path.join(dir, 'focus.png'));
  await click('#focusStop'); await h.wait(1200);
  ok('focus stop', await has('#focusBanner', 'hidden') && (await h.js('Buddy.state.focus')) === false);

  // daily brief
  await click('#briefBtn'); await h.wait(4000);
  ok('brief opens with real data', (await n('#modal .b-stats > div')) === 4 && (await n('#modal .b-row')) > 0);
  await click('#copyStandup'); await h.wait(400);
  ok('standup copied', (await text('#copyStandup')).includes('Copied'));
  await h.shot(path.join(dir, 'brief.png'));
  await click('#modal [data-close]'); await h.wait(300);
  ok('brief closes', !(await has('#modal', 'on')));

  // settings
  await click('#settingsBtn'); await h.wait(700);
  ok('settings open', await has('#modal', 'on') && (await n('#modal .s-tabs button')) === 5);
  await h.shot(path.join(dir, 'settings-general.png'));
  for (const t of ['servers', 'sites', 'projects', 'about']) {
    await click(`[data-stab="${t}"]`); await h.wait(300);
    ok(`settings tab ${t}`, (await n('#sBody > *')) > 0);
    if (t === 'servers') {
      await h.shot(path.join(dir, 'settings-servers.png'));
      // Any server: a result (OK, or the SSH error for the demo's unroutable addresses) must come back.
      const sid = await h.js('Object.keys(C.servers)[0]');
      await click(`[data-test="${sid}"]`);
      let out = '';
      for (let i = 0; i < 40 && (!out || out === 'Testing…'); i++) { await h.wait(500); out = await text(`[data-testout="${sid}"]`); }
      ok('server test reports a result', !!out && out !== 'Testing…', out);
    }
    if (t === 'projects') await h.shot(path.join(dir, 'settings-projects.png'));
  }
  // invalid site is refused
  await click('[data-stab="sites"]'); await h.wait(200);
  await h.js(`document.querySelector('#siteUrl').value = 'http://not-https.example'; document.querySelector('#addSite').click()`); await h.wait(200);
  ok('refuses a non-https site', (await text('#sMsg')).includes('https'));
  await click('#modal [data-close]'); await h.wait(300);
  ok('config untouched by Cancel', fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8') === cfgBefore);

  // setup wizard (opened, walked, cancelled before saving)
  await h.js(`Panels.openWizard()`); await h.wait(600);
  ok('wizard opens', await has('#modal', 'wizard'));
  await h.shot(path.join(dir, 'wizard-1.png'));
  await h.js(`document.querySelector('#wName').value = ''; document.querySelector('#wNext').click()`); await h.wait(200);
  ok('wizard asks for a name first', (await text('#sMsg')).length > 0);
  await h.js(`document.querySelector('#wName').value = 'Test'; document.querySelector('#wNext').click()`); await h.wait(300);
  ok('wizard step 2 (projects)', (await text('.wz-body h2')).includes('projects'));
  await click('#wNext'); await h.wait(300);
  ok('wizard step 3 (servers)', (await text('.wz-body h2')).includes('Servers'));
  await h.shot(path.join(dir, 'wizard-3.png'));
  await click('#wSkip'); await h.wait(300);
  ok('wizard last step', (await text('.wz-body h2')).includes('set'));
  await h.shot(path.join(dir, 'wizard-4.png'));
  await h.js(`Panels.close()`); await h.wait(300);
  ok('config still untouched', fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8') === cfgBefore);

  h.log(`${failed ? 'FAILED' : 'ALL PASSED'}: ${failed} failure(s)`);
  if (failed) process.exitCode = 1;
};
