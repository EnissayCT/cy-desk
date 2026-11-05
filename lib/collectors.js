// Read-only data collection. One SSH connection per server per refresh
// (fail2ban bans after ~10 quick connections), HTTPS/TLS checks from the laptop,
// git stats from local repos.
const { spawn, execFile } = require('child_process');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Probe settings a server can override with `vars` in config.json (they become shell variables).
const DEFAULT_VARS = {
  odoo: { PG: 'db', PG_USER: 'odoo', ODOO: 'odoo', DB: 'odoo', URL: 'http://127.0.0.1:8069/web/login', BACKUP_LOG: '', BACKUP_DONE: 'backup complete', BACKUP_TIMER: '', HEALTH_LOG: '' },
  plugins: { MYSQL_DB: 'app', DELIVERIES_WHERE: '1=1', SHOPS_WHERE: '1=1' }
};

const PROBES = {
  // Odoo in Docker. Cheap queries only: never the Odoo ORM / odoo shell, never count(*) on mail_message or ir_attachment.
  odoo: String.raw`
q(){ docker exec "$PG" psql -U "$PG_USER" -d "$DB" -Atc "$1" 2>/dev/null | tr '|\n' '  '; }
echo "http	$(curl -s -o /dev/null -m 10 -w '%{http_code} %{time_total}' "$URL")"
echo "load	$(cut -d' ' -f1-3 /proc/loadavg)"
echo "cpus	$(nproc)"
echo "mem	$(free -m | awk '/Mem:/{print $2" "$7}')"
echo "disk	$(df -BG / | awk 'NR==2{gsub("G","");print $2" "$3" "$4}')"
echo "uptime	$(cut -d' ' -f1 /proc/uptime)"
echo "containers	$(docker ps -a --format '{{.Names}}:{{.State}}' | tr '\n' ' ')"
echo "started	$(docker inspect -f '{{.State.StartedAt}}' "$ODOO" 2>/dev/null)"
echo "users	$(q "select count(distinct user_id) from bus_presence where status='online' and last_poll > now()-interval '5 min'")"
echo "users_today	$(q "select count(distinct create_uid) from res_users_log where create_date >= (now() at time zone 'utc')::date")"
echo "mail	$(q "select coalesce(sum((state='outgoing')::int),0), coalesce(sum((state='exception')::int),0) from mail_mail where state in ('outgoing','exception')")"
echo "cron_late	$(q "select count(*) from ir_cron where active and nextcall < (now() at time zone 'utc') - interval '10 min'")"
echo "pg	$(q "select count(*), coalesce(extract(epoch from max(now()-xact_start))::int,0) from pg_stat_activity where datname=current_database()")"
echo "locks	$(q "select count(*) from pg_locks where not granted")"
echo "dbsize	$(q "select pg_database_size(current_database())")"
[ -n "$BACKUP_LOG" ] && echo "backup	$(date -d "$(grep "$BACKUP_DONE" "$BACKUP_LOG" 2>/dev/null | tail -1 | cut -c1-25)" +%s 2>/dev/null)"
[ -n "$BACKUP_TIMER" ] && echo "backup_next	$(systemctl show "$BACKUP_TIMER" -p NextElapseUSecRealtime --value 2>/dev/null)"
echo "certs	$(for d in /etc/letsencrypt/live/*/; do [ -f $d/cert.pem ] && echo -n "$(basename $d):$(date -d "$(openssl x509 -enddate -noout -in $d/cert.pem | cut -d= -f2)" +%s) "; done)"
[ -n "$HEALTH_LOG" ] && echo "health	$(stat -c %Y "$HEALTH_LOG" 2>/dev/null)"
echo "f2b	$(fail2ban-client status sshd 2>/dev/null | awk -F: '/Currently banned/{gsub(/ /,"",$2);print $2}')"
`,
  // A Shopify app with its own MySQL schema (settings = shops, deliveries = parcels) under PM2.
  plugins: String.raw`
m(){ mysql -N -B -e "$1" "$MYSQL_DB" 2>/dev/null | tr '\t\n' '  '; }
P="$DELIVERIES_WHERE"
echo "load	$(cut -d' ' -f1-3 /proc/loadavg)"
echo "cpus	$(nproc)"
echo "mem	$(free -m | awk '/Mem:/{print $2" "$7}')"
echo "disk	$(df -BG / | awk 'NR==2{gsub("G","");print $2" "$3" "$4}')"
echo "uptime	$(cut -d' ' -f1 /proc/uptime)"
echo "shops	$(m "SELECT COUNT(*), COALESCE(SUM(active=1),0) FROM settings WHERE $SHOPS_WHERE")"
echo "deliveries	$(m "SELECT COUNT(*) FROM deliveries WHERE $P")"
echo "today	$(m "SELECT COUNT(*) FROM deliveries WHERE $P AND created_at >= CURDATE()")"
echo "trend	$(m "SELECT DATE_FORMAT(created_at,'%Y-%m-%d'), COUNT(*) FROM deliveries WHERE $P AND created_at >= CURDATE() - INTERVAL 13 DAY GROUP BY 1 ORDER BY 1" )"
echo "pm2	$(pm2 jlist 2>/dev/null | python3 -c 'import json,sys
for p in json.load(sys.stdin):
  e=p["pm2_env"]; print("%s:%s:%s:%s" % (p["name"], e["status"], e.get("restart_time",0), e.get("pm_uptime",0)), end=" ")' 2>/dev/null)"
`,
  vps: String.raw`
echo "load	$(cut -d' ' -f1-3 /proc/loadavg)"
echo "cpus	$(nproc)"
echo "mem	$(free -m | awk '/Mem:/{print $2" "$7}')"
echo "disk	$(df -BG / | awk 'NR==2{gsub("G","");print $2" "$3" "$4}')"
echo "uptime	$(cut -d' ' -f1 /proc/uptime)"
echo "services	$(for s in $SERVICES; do echo -n "$s:$(systemctl is-active $s) "; done)"
echo "failed	$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
`
};

// Any Linux box: the vps checks plus Docker containers and PM2 apps when the tools exist.
PROBES.linux = PROBES.vps + String.raw`
echo "containers	$( (docker ps -a --format '{{.Names}}:{{.State}}' 2>/dev/null || sudo -n docker ps -a --format '{{.Names}}:{{.State}}' 2>/dev/null) | tr '\n' ' ')"
echo "pm2	$(command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | python3 -c 'import json,sys
for p in json.load(sys.stdin):
  e=p["pm2_env"]; print("%s:%s:%s:%s" % (p["name"], e["status"], e.get("restart_time",0), e.get("pm_uptime",0)), end=" ")' 2>/dev/null)"
`;

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function runSsh(cfg, server) {
  return new Promise((resolve) => {
    let script = PROBES[server.probe];
    if (!script) return resolve({ ok: false, error: `Unknown probe "${server.probe}"`, at: Date.now() });
    // Settings become shell variables, single-quoted so nothing in them is interpreted.
    const q = (v) => `'${String(v).replace(/'/g, `'"'"'`)}'`;
    const vars = { ...(DEFAULT_VARS[server.probe] || {}), ...(server.vars || {}), SERVICES: (server.services || []).join(' ') };
    script = Object.entries(vars).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k)).map(([k, v]) => `${k}=${q(v)}`).join('\n') + '\n' + script;
    const args = [
      '-i', expandHome(server.key),
      '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=10',
      server.host, 'bash -s'
    ];
    const started = Date.now();
    const child = spawn(require('./platform').sshBinary(cfg), args, { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, at: Date.now() }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const kv = {};
      for (const line of out.split(/\r?\n/)) {
        const i = line.indexOf('\t');
        if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
      }
      if (!Object.keys(kv).length) {
        return resolve({ ok: false, error: (err.trim().split('\n').pop() || `ssh exit ${code}`), at: Date.now() });
      }
      resolve({ ok: true, ms: Date.now() - started, data: parse(server.probe, kv), at: Date.now() });
    });
    child.stdin.end(script.replace(/\r/g, ''));
  });
}

const num = (s) => (s === undefined || s === '' ? null : Number(s));
const nums = (s) => (s || '').trim().split(/\s+/).filter(Boolean).map(Number);

function parseHost(kv) {
  const [load1, load5, load15] = nums(kv.load);
  const [memTotal, memAvail] = nums(kv.mem);
  const [diskTotal, diskUsed, diskFree] = nums(kv.disk);
  return {
    load: [load1, load5, load15], cpus: num(kv.cpus),
    memTotal, memAvail, diskTotal, diskUsed, diskFree,
    uptime: num(kv.uptime)
  };
}

function parse(probe, kv) {
  const host = parseHost(kv);
  if (probe === 'odoo') {
    const [code, t] = (kv.http || '').split(' ');
    const [mailOut, mailErr] = nums(kv.mail);
    const [pgConn, pgLongest] = nums(kv.pg);
    const containers = (kv.containers || '').split(' ').filter(Boolean).map((c) => {
      const [name, state] = c.split(':'); return { name, state };
    });
    return {
      host, httpCode: num(code), httpTime: t ? Number(t) : null,
      containers, started: kv.started ? Date.parse(kv.started) : null,
      users: num(kv.users), usersToday: num(kv.users_today),
      mailOutgoing: mailOut ?? 0, mailException: mailErr ?? 0,
      cronLate: num(kv.cron_late), pgConn, pgLongest, locks: num(kv.locks),
      dbSize: num(kv.dbsize),
      backupAt: kv.backup ? Number(kv.backup) * 1000 : null,
      backupNext: kv.backup_next ? Date.parse(kv.backup_next.replace(/^\w{3} /, '')) || null : null,
      certs: (kv.certs || '').split(' ').filter(Boolean).map((c) => {
        const [name, ts] = c.split(':'); return { name, expires: Number(ts) * 1000 };
      }),
      healthAt: kv.health ? Number(kv.health) * 1000 : null,
      banned: num(kv.f2b)
    };
  }
  if (probe === 'plugins') {
    const [shops, activeShops] = nums(kv.shops);
    const t = (kv.trend || '').trim().split(/\s+/).filter(Boolean);
    const trend = [];
    for (let i = 0; i + 1 < t.length; i += 2) trend.push({ day: t[i], n: Number(t[i + 1]) });
    const pm2 = (kv.pm2 || '').split(' ').filter(Boolean).map((p) => {
      const [name, status, restarts, since] = p.split(':');
      return { name, status, restarts: Number(restarts), since: Number(since) };
    });
    return { host, shops, activeShops, deliveries: num(kv.deliveries), today: num(kv.today), trend, pm2 };
  }
  if (probe === 'vps' || probe === 'linux') {
    const services = (kv.services || '').split(' ').filter(Boolean).map((s) => {
      const i = s.lastIndexOf(':'); return { name: s.slice(0, i), state: s.slice(i + 1) };
    });
    const out = { host, services, failed: (kv.failed || '').split(' ').filter(Boolean) };
    if (probe === 'linux') {
      out.containers = (kv.containers || '').split(' ').filter(Boolean).map((c) => { const [name, state] = c.split(':'); return { name, state }; });
      out.pm2 = (kv.pm2 || '').split(' ').filter(Boolean).map((p) => { const [name, st] = p.split(':'); return { name, status: st }; });
    }
    return out;
  }
  return { host };
}

function checkSite(site) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request(site.url, { method: 'GET', timeout: 12000, headers: { 'User-Agent': 'CY-Desk/0.1 (status check)' } }, (res) => {
      const ms = Date.now() - started;
      const cert = res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
      res.resume();
      resolve({ ok: res.statusCode < 500, code: res.statusCode, ms, certExpires: cert && cert.valid_to ? Date.parse(cert.valid_to) : null, at: Date.now() });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, code: null, error: e.message, at: Date.now() }));
    req.end();
  });
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function manifestVersion(repo, dir) {
  try {
    const src = fs.readFileSync(path.join(repo, dir, '__manifest__.py'), 'utf8');
    const m = src.match(/['"]version['"]\s*:\s*['"]([^'"]+)['"]/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function gitStats(repo, paths) {
  if (!repo || !fs.existsSync(repo)) return null;
  const p = paths && paths.length ? ['--', ...paths] : [];
  const [last, week, status, recent] = await Promise.all([
    git(repo, ['log', '-1', '--format=%ct%x09%s', ...p]),
    git(repo, ['rev-list', '--count', '--since=7.days', 'HEAD', ...p]),
    git(repo, ['status', '--porcelain', ...p]),
    git(repo, ['log', '-6', '--format=%ct%x09%s', ...p])
  ]);
  if (last === null) return null;
  const [ts, ...subj] = (last.trim() || '\t').split('\t');
  const versions = (paths || []).map((d) => manifestVersion(repo, d)).filter(Boolean);
  return {
    lastAt: ts ? Number(ts) * 1000 : null,
    lastSubject: subj.join('\t').slice(0, 200),
    week: Number((week || '0').trim()),
    dirty: (status || '').split('\n').filter(Boolean).length,
    version: versions[0] || null,
    recent: (recent || '').trim().split('\n').filter(Boolean).map((l) => {
      const [t, ...s] = l.split('\t'); return { at: Number(t) * 1000, subject: s.join('\t').slice(0, 160) };
    })
  };
}

// Commits per local day over the last `weeks` weeks, for the heatmap and the project dashboards.
// specs: [{ dir, label, item?, items?: [{ id, name, paths }] }]. A repo shared by several projects
// (module folders, `paths`) credits each commit to the projects whose files it touched; the rest go
// to the repo's label. emails: when given, only commits by these authors count.
const dayOf = (t) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
async function gitActivity(specs, { weeks = 16, emails = null } = {}) {
  const days = {}, perDay = {}, perItem = {}, byRepo = {};
  const mine = emails && emails.length ? new Set(emails.map((e) => e.toLowerCase())) : null;
  const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
  for (const spec of specs) {
    if (!spec.dir || !fs.existsSync(spec.dir)) continue;
    const split = (spec.items || []).filter((i) => i.paths && i.paths.length);
    const args = ['log', '--all', `--since=${weeks}.weeks`, '--format=%x01%ct%x02%ae'];
    if (split.length) args.push('--name-only');
    const out = await git(spec.dir, args);
    if (!out) continue;
    let n = 0;
    for (const chunk of out.split('\x01').slice(1)) {
      const [head, ...files] = chunk.split(/\r?\n/);
      const [ts, email] = head.split('\x02');
      if (mine && !mine.has(String(email || '').trim().toLowerCase())) continue;
      const key = dayOf(Number(ts));
      n++;
      bump(days, key);
      const hit = split.filter((i) => files.some((f) => f && i.paths.some((p) => f === p || f.startsWith(p.replace(/\/+$/, '') + '/'))));
      const labels = hit.length ? hit.map((i) => i.name) : [spec.label];
      const ids = hit.length ? hit.map((i) => i.id) : spec.item ? [spec.item] : [];
      perDay[key] = perDay[key] || {};
      for (const l of labels) bump(perDay[key], l);
      for (const id of ids) { perItem[id] = perItem[id] || {}; bump(perItem[id], key); }
    }
    if (n) bump(byRepo, spec.label, n);
  }
  return { days, perDay, perItem, byRepo, weeks, total: Object.values(days).reduce((a, b) => a + b, 0), at: Date.now() };
}

// The git root above a folder, or null.
function gitRoot(dir) {
  let d = dir;
  for (let i = 0; i < 12 && d; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

module.exports = { runSsh, checkSite, gitStats, gitActivity, gitRoot };
