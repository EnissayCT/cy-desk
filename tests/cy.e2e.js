// Cy v3: smoothness, activities, singing.
const fs = require('fs');
const dir = require('path').join(__dirname, 'out');
fs.mkdirSync(dir, { recursive: true });
module.exports = async (h) => {
  let failed = 0;
  const origLog = h.log;
  h.log = (...a) => { if (String(a[0]).startsWith('FAIL')) failed++; origLog(...a); };
  h.dryRun();
  const ok = (name, cond, extra = '') => h.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + JSON.stringify(extra) : ''}`);
  const st = () => h.js('Buddy.state');
  const rect = async () => h.js(`(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);
  await h.wait(10000);
  await h.js(`SETTINGS.lastBrief = dayKey(new Date()); Panels.close()`); await h.wait(300);
  const R = await rect();

  // Smoothness: frame times while the head sweeps across.
  const perf = await h.js(`new Promise((res) => {
    const times = []; let last = performance.now(); const t0 = last;
    Buddy.onCursor({ x: 0, y: 300 }); Buddy.onCursor({ x: 40, y: 300 });
    (function f(t) { times.push(t - last); last = t; if (t - t0 < 2500) requestAnimationFrame(f); else {
      times.shift(); times.sort((a, b) => a - b);
      res({ frames: times.length, fps: +(times.length / 2.5).toFixed(0), p50: +times[Math.floor(times.length * 0.5)].toFixed(1), p95: +times[Math.floor(times.length * 0.95)].toFixed(1), max: +times[times.length - 1].toFixed(1) });
    } })(last);
    setTimeout(() => { for (let i = 0; i < 12; i++) setTimeout(() => Buddy.onCursor({ x: 200 + i * 110, y: 260 + i * 8 }), i * 60); }, 300);
  })`);
  // Frame pacing depends on the machine: on CI runners (no GPU, shared CPU) it is reported, not judged.
  if (process.env.CI) h.log('smooth head sweep (CI, not judged)', JSON.stringify(perf)); else ok('smooth head sweep (p95 frame time < 34 ms)', perf.p95 < 34, perf);
  // The head follows on springs: on a slow machine it can still be on its way, so give it 3 s.
  let s1 = await st();
  for (let i = 0; i < 15 && Math.abs(s1.yaw) <= 3; i++) {
    if (i % 5 === 0) await h.js(`Buddy.onCursor({ x: 1350, y: 300 })`);
    await h.wait(200); s1 = await st();
  }
  ok('head moved continuously', Math.abs(s1.yaw) > 3, { yaw: s1.yaw, mode: s1.mode, interest: s1.interest });

  const shots = [];
  async function act(name, waitMs, check) {
    await h.js(`Buddy.run('${name}')`);
    await h.wait(waitMs);
    const s = await st();
    ok(`activity ${name}`, check(s), { activity: s.activity, look: s.look, face: s.face, sitting: s.sitting });
    await h.shot(`${dir}\\c_${name}.png`, R); shots.push(name);
  }
  await act('sit', 1500, (s) => s.sitting && s.look === 'sitgaze');
  await h.js(`Buddy.poke()`); await h.wait(900);
  ok('poke makes Cy stand up', !(await st()).sitting);
  await act('idea', 900, (s) => s.face === 'idea' && s.look === 'wave_0');
  ok('idea bubble uses real data', (await h.js(`document.querySelector('#bubbleText').textContent`)).length > 8, await h.js(`document.querySelector('#bubbleText').textContent`));
  await h.wait(2500);
  await act('turnAround', 1100, (s) => s.look === 'turn');
  await h.wait(2000);
  await act('stretch', 700, (s) => s.face === 'yawn' && s.look === 'cheer');
  await h.wait(1800);
  await act('hum', 700, (s) => s.face === 'hum');
  await h.wait(3500);

  // Singing: 3 s of "music" from Chrome, then silence.
  for (let i = 0; i < 40; i++) {
    h.send('audio', { p: 0.18 + 0.16 * Math.abs(Math.sin(i * 0.9)), app: 'chrome', title: 'Daft Punk - Get Lucky (Official Audio) - YouTube - Google Chrome' });
    await h.wait(80);
  }
  let s = await st();
  ok('sings when music plays', s.singing && (s.face === 'sing' || s.face === 'singLoud'), { singing: s.singing, face: s.face });
  ok('mic is up', await h.js(`document.querySelector('#mic').classList.contains('on')`));
  ok('bubble names the song', (await h.js(`document.querySelector('#bubbleText').textContent`)).includes('Get Lucky'), await h.js(`document.querySelector('#bubbleText').textContent`));
  await h.shot(`${dir}\\c_sing.png`, R);
  for (let i = 0; i < 6; i++) { h.send('audio', { p: 0.4, app: 'chrome', title: '' }); await h.wait(80); }
  await h.shot(`${dir}\\c_sing2.png`, R);
  for (let i = 0; i < 40; i++) { h.send('audio', { p: 0 }); await h.wait(80); }
  s = await st();
  ok('stops after silence', !s.singing && !(await h.js(`document.querySelector('#mic').classList.contains('on')`)), { singing: s.singing });
  for (let i = 0; i < 30; i++) { h.send('audio', { p: 0.3, app: 'ms-teams', title: 'Meeting' }); await h.wait(80); }
  ok('never sings during a Teams call', !(await st()).singing);
  for (let i = 0; i < 10; i++) { h.send('audio', { p: 0 }); await h.wait(80); }

  // CPU while singing
  const { app } = require('electron');
  const total = () => app.getAppMetrics().reduce((a, m) => a + m.cpu.percentCPUUsage, 0);
  total(); let sum = 0;
  for (let i = 0; i < 50; i++) { h.send('audio', { p: 0.2 + 0.2 * Math.abs(Math.sin(i * 0.7)), app: 'spotify', title: 'Artist - Song' }); await h.wait(100); if (i % 10 === 9) sum += total(); }
  h.log(`CPU while singing: ${(sum / 5).toFixed(1)}% of one core`);
  for (let i = 0; i < 40; i++) { h.send('audio', { p: 0 }); await h.wait(80); }
  total(); sum = 0;
  for (let i = 0; i < 10; i++) { await h.wait(1000); sum += total(); }
  h.log(`CPU idle: ${(sum / 10).toFixed(1)}% of one core`);
  h.log(`memory: ${(app.getAppMetrics().reduce((a, m) => a + m.memory.workingSetSize, 0) / 1024).toFixed(0)} MB`);
  h.log(`${failed ? 'FAILED' : 'ALL PASSED'}: ${failed} failure(s)`);
  if (failed) process.exitCode = 1;
};
