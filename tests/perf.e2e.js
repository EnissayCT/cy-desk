// Frame pacing while spaces and projects open and close (the transitions users see most).
// Reports p50/p95/max frame time and dropped frames for each (script frames; the compositor can
// draw more). Report only: frame pacing depends on the machine. npm run test:perf
module.exports = async (h) => {
  h.dryRun();
  let failed = 0;
  await h.wait(8000);
  await h.js(`SETTINGS.lastBrief = dayKey(new Date()); Panels.close()`); await h.wait(400);
  const measure = (action, ms = 1100) => h.js(`new Promise((res) => {
    const times = []; let last = performance.now(); const t0 = last;
    (function f(t) { times.push(t - last); last = t; if (t - t0 < ${ms}) requestAnimationFrame(f); else {
      times.shift(); const s = times.slice().sort((a, b) => a - b);
      res({ frames: times.length, p50: +s[Math.floor(s.length * 0.5)].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s[s.length - 1].toFixed(1), dropped: times.filter((x) => x > 25).length });
    } })(last);
    requestAnimationFrame(() => { ${action}; });
  })`);
  const runs = [
    ['open Claude', `Spaces.open('claude')`], ['switch to Money', `Spaces.open('money')`], ['close', `Spaces.close()`],
    ['open a project', `Spaces.open('project', C.groups[0].items[0].id)`], ['close project', `Spaces.close()`],
    ['open Health', `Spaces.open('health')`], ['close again', `Spaces.close()`]
  ];
  for (const [name, action] of runs) {
    const r = await measure(action);
    h.log(`INFO ${name} :: ${JSON.stringify(r)}`);
    await h.wait(900);
  }
  h.log(`${failed ? 'FAILED' : 'ALL PASSED'}: ${failed} failure(s)`);
  if (failed) process.exitCode = 1;
};
