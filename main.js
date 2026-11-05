const { app, BrowserWindow, ipcMain, shell, screen, Tray, Menu, nativeImage, nativeTheme, powerMonitor, clipboard, dialog, Notification } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --demo: a fictional workspace (config.example.json + generated data), no SSH, no git,
// nothing of the real data folder touched. Set up before the stores pick their folder.
const demoMode = process.argv.includes('--demo');
const windowed = process.argv.includes('--windowed') || demoMode;
if (demoMode) {
  process.env.CY_DATA_DIR = path.join(os.tmpdir(), 'cy-desk-demo');
  require('./lib/demo').seed(process.env.CY_DATA_DIR);
  fs.copyFileSync(path.join(__dirname, 'config.example.json'), path.join(process.env.CY_DATA_DIR, 'config.json'));
}
const DATA_DIR = process.env.CY_DATA_DIR || path.join(__dirname, 'data');
const collectors = require('./lib/collectors');
const todos = require('./lib/todos');
const agents = require('./lib/agents');
const focus = require('./lib/focus');
const vitals = require('./lib/vitals');
const brief = require('./lib/brief');
const demo = require('./lib/demo');

const CONFIG_FILE = demoMode ? path.join(DATA_DIR, 'config.json') : path.join(__dirname, 'config.json');
const EXAMPLE_FILE = path.join(__dirname, 'config.example.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// First run: start from the example config and show the setup wizard.
let firstRun = false;
if (!fs.existsSync(CONFIG_FILE)) {
  const example = JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8'));
  example.servers = {}; example.sites = []; example.groups = [{ id: 'work', name: 'Projects', items: [] }];
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(example, null, 2));
  firstRun = true;
}
let config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
let win = null, tray = null, quitting = false, iconsHiddenByUs = false;
// Whether anyone can see the dashboard (see the cursor loop at the bottom).
let locked = false, coveredNow = false, lastCovered = null;

// theme: 'auto' follows Windows light/dark mode.
let settings = { theme: 'auto', sing: true, breaks: true, breakMin: 90, focusMin: 25, onboarded: true, lastBrief: '' };
try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch {}
if (firstRun) settings.onboarded = false;
const SETTING_KEYS = { theme: ['auto', 'light', 'dark'], sing: 'bool', breaks: 'bool', breakMin: [45, 60, 90, 120], focusMin: [15, 25, 50, 90], onboarded: 'bool', lastBrief: 'string' };
const forced = process.argv.find((a) => a.startsWith('--theme='));
if (forced) settings.theme = forced.slice(8);
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
function resolvedTheme() {
  return settings.theme === 'auto' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : settings.theme;
}
function pushTheme() { send('theme', resolvedTheme()); }

// System audio meter (native/audiometer.exe): Windows' peak meters, nothing recorded.
// Readings go to the page, which makes Cy sing along.
// Scripted test runs feed their own readings, so real music on the machine can't skew them.
const testRun = process.argv.some((a) => a.startsWith('--test='));
let meter = null, meterRestarts = 0;
function startMeter() {
  const exe = path.join(__dirname, 'native', 'audiometer.exe');
  if (meter || quitting || testRun || !settings.sing || !fs.existsSync(exe)) return;
  meter = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  meter.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line || coveredNow) continue;
      try { send('audio', JSON.parse(line)); } catch {}
    }
  });
  meter.on('exit', () => {
    meter = null;
    if (!quitting && settings.sing && meterRestarts++ < 20) setTimeout(startMeter, 5000);
  });
}
function stopMeter() { if (meter) { try { meter.stdin.end(); meter.kill(); } catch {} meter = null; } }

// Live status, persisted so a reboot shows the last known values at once.
let status = { servers: {}, sites: {}, git: {}, history: {}, firstSeen: {}, refreshedAt: null, refreshing: false };
try { Object.assign(status, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')), { refreshing: false }); } catch {}

// One desktop copy at a time; --windowed runs (development, tests) may run beside it,
// with their own browser profile so the two don't fight over the cache.
if (windowed) app.setPath('userData', path.join(app.getPath('userData'), 'windowed'));
if (!windowed && !app.requestSingleInstanceLock()) { app.quit(); }
// Pinned to the desktop, GPU-composited frames show blocks of garbage on this
// Intel + NVIDIA laptop. Software rendering is clean, and the page is static enough
// that it costs next to nothing. --gpu turns acceleration back on to compare.
if (!process.argv.includes('--gpu')) app.disableHardwareAcceleration();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function persist() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFile(STATE_FILE, JSON.stringify({ ...status, refreshing: false }), () => {});
}

function pushHistory(key, value, max = 90) {
  if (value === null || value === undefined || Number.isNaN(value)) return;
  const h = (status.history[key] = status.history[key] || []);
  h.push([Date.now(), value]);
  if (h.length > max) h.splice(0, h.length - max);
}

// Remembers since when a condition has been true (e.g. mail stuck in the queue).
function since(key, active) {
  if (active) status.firstSeen[key] = status.firstSeen[key] || Date.now();
  else delete status.firstSeen[key];
}

async function refreshServers() {
  if (demoMode) { const d = demo.status(config); Object.assign(status, { servers: d.servers, sites: d.sites, refreshedAt: Date.now(), refreshing: false }); send('status', status); return; }
  if (status.refreshing) return;
  status.refreshing = true;
  send('status', status);
  try {
    const servers = Object.entries(config.servers);
    const [sshResults, siteResults] = await Promise.all([
      Promise.all(servers.map(([, s]) => collectors.runSsh(config, s))),
      // A failed check is retried once a few seconds later before the site counts as down:
      // one blip (or the network still waking up) is not an outage.
      Promise.all(config.sites.map(async (s) => {
        const r = await collectors.checkSite(s);
        if (r.ok) return r;
        await new Promise((res) => setTimeout(res, 4000));
        return collectors.checkSite(s);
      }))
    ]);
    servers.forEach(([id], i) => {
      const r = sshResults[i];
      const prev = status.servers[id];
      // Keep the last good data on a failed poll so the screen doesn't blank out.
      status.servers[id] = r.ok ? r : { ...r, data: prev && prev.data, lastOk: prev && (prev.ok ? prev.at : prev.lastOk) };
      if (r.ok) {
        const h = r.data.host;
        pushHistory(`${id}.load`, h.load[0]);
        pushHistory(`${id}.mem`, h.memTotal ? 1 - h.memAvail / h.memTotal : null);
      }
    });
    const o = status.servers.odoo;
    if (o && o.ok) {
      pushHistory('odoo.users', o.data.users);
      pushHistory('odoo.http', o.data.httpTime);
      since('odoo.mail', o.data.mailOutgoing > 0);
    }
    config.sites.forEach((s, i) => (status.sites[s.id] = siteResults[i]));
    status.refreshedAt = Date.now();
  } finally {
    status.refreshing = false;
    persist();
    send('status', status);
  }
  // Right after boot the network is often not up yet: try again soon instead of in 2 min.
  const failed = Object.values(status.servers).some((s) => !s.ok);
  if (failed && process.uptime() < 600) setTimeout(refreshServers, 30000);
}

async function refreshGit() {
  if (demoMode) { const d = demo.status(config); Object.assign(status, { git: d.git, activity: d.activity }); send('status', status); return; }
  const repos = new Set();
  for (const g of config.groups) { if (g.repo) repos.add(g.repo); for (const it of g.items) if (it.repo) repos.add(it.repo); }
  status.activity = await collectors.gitActivity([...repos]);
  for (const g of config.groups) {
    if (g.repo) { const all = await collectors.gitStats(g.repo, []); if (all) status.git[`__repo_${g.id}`] = all; }
    for (const item of g.items) {
      const repo = item.repo || g.repo;
      // An item without its own repo or module paths would show the whole repo's stats: skip it.
      if (!repo || (!item.repo && !(item.paths && item.paths.length))) { delete status.git[item.id]; continue; }
      const stats = await collectors.gitStats(repo, item.repo ? [] : item.paths);
      if (stats) status.git[item.id] = stats;
    }
  }
  persist();
  send('status', status);
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x: area.x, y: area.y, width: windowed ? 1440 : area.width, height: windowed ? 900 : area.height,
    frame: windowed, resizable: windowed, movable: windowed, minimizable: windowed,
    maximizable: false, fullscreenable: false, skipTaskbar: !windowed,
    backgroundColor: resolvedTheme() === 'dark' ? '#121110' : '#e7e2db', show: false, title: 'CY Desk',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false }
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => {
    if (!windowed) {
      try {
        const d = require('./lib/desktop');
        d.pin(win);
        // Icon labels draw through the window, and the desktop is the dashboard now.
        if (d.iconsVisible()) { iconsHiddenByUs = true; d.setIcons(false); }
      } catch (e) { console.error('pin failed', e); }
    }
    win.showInactive();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { openUrl(url); return { action: 'deny' }; });
  // A (re)loaded page missed earlier messages: send the covered state again.
  win.webContents.on('did-finish-load', () => { lastCovered = null; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => {
    win = null;
    // The desktop host (Explorer) going away destroys owned windows: come back.
    if (!quitting) setTimeout(createWindow, 3000);
  });
}

function fitToScreen() {
  if (!win || windowed) return;
  const area = screen.getPrimaryDisplay().workArea;
  win.setBounds(area);
}

function openUrl(url) {
  if (/^(https?:|claude:)/i.test(url)) shell.openExternal(url);
}

function trayIcon() {
  const size = 32, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 15.5, y - 15.5), a = Math.max(0, Math.min(1, 13 - d));
    const i = (y * size + x) * 4;
    buf[i] = 0x8b; buf[i + 1] = 0x5f; buf[i + 2] = 0xf2; buf[i + 3] = Math.round(a * 255); // BGRA #F25F8B
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('CY Desk');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Refresh now', click: () => { refreshServers(); refreshGit(); } },
    { label: 'Reload screen', click: () => win && win.reload() },
    { label: 'Open to-do file', click: () => shell.openPath(todos.FILE) },
    ...(windowed ? [] : [{
      label: 'Show desktop icons', type: 'checkbox', checked: require('./lib/desktop').iconsVisible(),
      click: (m) => { require('./lib/desktop').setIcons(m.checked); iconsHiddenByUs = !m.checked; }
    }]),
    { label: 'Edit projects (config.json)', click: () => shell.openPath(CONFIG_FILE) },
    {
      label: 'Cy sings along to music', type: 'checkbox', checked: settings.sing !== false,
      click: (m) => { settings.sing = m.checked; saveSettings(); send('sing', m.checked); if (m.checked) { meterRestarts = 0; startMeter(); } else stopMeter(); }
    },
    {
      label: 'Theme', submenu: [['auto', 'Follow Windows'], ['light', 'Light'], ['dark', 'Dark']].map(([id, label]) => ({
        label, type: 'radio', checked: settings.theme === id,
        click: () => { settings.theme = id; saveSettings(); pushTheme(); }
      }))
    },
    { type: 'separator' },
    {
      label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings(loginArgs()).openAtLogin,
      click: (m) => app.setLoginItemSettings({ ...loginArgs(), openAtLogin: m.checked })
    },
    { type: 'separator' },
    { label: 'Quit CY Desk', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu());
  tray.on('right-click', () => tray.setContextMenu(menu()));
}

function loginArgs() {
  // Unpackaged: electron.exe + the app folder.
  return app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(__dirname)] };
}

// ---------- IPC ----------
ipcMain.handle('init', () => ({ config, todos: todos.load(), status, user: config.user, theme: resolvedTheme(), covered: coveredNow,
  sing: settings.sing !== false, settings, focus: focus.active(), focusWeek: focusWeek(), agents: agentList, vitals: lastVitals, version: app.getVersion() }));

// ---------- agents board ----------
let agentList = [], agentKey = '';
function refreshAgents() {
  try {
    agentList = demoMode ? demo.agents() : agents.scan(config);
    const key = JSON.stringify(agentList.map((a) => [a.sessionId, a.status, a.lastAt]));
    if (key !== agentKey) { agentKey = key; send('agents', agentList); }
  } catch (e) { console.error('agents', e.message); }
}
ipcMain.handle('open:agent', (_e, a) => {
  if (!a) return false;
  if (a.localId && /^local_[0-9a-f-]+$/i.test(a.localId)) return dryRun ? opened('session', a.localId) : shell.openExternal(`claude://claude.ai/epitaxy/${a.localId}`);
  if (!a.cwd || !fs.existsSync(a.cwd) || !/^[0-9a-f-]{36}$/i.test(a.sessionId || '')) return false;
  if (dryRun) return opened('resume', `${a.cwd} ${a.sessionId}`);
  spawn('wt.exe', ['-d', a.cwd, 'claude', '--resume', a.sessionId], { detached: true, stdio: 'ignore' }).unref();
  return true;
});

// ---------- this PC ----------
let lastVitals = null;
function sampleVitals() { lastVitals = vitals.sample(powerMonitor.getSystemIdleTime()); send('vitals', lastVitals); }

// ---------- focus sessions ----------
function focusWeek() {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return focus.since(+d);
}
let focusTimer = null;
function armFocus() {
  clearTimeout(focusTimer);
  const a = focus.active();
  if (!a) return;
  focusTimer = setTimeout(() => {
    const s = focus.stop(true);
    send('focus', { active: null, ended: s, week: focusWeek() });
    if (s && Notification.isSupported() && !dryRun) new Notification({ title: 'Focus session done', body: `${s.minutes} min on “${s.text}”. Take a short break.`, silent: false }).show();
  }, Math.max(0, a.endsAt - Date.now()));
}
ipcMain.handle('focus:start', (_e, f) => { const s = focus.start(f || {}); armFocus(); send('focus', { active: s, week: focusWeek() }); return s; });
ipcMain.handle('focus:stop', () => { const s = focus.stop(false); armFocus(); send('focus', { active: null, ended: s, stopped: true, week: focusWeek() }); return s; });

// ---------- daily brief ----------
ipcMain.handle('brief:build', async (_e, alerts) => (demoMode ? demo.brief(config, todos.load())
  : brief.build({ config, todos: todos.load(), focus, agents: agentList, alerts: alerts || [], user: config.user })));
ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text || '')); return true; });

// ---------- settings & config ----------
ipcMain.handle('settings:set', (_e, patch) => {
  for (const [k, v] of Object.entries(patch || {})) {
    const rule = SETTING_KEYS[k];
    if (!rule) continue;
    if (rule === 'bool') settings[k] = !!v;
    else if (rule === 'string') settings[k] = String(v).slice(0, 40);
    else if (rule.includes(v)) settings[k] = v;
  }
  saveSettings();
  if ('theme' in (patch || {})) pushTheme();
  if ('sing' in (patch || {})) { send('sing', settings.sing); if (settings.sing) { meterRestarts = 0; startMeter(); } else stopMeter(); }
  return settings;
});
ipcMain.handle('login:get', () => app.getLoginItemSettings(loginArgs()).openAtLogin);
ipcMain.handle('login:set', (_e, on) => { app.setLoginItemSettings({ ...loginArgs(), openAtLogin: !!on }); return !!on; });
function validConfig(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.groups) || typeof c.servers !== 'object' || !Array.isArray(c.sites)) return 'Bad shape';
  for (const g of c.groups) {
    if (!g.id || !g.name || !Array.isArray(g.items)) return `Group ${g.name || '?'} is incomplete`;
    for (const it of g.items) if (!it.id || !it.name) return `A project in ${g.name} has no name`;
  }
  for (const [id, s] of Object.entries(c.servers)) if (!s.host || !/^[\w.-]+@[\w.-]+$/.test(s.host) || !s.probe) return `Server ${id}: host must look like user@address`;
  for (const s of c.sites) if (!/^https:\/\//.test(s.url || '')) return `Site ${s.host || '?'}: the address must start with https://`;
  return null;
}
ipcMain.handle('config:save', (_e, next) => {
  const err = validConfig(next);
  if (err) return { ok: false, error: err };
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
  config = next; send('config', config); refreshGit(); refreshAgents(); setTimeout(refreshServers, 500);
  return { ok: true };
});
ipcMain.handle('config:test-server', async (_e, server) => {
  if (!server || !/^[\w.-]+@[\w.-]+$/.test(server.host || '')) return { ok: false, error: 'Host must look like user@address' };
  const r = await collectors.runSsh(config, server);
  return r.ok ? { ok: true, ms: r.ms, summary: r.data && r.data.host ? `load ${r.data.host.load[0]} · ${r.data.host.diskFree} GB free` : 'connected' } : { ok: false, error: r.error };
});
ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a project folder' });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  return { dir, name: path.basename(dir), git: fs.existsSync(path.join(dir, '.git')) };
});
ipcMain.handle('dialog:key', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], title: 'Choose your SSH private key', defaultPath: path.join(require('os').homedir(), '.ssh') });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('notify', (_e, n) => { if (n && Notification.isSupported() && !dryRun) new Notification({ title: String(n.title || 'CY Desk'), body: String(n.body || '') }).show(); return true; });
ipcMain.handle('todo:add', (_e, t) => todos.add({ item: t.item, text: t.text, focus: t.focus, by: 'me' }));
ipcMain.handle('todo:patch', (_e, id, changes) => todos.patch(id, changes));
ipcMain.handle('todo:remove', (_e, id) => todos.remove(id));
ipcMain.handle('todo:move', (_e, id, index) => todos.move(id, index));
ipcMain.handle('refresh', () => { refreshServers(); refreshGit(); return true; });
ipcMain.handle('theme:set', (_e, theme) => {
  if (!['auto', 'light', 'dark'].includes(theme)) return false;
  settings.theme = theme; saveSettings(); pushTheme(); return true;
});
// In a --test run the open actions are only logged, so tests don't pop windows up.
let dryRun = false;
const opened = (kind, arg) => { console.log('OPEN', kind, arg); return true; };
ipcMain.handle('open:url', (_e, url) => (dryRun ? opened('url', url) : openUrl(url)));
ipcMain.handle('open:session', (_e, id) => {
  if (!/^local_[0-9a-f-]+$/i.test(id)) return false;
  return dryRun ? opened('session', id) : shell.openExternal(`claude://claude.ai/epitaxy/${id}`);
});
ipcMain.handle('open:folder', (_e, dir) => {
  if (!dir || !fs.existsSync(dir)) return false;
  return dryRun ? opened('folder', dir) : shell.openPath(dir);
});
ipcMain.handle('open:claude', (_e, dir) => {
  // A fresh Claude Code session in that project, in Windows Terminal.
  if (!dir || !fs.existsSync(dir)) return false;
  if (dryRun) return opened('claude', dir);
  spawn('wt.exe', ['-d', dir, 'claude'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return true;
});

// ---------- lifecycle ----------
app.whenReady().then(() => {
  // Start with Windows by default, once; the tray checkbox turns it off for good.
  const flag = path.join(DATA_DIR, '.autostart-set');
  if (!windowed && !fs.existsSync(flag)) {
    app.setLoginItemSettings({ ...loginArgs(), openAtLogin: true });
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, new Date().toISOString());
  }
  createWindow();
  buildTray();
  startMeter();

  // To-dos edited by Claude sessions (todo.js) or by hand show up within a second.
  fs.mkdirSync(path.dirname(todos.FILE), { recursive: true });
  fs.watchFile(todos.FILE, { interval: 800 }, () => send('todos', todos.load()));
  fs.watchFile(CONFIG_FILE, { interval: 2000 }, () => {
    try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); send('config', config); refreshGit(); } catch {}
  });

  screen.on('display-metrics-changed', fitToScreen);
  screen.on('display-added', fitToScreen);
  screen.on('display-removed', fitToScreen);
  powerMonitor.on('resume', () => setTimeout(() => { refreshServers(); refreshGit(); }, 8000));
  powerMonitor.on('unlock-screen', () => { locked = false; refreshServers(); });
  powerMonitor.on('lock-screen', () => { locked = true; });
  nativeTheme.on('updated', pushTheme);

  // The character's eyes follow the mouse anywhere on screen. When an app covers the
  // whole dashboard (maximized, fullscreen) or the screen is locked, nobody sees it:
  // tell the page to stop animating.
  let lastCursor = '', tick = 0;
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    if (tick++ % 6 === 0) {
      coveredNow = locked;
      if (!windowed && !locked) { try { coveredNow = require('./lib/desktop').covered(win); } catch {} }
      if (coveredNow !== lastCovered) { lastCovered = coveredNow; send('covered', coveredNow); }
    }
    if (coveredNow) return;
    const p = screen.getCursorScreenPoint(), b = win.getBounds();
    const key = `${p.x},${p.y}`;
    if (key !== lastCursor) { lastCursor = key; send('cursor', { x: p.x - b.x, y: p.y - b.y }); }
  }, 60);

  // --test=<file.js>: run a scripted UI test, then quit. The file exports
  // async (h) => {...} with h.js(code), h.shot(file, rect?), h.wait(ms), h.send(channel, payload), h.log(...).
  const testArg = process.argv.find((a) => a.startsWith('--test='));
  if (testArg) {
    win.webContents.once('did-finish-load', async () => {
      win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('CONSOLE', msg); });
      const h = {
        dryRun: () => { dryRun = true; },
        which: (cmd) => { try { return require('child_process').execFileSync('where.exe', [cmd], { encoding: 'utf8' }).trim(); } catch { return null; } },
        js: (code) => win.webContents.executeJavaScript(code),
        shot: async (file, rect) => fs.writeFileSync(file, (await win.webContents.capturePage(rect)).toPNG()),
        wait: (ms) => new Promise((r) => setTimeout(r, ms)),
        send: (ch, p) => send(ch, p),
        log: (...a) => console.log('TEST', ...a)
      };
      try { await require(path.resolve(testArg.slice(7)))(h); } catch (e) { console.log('TEST ERR', e.stack); process.exitCode = 1; }
      quitting = true; app.exit(process.exitCode || 0);
    });
  }

  // --probe=<js>: print the value of an expression evaluated in the page (used for testing).
  const probe = process.argv.find((a) => a.startsWith('--probe='));
  if (probe) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try { console.log('PROBE', JSON.stringify(await win.webContents.executeJavaScript(probe.slice(8)))); } catch (e) { console.log('PROBE ERR', e.message); }
    }, 3000));
  }

  // --shot=<file.png>: save what the window shows once data is in (used for testing).
  const shot = process.argv.find((a) => a.startsWith('--shot='));
  if (shot) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(shot.slice(7), img.toPNG());
      if (process.argv.includes('--quit')) { quitting = true; app.quit(); }
    }, Number((process.argv.find((a) => a.startsWith('--delay=')) || '--delay=14000').slice(8)));
  }

  setTimeout(() => { refreshServers(); refreshGit(); }, 1500);
  setInterval(refreshServers, (config.refreshMinutes || 2) * 60000);
  // Local, cheap: Claude transcripts (file reads only) and this PC's vitals.
  refreshAgents(); setInterval(refreshAgents, 12000);
  sampleVitals(); setInterval(sampleVitals, 5000);
  armFocus();
  setInterval(refreshGit, (config.gitRefreshMinutes || 10) * 60000);
  // If Explorer restarted, the window may still exist but lost its owner: re-pin.
  setInterval(() => {
    if (win && !windowed) { const d = require('./lib/desktop'); if (!d.hostAlive(win)) d.pin(win); }
  }, 10000);
});

app.on('before-quit', () => {
  quitting = true;
  stopMeter();
  // Leave the desktop as we found it.
  if (iconsHiddenByUs) { try { require('./lib/desktop').setIcons(true); } catch {} }
});
app.on('window-all-closed', () => { if (quitting) app.quit(); });
