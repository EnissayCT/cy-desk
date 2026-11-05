// The few things that differ between Windows, macOS and Linux: names shown to the user,
// opening a terminal (to start or resume Claude Code), finding a program on the PATH.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = process.platform;
const OS_NAME = P === 'win32' ? 'Windows' : P === 'darwin' ? 'macOS' : 'Linux';

function which(cmd) {
  try {
    const out = execFileSync(P === 'win32' ? 'where.exe' : 'which', [cmd], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).find(Boolean) || null;
  } catch { return null; }
}

// ssh: the config's choice if it exists, else whatever is on the PATH (Windows 10+ ships OpenSSH).
function sshBinary(config) {
  if (config && config.ssh && fs.existsSync(config.ssh)) return config.ssh;
  return 'ssh';
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Opens a terminal in `dir` running `args` (e.g. ['claude'] or ['claude', '--resume', id]).
function openTerminal(dir, args) {
  const detached = { detached: true, stdio: 'ignore' };
  if (P === 'win32') {
    if (which('wt.exe')) { spawn('wt.exe', ['-d', dir, ...args], detached).unref(); return true; }
    // No Windows Terminal: a PowerShell window that stays open.
    const cmd = `Set-Location -LiteralPath ${psq(dir)}; & ${args.map(psq).join(' ')}`;
    spawn('cmd.exe', ['/c', 'start', '""', 'powershell.exe', '-NoExit', '-Command', cmd], { ...detached, windowsHide: false }).unref();
    return true;
  }
  const line = `cd ${shq(dir)} && ${args.map(shq).join(' ')}`;
  if (P === 'darwin') {
    const script = `tell application "Terminal" to do script ${JSON.stringify(line)}\ntell application "Terminal" to activate`;
    spawn('osascript', ['-e', script], detached).unref();
    return true;
  }
  const terms = [['x-terminal-emulator', ['-e', 'bash', '-lc', `${line}; exec bash`]], ['gnome-terminal', ['--', 'bash', '-lc', `${line}; exec bash`]],
    ['konsole', ['-e', 'bash', '-lc', `${line}; exec bash`]], ['xfce4-terminal', ['-x', 'bash', '-lc', `${line}; exec bash`]], ['xterm', ['-e', 'bash', '-lc', `${line}; exec bash`]]];
  for (const [bin, a] of terms) if (which(bin)) { spawn(bin, a, { ...detached, cwd: dir }).unref(); return true; }
  return false;
}

// Free space on the system disk.
function systemDisk() {
  const root = P === 'win32' ? `${process.env.SystemDrive || 'C:'}\\` : '/';
  try {
    const s = fs.statfsSync(root);
    return { free: Math.round((s.bavail * s.bsize) / 1e9), total: Math.round((s.blocks * s.bsize) / 1e9) };
  } catch { return null; }
}

module.exports = { P, OS_NAME, which, sshBinary, openTerminal, systemDisk, home: os.homedir(), sep: path.sep };
