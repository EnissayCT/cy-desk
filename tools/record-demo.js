// Records a short demo of Cy for the README / CV: the stage at ~12 fps while Cy goes through
// a little show. Run:  npx electron . --demo --windowed --test=tools/record-demo.js
// then:               python tools/make_gif.py
// Open actions are dry-run; fake audio drives the singing part.
const fs = require('fs');
const path = require('path');
module.exports = async (h) => {
  h.dryRun();
  const out = path.join(__dirname, '..', 'docs', 'demo-frames');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  await h.wait(9000);
  const r = await h.js(`(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);
  let n = 0, recording = true;
  const stamps = [];
  (async function grab() {
    while (recording) { stamps.push(Date.now()); await h.shot(path.join(out, `f${String(n++).padStart(4, '0')}.png`), r); await h.wait(40); }
  })();
  const cursorSweep = async (from, to, steps) => {
    for (let i = 0; i <= steps; i++) {
      h.send('cursor', { x: from[0] + ((to[0] - from[0]) * i) / steps, y: from[1] + ((to[1] - from[1]) * i) / steps });
      await h.wait(60);
    }
  };
  await cursorSweep([100, 200], [1350, 300], 30);
  await h.wait(1200);
  await h.js(`Buddy.run('idea')`); await h.wait(3400);
  await h.js(`Buddy.run('turnAround')`); await h.wait(3000);
  await h.js(`Buddy.run('sit')`); await h.wait(2600);
  await h.js(`Buddy.poke()`); await h.wait(1400);
  for (let i = 0; i < 70; i++) {
    h.send('audio', { p: 0.16 + 0.22 * Math.abs(Math.sin(i * 0.8)) * (i % 7 < 5 ? 1 : 0.4), app: 'chrome', title: 'Lofi Beats to Code To - YouTube' });
    await h.wait(80);
  }
  for (let i = 0; i < 36; i++) { h.send('audio', { p: 0 }); await h.wait(80); }
  await h.wait(1500);
  recording = false;
  await h.wait(300);
  // real time between captures, so the GIF plays at the speed it happened
  fs.writeFileSync(path.join(out, 'timing.json'), JSON.stringify(stamps.slice(1).map((t, i) => t - stamps[i]).concat([80])));
  h.log(`frames: ${n}`);
};
