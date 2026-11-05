// This PC: CPU, memory, system disk, and how long the user has been working without a break
// (Windows' input idle time covers keyboard and mouse). Battery comes from the page.
const os = require('os');
const fs = require('fs');

let prev = os.cpus();
let activeSince = null;

function cpuPercent() {
  const cur = os.cpus();
  let idle = 0, total = 0;
  cur.forEach((c, i) => {
    const p = prev[i] ? prev[i].times : { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const t = c.times;
    const dt = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.idle - p.idle) + (t.irq - p.irq);
    total += dt; idle += t.idle - p.idle;
  });
  prev = cur;
  return total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
}

function disk() {
  try {
    const s = fs.statfsSync(process.env.SystemDrive ? `${process.env.SystemDrive}\\` : 'C:\\');
    return { free: Math.round((s.bavail * s.bsize) / 1e9), total: Math.round((s.blocks * s.bsize) / 1e9) };
  } catch { return null; }
}

// idleSeconds: from powerMonitor.getSystemIdleTime(). A 5-minute pause counts as a break.
function sample(idleSeconds) {
  const now = Date.now();
  if (idleSeconds >= 300) activeSince = null;
  else if (idleSeconds < 60 && !activeSince) activeSince = now - idleSeconds * 1000;
  const total = os.totalmem(), free = os.freemem();
  return {
    cpu: cpuPercent(), cores: os.cpus().length,
    mem: Math.round(100 * (1 - free / total)), memTotal: Math.round(total / 1e9),
    disk: disk(), idle: idleSeconds,
    activeMin: activeSince ? Math.round((now - activeSince) / 60000) : 0,
    uptimeH: Math.round(os.uptime() / 3600), at: now
  };
}

module.exports = { sample };
