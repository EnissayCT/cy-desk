// README screenshots, taken in demo mode so no real data shows:
//   npx electron . --demo --size=1536x920 --test=tools/screenshots.js
const fs = require('fs');
const path = require('path');
module.exports = async (h) => {
  h.dryRun();
  const out = path.join(__dirname, '..', 'docs', 'screens');
  fs.mkdirSync(out, { recursive: true });
  const shot = (name) => h.shot(path.join(out, `${name}.png`));
  const settle = () => h.js(`document.getAnimations().forEach((a) => { try { if (a.effect && a.effect.getTiming().iterations !== Infinity) a.finish(); } catch {} }); true`);
  await h.wait(7000);
  await h.js(`SETTINGS.lastBrief = dayKey(new Date()); Panels.close()`); await h.wait(300);
  await h.js(`Buddy.say('All systems normal.', 8000)`); await h.wait(600);
  await shot('dashboard-light');
  // The heatmap tooltip on a busy day.
  await h.js(`(() => { const c = [...document.querySelectorAll('.heat .c.c3, .heat .c.c2')].pop(); c.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); })()`); await h.wait(400);
  await shot('activity-tooltip');
  await h.js(`document.querySelector('#greet').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  await h.js(`document.querySelector('[data-tab="agents"]').click()`); await h.wait(700);
  await shot('agents');
  await h.js(`document.querySelector('[data-tab="client"]').click()`); await h.wait(300);
  await h.js(`startFocus(document.querySelector('#focusList [data-start]').dataset.start, 25)`); await h.wait(1500);
  await shot('focus');
  await h.js(`document.querySelector('#focusStop').click()`); await h.wait(800);
  for (const s of ['claude', 'servers', 'money', 'health']) {
    await h.js(`Spaces.open('${s}')`); await h.wait(2200); await settle(); await h.wait(300);
    await shot(`space-${s}`);
  }
  await h.js(`Spaces.open('project', 'billing')`); await h.wait(1800); await settle(); await h.wait(300);
  await shot('space-project');
  await h.js(`Spaces.close()`); await h.wait(900); await settle();
  await h.js(`document.querySelector('#briefBtn').click()`); await h.wait(1500);
  await shot('brief');
  await h.js(`Panels.close(); Panels.openSettings('claude')`); await h.wait(1500);
  await shot('settings');
  await h.js(`Panels.close()`); await h.wait(300);
  h.send('theme', 'dark'); await h.wait(800);
  await shot('dashboard-dark');
  await h.js(`Spaces.open('money')`); await h.wait(2200); await settle(); await h.wait(300);
  await shot('space-money-dark');
  h.send('theme', 'light');
  h.log('screenshots done');
};
