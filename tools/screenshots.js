// README screenshots, taken in demo mode so no real data shows:
//   npx electron . --demo --test=tools/screenshots.js
const fs = require('fs');
const path = require('path');
module.exports = async (h) => {
  h.dryRun();
  const out = path.join(__dirname, '..', 'docs', 'screens');
  fs.mkdirSync(out, { recursive: true });
  const shot = (name) => h.shot(path.join(out, `${name}.png`));
  await h.wait(7000);
  await h.js(`Buddy.say('All systems normal.', 8000)`); await h.wait(600);
  await shot('dashboard-light');
  await h.js(`document.querySelector('[data-tab="agents"]').click()`); await h.wait(700);
  await shot('agents');
  await h.js(`document.querySelector('[data-tab="client"]').click()`); await h.wait(300);
  await h.js(`startFocus(document.querySelector('#focusList [data-start]').dataset.start, 25)`); await h.wait(1500);
  await shot('focus');
  await h.js(`document.querySelector('#focusStop').click()`); await h.wait(800);
  await h.js(`document.querySelector('#briefBtn').click()`); await h.wait(1500);
  await shot('brief');
  await h.js(`Panels.close(); Panels.openSettings('servers')`); await h.wait(800);
  await shot('settings');
  await h.js(`Panels.close()`); await h.wait(300);
  h.send('theme', 'dark'); await h.wait(800);
  await shot('dashboard-dark');
  h.send('theme', 'light');
  h.log('screenshots done');
};
