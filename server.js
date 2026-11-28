// EMOS-gated sing-box gateway v1.5.21 — zero dependencies.
// Node >= 18 (uses global fetch). Run: node server.js  (PORT env, default 3000)
// Scope: EMOS login -> carrot > 500 -> console (nodes + per-user sub links)
// + NODE TOTAL traffic only, from https://1e.lol/api/nodes. NO per-user traffic.
// Subscription conventions follow sublinkPro (ZeroDeng01/sublinkPro):
// consume endpoint GET /c/?token=<shareToken>&client=<idx> alongside /sub/:token,
// client auto-detected from User-Agent or forced with client / ?format=.
// Outputs: clash, mihomo, surge, v2ray, uri, sing-box/json. See README.md.
// Protocols: hy2://, hysteria2:// and vless:// (incl. REALITY + VLESS Encryption).
'use strict';
const http = require('http');
// Last-resort nets: the dispatcher awaits every handler, so request errors
// are normally caught there. Surviving ONE stray error is fine; surviving
// many means in-memory state may be corrupt. Let systemd restart us clean.
let fatalErrCount = 0;
function noteFatal(kind, e) {
  fatalErrCount += 1;
  console.error(kind + ' (kept running, ' + fatalErrCount + '/5):', e);
  if (fatalErrCount >= 5) { console.error('too many uncaught errors, exiting for a clean restart'); process.exit(1); }
}
process.on('unhandledRejection', (e) => noteFatal('UNHANDLED REJECTION', e));
process.on('uncaughtException', (e) => noteFatal('UNCAUGHT EXCEPTION', e));
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
// v1.5.15: mihomo-backed unlock probes (zero-dependency Node side).
const unlockLib = require('./unlock');

const PORT = parseInt(process.env.PORT || '3000', 10);
const VERSION = '1.5.21';
const CONFIG_PATH = path.join(__dirname, 'config', 'nodes.json');
const CLASH_TEMPLATE_PATH = path.join(__dirname, 'config', 'templates', 'clash.yaml');
const SINGBOX_TEMPLATE_PATH = path.join(__dirname, 'config', 'templates', 'singbox.json');
const PROBE_URL = process.env.PROBE_URL || 'https://1e.lol/api/nodes';
const EMOS_BASE = process.env.EMOS_BASE || 'https://emos.best';
const SESSION_TTL_MS = Math.max(1000, parseInt(process.env.SESSION_TTL_MS || String(24 * 60 * 60 * 1000), 10) || 24 * 60 * 60 * 1000);
const CARROT_RECHECK_MS = Math.max(1000, parseInt(process.env.CARROT_RECHECK_MS || '600000', 10) || 600000);
// Hard cap on how long a link may be served while EMOS is unreachable.
// Without it every failed re-check just postpones another 60 s, so a user
// whose carrot dropped during an EMOS outage keeps a working link forever.
const CARROT_GRACE_MS = Math.max(1000, parseInt(process.env.CARROT_GRACE_MS || String(24 * 60 * 60 * 1000), 10) || 24 * 60 * 60 * 1000);
// Runtime settings (mutable — admin can change them without a restart).
// Precedence at startup: env var > config/settings.json > default.
// CARROT_THRESHOLD: strict, carrot must be > this. SHARE_TTL_HOURS: 0 = never.
// PROBE_CACHE_SECONDS: how long the 1e.lol probe response is cached.
let CARROT_THRESHOLD = 500;
let SHARE_TTL_HOURS = 0; // 0 = never expires (v1.5.13: the old 24 h default killed every link a day after login)
let PROBE_CACHE_MS = 30 * 1000;
function shareTtlMs() {
  return Number.isFinite(SHARE_TTL_HOURS) && SHARE_TTL_HOURS > 0 ? SHARE_TTL_HOURS * 3600 * 1000 : null;
}
const SETTINGS_PATH = path.join(__dirname, 'config', 'settings.json');
const SETTINGS_SOURCES = { carrot_threshold: 'default', share_ttl_hours: 'default', name_rule: 'default', probe_cache_seconds: 'default' };

// --- unlock checks (mihomo-backed) ---------------------------------------
// Results are keyed by node.key and persisted to config/unlock.json (0600).
// A full check runs on boot (deferred) and every 24 h; clients read the
// cached result via GET /api/unlock. No per-user data is stored here.
const UNLOCK_PATH = process.env.EMOS_UNLOCK_FILE || path.join(__dirname, 'config', 'unlock.json');
const UNLOCK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UNLOCK_ENABLED = process.env.UNLOCK_ENABLED === '1';
const MIHOMO_BIN = process.env.MIHOMO_BIN || path.join(__dirname, 'mihomo');
let unlockData = { updatedAt: null, results: {} };   // key -> {providers|error, updatedAt}
let unlockRunning = false;
let unlockLastError = null;
// Live progress of the current (or most recent) scan, so the UI can show
// which node is being checked and how long it has taken instead of a bare
// "检测中…". Null until the first run starts. Shape: { phase, startedAt,
// finishedAt, currentKey, currentIndex, total, done, failed, nodeStartedAt,
// lastUpdateAt, error }. `phase` is starting|checking|finished|failed.
let unlockProgress = null;
// Runtime on/off switch persisted alongside results, so a console user can
// disable detection without an env change/restart. Defaults to UNLOCK_ENABLED.
let unlockRuntimeEnabled = UNLOCK_ENABLED;

function atomicWriteUnlock() {
  try {
    fs.mkdirSync(path.dirname(UNLOCK_PATH), { recursive: true });
    const tmp = UNLOCK_PATH + '.tmp-' + process.pid;
    unlockData.enabled = unlockRuntimeEnabled;
    fs.writeFileSync(tmp, JSON.stringify(unlockData, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, UNLOCK_PATH);
    try { fs.chmodSync(UNLOCK_PATH, 0o600); } catch (e) { /* Windows */ }
  } catch (e) { console.error('Failed to save unlock data:', e.message); }
}
function loadUnlock() {
  try {
    const doc = JSON.parse(fs.readFileSync(UNLOCK_PATH, 'utf8'));
    if (doc && typeof doc === 'object' && doc.results && typeof doc.results === 'object') {
      unlockData = { updatedAt: doc.updatedAt || null, results: doc.results };
      if (typeof doc.enabled === 'boolean') unlockRuntimeEnabled = doc.enabled;
    }
  } catch (e) { /* first run or unreadable — start empty */ }
}
function unlockPublic() {
  const results = {};
  for (const [key, v] of Object.entries(unlockData.results)) {
    // strip anything that could carry node credentials; expose only status
    const out = { updatedAt: v && v.updatedAt ? v.updatedAt : null };
    if (v && v.error) out.error = v.error;
    if (v && v.providers) {
      out.providers = {};
      for (const [prov, r] of Object.entries(v.providers)) {
        out.providers[prov] = { status: r && r.status ? r.status : 'unknown' };
        if (r && r.region) out.providers[prov].region = r.region;
        if (r && r.reason) out.providers[prov].reason = r.reason;
        if (r && r.detail) out.providers[prov].detail = r.detail;
      }
    }
    results[key] = out;
  }
  return { ok: true, enabled: unlockRuntimeEnabled, available: UNLOCK_ENABLED,
    running: unlockRunning, updatedAt: unlockData.updatedAt, lastError: unlockLastError,
    progress: unlockProgress, providers: unlockLib.PROVIDERS, results };
}
// Scheduled/timer entry: honours the runtime switch + concurrency guard.
async function runUnlock() {
  if (!UNLOCK_ENABLED || !unlockRuntimeEnabled || unlockRunning) return;
  unlockRunning = true;
  try { await doUnlock(); }
  finally { unlockRunning = false; }
}
// Actual scan. Sets no flags itself so the manual endpoint can mark `running`
// before returning (avoids a false "finished" on the client's first poll).
async function doUnlock() {
  if (!fs.existsSync(MIHOMO_BIN)) {
    unlockLastError = 'mihomo binary not found at ' + MIHOMO_BIN + ' — run ./manage.sh install-mihomo';
    console.error('Unlock check skipped:', unlockLastError);
    return;
  }
  const nodes = NODES.map((n) => ({ key: n.key, link: n.link || n.hy2_link || null, region: n.region || n.country || '' }));
  if (!nodes.length) return;
  unlockLastError = null;
  unlockProgress = { phase: 'starting', startedAt: Date.now(), finishedAt: null,
    currentKey: null, currentIndex: 0, total: nodes.length, done: 0, failed: 0,
    nodeStartedAt: null, lastUpdateAt: Date.now(), error: null };
  const bump = (key, status, result) => {
    const p = unlockProgress, now = Date.now();
    if (!p) return;
    if (status === 'starting') p.phase = 'starting';
    else if (status === 'started') p.phase = 'checking';
    else if (status === 'checking') {
      p.phase = 'checking'; p.currentKey = key; p.currentIndex = p.done + 1; p.nodeStartedAt = now;
    } else if (status === 'done' || status === 'error') {
      p.done += 1; p.currentIndex = p.done; p.nodeStartedAt = null;
      if (status === 'error' || (result && result.error)) p.failed += 1;
    }
    p.lastUpdateAt = now;
  };
  try {
    const results = await unlockLib.runUnlockCheck(nodes, MIHOMO_BIN, { timeout: 8000, onProgress: bump });
    unlockData.results = results;
    unlockData.updatedAt = new Date().toISOString();
    atomicWriteUnlock();
    if (unlockProgress) {
      unlockProgress.phase = 'finished'; unlockProgress.finishedAt = Date.now();
      unlockProgress.currentKey = null; unlockProgress.nodeStartedAt = null;
      unlockProgress.lastUpdateAt = Date.now();
    }
    console.log('Unlock check complete for ' + Object.keys(results).length + ' nodes');
  } catch (e) {
    unlockLastError = e.message;
    if (unlockProgress) {
      unlockProgress.phase = 'failed'; unlockProgress.finishedAt = Date.now();
      unlockProgress.error = e.message; unlockProgress.lastUpdateAt = Date.now();
    }
    console.error('Unlock check failed:', e.message);
  }
}

let NODES = [];
let NAME_RULE = '[$Flag] $LinkCountryName - $Name';
let NODES_NOTE = 'DEMO TEMPLATE — Replace links with real nodes.';
// config/nodes.json is git-ignored: once the admin saves real nodes it holds
// credentials. On a fresh clone, seed it from the tracked example at 0600.
try {
  if (!fs.existsSync(CONFIG_PATH)) {
    const example = path.join(__dirname, 'config', 'nodes.example.json');
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, CONFIG_PATH);
      try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (e) { /* Windows */ }
      console.log('config/nodes.json seeded from nodes.example.json');
    }
  }
} catch (e) { console.error('Failed to seed config/nodes.json:', e.message); }
try {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  NODES = Array.isArray(raw.nodes) ? raw.nodes : [];
  if (typeof raw._note === 'string' && raw._note) NODES_NOTE = raw._note;
  if (typeof raw.name_rule === 'string' && raw.name_rule.trim()) NAME_RULE = raw.name_rule.trim();
} catch (e) {
  console.error('Failed to load config/nodes.json:', e.message);
  NODES = [];
}
// Startup settings precedence: env > config/settings.json > default.
// (Admin PUT /api/admin/settings writes settings.json and applies in-memory
// immediately; a later restart with the env var set reverts to the env value.)
(function applyStartupSettings() {
  const envInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  const t = envInt(process.env.CARROT_THRESHOLD);
  if (t !== null && t >= 0) { CARROT_THRESHOLD = t; SETTINGS_SOURCES.carrot_threshold = 'env'; }
  const ttl = parseFloat(process.env.SHARE_TTL_HOURS || '');
  if (Number.isFinite(ttl) && ttl >= 0) { SHARE_TTL_HOURS = ttl; SETTINGS_SOURCES.share_ttl_hours = 'env'; }
  const pcs = envInt(process.env.PROBE_CACHE_SECONDS);
  if (pcs !== null && pcs > 0) { PROBE_CACHE_MS = pcs * 1000; SETTINGS_SOURCES.probe_cache_seconds = 'env'; }
  let file = null;
  try { file = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch (e) { /* no settings file yet */ }
  if (file && typeof file === 'object') {
    if (SETTINGS_SOURCES.carrot_threshold !== 'env' && typeof file.carrot_threshold === 'number' && file.carrot_threshold >= 0) { CARROT_THRESHOLD = Math.floor(file.carrot_threshold); SETTINGS_SOURCES.carrot_threshold = 'settings'; }
    if (SETTINGS_SOURCES.share_ttl_hours !== 'env' && typeof file.share_ttl_hours === 'number' && file.share_ttl_hours >= 0) { SHARE_TTL_HOURS = file.share_ttl_hours; SETTINGS_SOURCES.share_ttl_hours = 'settings'; }
    if (SETTINGS_SOURCES.probe_cache_seconds !== 'env' && typeof file.probe_cache_seconds === 'number' && file.probe_cache_seconds > 0) { PROBE_CACHE_MS = Math.floor(file.probe_cache_seconds) * 1000; SETTINGS_SOURCES.probe_cache_seconds = 'settings'; }
    if (typeof file.name_rule === 'string' && file.name_rule.trim()) { NAME_RULE = file.name_rule.trim(); SETTINGS_SOURCES.name_rule = 'settings'; }
  }
})();

// --- subscription templates (sublinkPro-style, plain placeholders) -------
// config/templates/clash.yaml: {{PROXIES}} {{GROUPS}} {{RULES}}
// config/templates/singbox.json: {{OUTBOUNDS}} {{PROXY_TAGS_JSON}} {{DEFAULT_TAG}}
// Missing template files fall back to the built-in strings below.
const BUILTIN_CLASH_TEMPLATE = 'proxies:\n{{PROXIES}}\nproxy-groups:\n{{GROUPS}}\nrule-providers:\n{{RULE_PROVIDERS}}\nrules:\n{{RULES}}\n';
const BUILTIN_SINGBOX_TEMPLATE = '{\n  "log": { "level": "info", "timestamp": true },\n'
  + '  "dns": {\n    "servers": [\n      { "tag": "dns-remote", "address": "tls://8.8.8.8", "detour": "PROXY" },\n'
  + '      { "tag": "dns-direct", "address": "223.5.5.5", "detour": "direct" }\n    ],\n'
  + '    "rules": [{ "outbound": "any", "server": "dns-direct" }],\n    "final": "dns-remote", "strategy": "ipv4_only"\n  },\n'
  + '  "inbounds": [{ "type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 7890 }],\n'
  + '  "outbounds": {{OUTBOUNDS}},\n'
  + '  "route": {\n    "rules": [\n      { "protocol": "dns", "outbound": "dns-out" },\n      { "ip_is_private": true, "outbound": "direct" }\n    ],\n'
  + '    "final": "PROXY", "auto_detect_interface": true\n  }\n}\n';
function loadTemplate(p, fallback) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return fallback; }
}
let CLASH_TEMPLATE = loadTemplate(CLASH_TEMPLATE_PATH, BUILTIN_CLASH_TEMPLATE);
let SINGBOX_TEMPLATE = loadTemplate(SINGBOX_TEMPLATE_PATH, BUILTIN_SINGBOX_TEMPLATE);

// Sample fallback — values copied from live 1e.lol/api/nodes on 2026-11-26.
// ONLY used when the live probe fetch fails; responses are labelled sample:true.
// Never present these as live data.
const SAMPLE_PROBE = [
  { id: 2, name: 'Nuyek', country: 'US', online: true, expires_at: '2027-11-14', day_rx: 1170645409, day_tx: 303375558, month_rx: 14030933662, month_tx: 4589289084, month_used: 18620222746, traffic_limit: 8796093022208, traffic_mode: 'sum', traffic_reset_day: 1, month_start: '2026-11-01', metrics: { cpu: 0, net_rx: 26259, net_tx: 2520, uptime: 125458 } },
  { id: 22, name: 'Raksmart', country: 'US', online: true, expires_at: '2026-12-25', day_rx: 106716302, day_tx: 114857291, month_rx: 8803404166, month_tx: 7768455587, month_used: 16571859753, traffic_limit: 1099511627776, traffic_mode: 'sum', traffic_reset_day: 1, month_start: '2026-11-01', metrics: { cpu: 1.0, net_rx: 2410, net_tx: 2671, uptime: 86356 } },
  { id: 20, name: '伤心的云', country: 'HK', online: true, expires_at: '2026-12-22', day_rx: 34698138, day_tx: 43898440, month_rx: 40575411285, month_tx: 42388808469, month_used: 82964219754, traffic_limit: 1099511627776, traffic_mode: 'sum', traffic_reset_day: 1, month_start: '2026-11-01', metrics: { cpu: 1.0, net_rx: 264, net_tx: 774, uptime: 125073 } },
];

const sessions = new Map(); // sessionId -> {user_id, username, carrot, emosToken, demo, expiresAt, lastCarrotCheck, shareToken}
// Share record (sublinkPro-style, one per login; refresh rotates, disable blocks):
// {token, user_id, sessionId, created_at, expires_at (null = never), enabled,
//  access_count, last_ip, last_user_agent, last_access_at}
const shares = new Map(); // shareToken -> share
function createShare(sessionId, userId) {
  const token = randHex(16);
  const now = Date.now();
  const ttl = shareTtlMs();
  const share = {
    id: randHex(8), token, user_id: userId, sessionId,
    created_at: now,
    expires_at: ttl ? now + ttl : null,
    enabled: true, access_count: 0, last_ip: null, last_user_agent: null, last_access_at: null,
    // v1.5.13: the carrot gate lives on the share, not on the 24 h login
    // session. emosToken is the EMOS token used for re-checks;
    // lastCarrotCheck/lastCarrotOkAt drive the 10 min re-check + 24 h grace;
    // disabledBy is null | 'user' | 'admin' | 'system' (who disabled it).
    emosToken: null, carrot: null, lastCarrotCheck: now, lastCarrotOkAt: now, disabledBy: null,
  };
  shares.set(token, share);
  return share;
}
function getShare(token) {
  const s = shares.get(token);
  if (!s || !s.enabled) return null;
  if (s.expires_at && Date.now() > s.expires_at) return null;
  return s;
}
function shareInfo(s) {
  if (!s) return null;
  return { id: s.id || null, token: s.token, user_id: s.user_id, created_at: s.created_at, expires_at: s.expires_at, enabled: s.enabled, access_count: s.access_count, last_ip: s.last_ip, last_user_agent: s.last_user_agent, last_access_at: s.last_access_at };
}
// --- Client IP behind a reverse proxy ------------------------------------
// A reverse proxy terminates the TCP connection, so socket.remoteAddress is
// always the proxy itself (often "::ffff:127.0.0.1"). The real client IP
// arrives in a forwarding header. Those headers are attacker-controlled on a
// direct connection, so they are honoured only when the peer is a trusted
// proxy. Override with TRUST_PROXY=1 (always) or TRUST_PROXY=0 (never).
const TRUST_PROXY_MODE = (process.env.TRUST_PROXY || 'auto').toLowerCase();
// XFF is a chain "client, proxy1, proxy2": a proxy appends the address it saw
// at the right end. Reading right-to-left by the number of trusted hops stops
// a client-supplied fake XFF from overriding the real address. Default 1 hop
// (one local reverse proxy); set 2+ for chained proxies / CDN + nginx.
const TRUST_PROXY_HOPS = Math.min(16, Math.max(1, parseInt(process.env.TRUST_PROXY_HOPS || '1', 10) || 1));
// Optional allow-list of proxy peers (comma-separated IPs or IPv4 CIDRs).
// When set, 'auto' trusts ONLY these peers instead of any loopback/private IP.
const TRUST_PROXY_IPS = (process.env.TRUST_PROXY_IPS || '').split(',').map((x) => x.trim()).filter(Boolean);
// Optional preferred header, e.g. cf-connecting-ip behind Cloudflare.
const CLIENT_IP_HEADER = (process.env.CLIENT_IP_HEADER || '').trim().toLowerCase();
const IP_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip', 'forwarded'];

function normalizeIp(raw) {
  if (typeof raw !== 'string') return null;
  let a = raw.trim();
  if (!a) return null;
  a = a.replace(/^for=/i, '').trim().replace(/^"(.*)"$/, '$1').trim(); // RFC 7239 for="..."
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (bracketed) a = bracketed[1];                                      // [2001:db8::1]:443
  else if (/^[^:]+:\d+$/.test(a) && net.isIP(a.split(':')[0]) === 4) a = a.split(':')[0];
  a = a.replace(/^::ffff:/i, '').replace(/%[A-Za-z0-9._-]+$/, '');     // IPv4-mapped / zone id
  return net.isIP(a) ? a : null;
}
function ipInEntry(ip, entry) {
  if (entry === ip) return true;
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(entry);
  if (!m || net.isIP(ip) !== 4 || net.isIP(m[1]) !== 4) return false;
  const bits = parseInt(m[2], 10);
  if (bits < 0 || bits > 32) return false;
  const toInt = (x) => x.split('.').reduce((n, v) => ((n << 8) | Number(v)) >>> 0, 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(m[1]) & mask);
}
function isTrustedProxyPeer(remote) {
  const a = normalizeIp(remote);
  if (!a) return false;
  if (TRUST_PROXY_IPS.length) return TRUST_PROXY_IPS.some((e) => ipInEntry(a, e));
  if (a === '::1') return true;
  if (/^127\./.test(a)) return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(a)) return true;   // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/i.test(a)) return true;   // fe80::/10 link local
  return false;
}
function proxyTrusted(peer, mode) {
  if (mode === '1' || mode === 'true' || mode === 'always') return true;
  if (mode === '0' || mode === 'false' || mode === 'never') return false;
  return isTrustedProxyPeer(peer);
}
function forwardingChain(headers) {
  const names = CLIENT_IP_HEADER
    ? [CLIENT_IP_HEADER].concat(IP_HEADERS.filter((n) => n !== CLIENT_IP_HEADER))
    : IP_HEADERS;
  for (const name of names) {
    const raw = headers && headers[name];
    const v = Array.isArray(raw) ? raw.join(',') : raw;
    if (typeof v !== 'string' || !v.trim()) continue;
    let parts;
    if (name === 'forwarded') {
      parts = v.split(',').map((part) => {
        const m = /\bfor\s*=\s*("[^"]+"|\[[^\]]+\]|[^;,\s]+)/i.exec(part);
        return m ? m[1] : null;
      });
    } else if (name === 'x-forwarded-for') {
      parts = v.split(',');
    } else {
      parts = [v];
    }
    const chain = parts.map(normalizeIp).filter(Boolean);
    if (chain.length) return { name, chain, raw: v };
  }
  return null;
}
function pickClientIp(peer, headers, mode, hops) {
  const trusted = proxyTrusted(peer, mode || TRUST_PROXY_MODE);
  if (trusted) {
    const f = forwardingChain(headers);
    if (f) {
      const idx = Math.max(0, f.chain.length - (hops || TRUST_PROXY_HOPS));
      return { ip: f.chain[idx], source: f.name, trusted: true, headers: f.raw, chain: f.chain };
    }
  }
  return { ip: normalizeIp(peer) || (typeof peer === 'string' ? peer : null), source: 'peer', trusted, headers: null, chain: [] };
}
// Kept exported with its original 3-arg signature for test/check-pages.js.
function resolveClientIp(remoteAddress, xff, mode) {
  return pickClientIp(remoteAddress, typeof xff === 'string' ? { 'x-forwarded-for': xff } : {}, mode, TRUST_PROXY_HOPS).ip;
}
function clientIp(req) {
  return pickClientIp(req.socket && req.socket.remoteAddress, req.headers, TRUST_PROXY_MODE, TRUST_PROXY_HOPS).ip;
}
function ipDiagnostics(req) {
  const peer = req.socket && req.socket.remoteAddress;
  const r = pickClientIp(peer, req.headers, TRUST_PROXY_MODE, TRUST_PROXY_HOPS);
  const seen = {};
  for (const n of IP_HEADERS) {
    const v = req.headers[n];
    seen[n] = typeof v === 'string' ? v : null;
  }
  let hint;
  if (r.source === 'peer' && !r.trusted) {
    hint = '当前连接来源不被信任：设置 TRUST_PROXY=1，或用 TRUST_PROXY_IPS 指定反代 IP。';
  } else if (r.source === 'peer') {
    hint = '反代没有传递任何客户端 IP 头：请配置 X-Forwarded-For（Nginx: proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;）或 X-Real-IP。';
  } else {
    hint = '已获取到真实客户端 IP（来源：' + r.source + '）。';
  }
  return { ok: true, peer: peer || null, peer_normalized: normalizeIp(peer), resolved: r.ip, source: r.source,
    proxy_trusted: r.trusted, trust_proxy_mode: TRUST_PROXY_MODE, trust_proxy_hops: TRUST_PROXY_HOPS,
    chain: r.chain, headers: seen, hint };
}

// --- rate limiting (anti brute-force / anti abuse) -----------------------
// Generic per-key counter in a sliding window. Admin login counts FAILURES
// only: 5 wrong guesses lock that IP for 15 min; a correct login clears it.
// Windows are env-overridable so the regression test can use short ones.
const rateLimits = new Map(); // key -> {count, resetAt}
function rateLimitHit(key, max, windowMs) {
  const now = Date.now();
  let e = rateLimits.get(key);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; rateLimits.set(key, e); }
  e.count += 1;
  return e.count <= max;
}
function rateLimitCheck(req, res, key, max, windowMs) {
  if (rateLimitHit(key, max, windowMs)) return true;
  sendJson(res, 429, { ok: false, error: 'too many requests, try again later' });
  return false;
}
const ADMIN_LOGIN_MAX_FAILS = parseInt(process.env.ADMIN_LOGIN_MAX_FAILS || '5', 10) || 5;
const ADMIN_LOGIN_LOCK_MS = parseInt(process.env.ADMIN_LOGIN_LOCK_MS || String(15 * 60 * 1000), 10) || 15 * 60 * 1000;
const adminLoginFails = new Map(); // ip -> {count, firstAt}
function adminLoginBlocked(ip) {
  const e = adminLoginFails.get(ip);
  return !!e && e.count >= ADMIN_LOGIN_MAX_FAILS && Date.now() - e.firstAt < ADMIN_LOGIN_LOCK_MS;
}
function adminLoginFail(ip) {
  const now = Date.now();
  const e = adminLoginFails.get(ip);
  if (!e || now - e.firstAt > ADMIN_LOGIN_LOCK_MS) adminLoginFails.set(ip, { count: 1, firstAt: now });
  else e.count += 1;
}
// Hourly sweep: expired sessions/shares/admin sessions used to be deleted
// only on access, so a session that is never used again sat in memory
// forever (slow memory leak). v1.5.13: shares are NOT deleted when their
// session expires — the link outlives the 24 h console login; only a share
// past its own expires_at is pruned.
setInterval(() => {
  let pruned = false;
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now > s.expiresAt) { pruned = true; sessions.delete(sid); }
  }
  for (const [tok, s] of shares) {
    if (s.expires_at && now > s.expires_at) { pruned = true; shares.delete(tok); }
  }
  for (const [sid, s] of adminSessions) if (now > s.expiresAt) { pruned = true; adminSessions.delete(sid); }
  for (const [k, v] of rateLimits) if (now > v.resetAt) rateLimits.delete(k);
  for (const [ip, v] of adminLoginFails) if (now - v.firstAt > ADMIN_LOGIN_LOCK_MS) adminLoginFails.delete(ip);
  if (pruned) saveStateNow();
  prunePendingEmosLogins();
}, 60 * 60 * 1000).unref();

function randHex(n) { return crypto.randomBytes(n).toString('hex'); }
// Security headers on every response: no MIME sniffing (a subscription
// body must never be executed as script), no Referer leakage of token
// URLs, no framing (the console/admin have state-changing buttons).
function securityHeaders() {
  return { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
}
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders() });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return; // keep draining so the response can be written
      data += c;
      if (data.length > 65536) tooLarge = true;
    });
    req.on('end', () => {
      if (tooLarge) {
        const e = new Error('request body too large'); e.status = 413; return reject(e);
      }
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function baseUrl(req) {
  // Same base as the EMOS callback: PUBLIC_URL wins, else Host header.
  // (Previously this ignored PUBLIC_URL, so with a public domain the
  // callback was https://domain/... while subscription links were
  // http://127.0.0.1:port/... — now they agree.)
  return publicBaseUrl(req);
}
function getSession(req) {
  // Session id comes from the X-Session header (manual token / demo login)
  // or from the HttpOnly emos_session cookie set by the /link callback.
  // parseCookies is defined below (admin section) but hoisted, so usable here.
  let sid = req.headers['x-session'];
  if (typeof sid !== 'string' || !sid) sid = parseCookies(req).emos_session;
  if (!sid || typeof sid !== 'string') return null;
  const s = sessions.get(sid);
  if (!s) return null;
  // v1.5.14 (H1): an expired console session must NOT delete the share.
  // The subscription link outlives the login session by design; only the
  // share's own expires_at / an explicit revoke may kill it. The hourly
  // sweeper and loadState() already follow this rule — keep this path in
  // sync, otherwise one console poll after 24 h revokes every client.
  if (Date.now() > s.expiresAt) { sessions.delete(sid); return null; }
  return { sid, ...s };
}

// --- admin backend ---------------------------------------------------------
// Single-owner admin (Simon only). No user accounts, no default token.
// ADMIN_TOKEN env is required: without it every /api/admin/* call is 503.
// Login issues a random HttpOnly cookie session (24h, in-memory); API calls
// also accept X-Admin-Token: <ADMIN_TOKEN or admin session id>.
// Admin credentials are never logged and never appear in URLs.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const adminSessions = new Map(); // adminSessionId -> {createdAt, expiresAt}

// --- durable state: sessions/shares/admin sessions survive restarts -------
// Before v1.5.0 these lived only in memory, so every manage.sh update
// (which restarts the service) invalidated every subscription link and
// logged every user out. Now they are persisted to config/state.json
// (0600, git-ignored, included in manage.sh backups) and reloaded on boot.
// The file holds live EMOS Bearer tokens: never log it, never commit it,
// never include it in a push. Pending EMOS logins (10-min TTL) and rate
// limit counters are deliberately NOT persisted: an interrupted login is
// just retried, and a restart clears any admin-login lockout.
const STATE_PATH = process.env.EMOS_STATE_FILE || path.join(__dirname, 'config', 'state.json');
let stateDirty = false;
function saveStateNow() {
  try {
    const doc = { v: 1, sessions: [...sessions.entries()], shares: [...shares.entries()], adminSessions: [...adminSessions.entries()] };
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = STATE_PATH + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, STATE_PATH);
    fs.chmodSync(STATE_PATH, 0o600);
    stateDirty = false;
  } catch (e) { console.error('Failed to save state:', e.message); }
}
function markStateDirty() { stateDirty = true; }
// Access counts / last-IP are informational: flush them at most every 30 s
// instead of rewriting the file on every subscription fetch. Structural
// changes (login, refresh, disable, revoke, logout) save immediately.
setInterval(() => { if (stateDirty) saveStateNow(); }, 30 * 1000).unref();
function loadState() {
  let raw;
  try { raw = fs.readFileSync(STATE_PATH, 'utf8'); } catch (e) { return; } // first run: no file yet
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.sessions) || !Array.isArray(doc.shares) || !Array.isArray(doc.adminSessions)) throw new Error('bad shape');
    const now = Date.now();
    for (const [sid, s] of doc.sessions) {
      if (typeof sid !== 'string' || !s || typeof s !== 'object' || typeof s.user_id !== 'string' || typeof s.expiresAt !== 'number' || now > s.expiresAt) continue;
      if (typeof s.lastCarrotOkAt !== 'number') s.lastCarrotOkAt = now; // pre-1.5.5 state files
      sessions.set(sid, s);
    }
    for (const [tok, s] of doc.shares) {
      if (typeof tok !== 'string' || !s || typeof s !== 'object') continue;
      if (s.expires_at && now > s.expires_at) continue;
      // v1.5.13: shares outlive login sessions, so a share no longer needs
      // a live session to load. Backfill the carrot-check fields from its
      // session when available (pre-1.5.13 state files); otherwise the share
      // serves during the grace window only, until the user logs in again.
      if (typeof s.emosToken !== 'string' || !s.emosToken) {
        const sess = typeof s.sessionId === 'string' ? sessions.get(s.sessionId) : null;
        if (sess && typeof sess.emosToken === 'string' && sess.emosToken) {
          s.emosToken = sess.emosToken;
          s.lastCarrotCheck = typeof sess.lastCarrotCheck === 'number' ? sess.lastCarrotCheck : now;
          s.lastCarrotOkAt = typeof sess.lastCarrotOkAt === 'number' ? sess.lastCarrotOkAt : now;
          if (typeof sess.carrot === 'number') s.carrot = sess.carrot;
        } else {
          s.emosToken = null;
          s.lastCarrotCheck = 0;
          s.lastCarrotOkAt = now;
        }
      }
      if (typeof s.lastCarrotCheck !== 'number') s.lastCarrotCheck = 0;
      if (typeof s.lastCarrotOkAt !== 'number') s.lastCarrotOkAt = now;
      // A disabled share with no recorded reason is treated as user-disabled
      // (stays dead on re-login); only 'system' shares are re-enabled.
      if (typeof s.disabledBy !== 'string') s.disabledBy = s.enabled ? null : 'user';
      shares.set(tok, s);
    }
    for (const [sid, s] of doc.adminSessions) {
      if (typeof sid !== 'string' || !s || typeof s !== 'object' || typeof s.expiresAt !== 'number' || now > s.expiresAt) continue;
      adminSessions.set(sid, s);
    }
    console.log('state restored: ' + sessions.size + ' sessions, ' + shares.size + ' shares, ' + adminSessions.size + ' admin sessions');
  } catch (e) {
    console.error('State file unreadable, starting empty:', e.message);
    try { fs.renameSync(STATE_PATH, STATE_PATH + '.corrupt-' + Date.now()); } catch (_) { /* leave it */ }
  }
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  h.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
      catch (e) { /* malformed cookie value (e.g. %ZZ): skip that cookie */ }
    }
  });
  return out;
}
function getAdminSession(req) {
  if (!ADMIN_TOKEN) return null;
  const header = req.headers['x-admin-token'];
  if (typeof header === 'string' && header) {
    const hb = Buffer.from(header), ab = Buffer.from(ADMIN_TOKEN);
    if (hb.length === ab.length && crypto.timingSafeEqual(hb, ab)) return { via: 'header-token' };
    const s = adminSessions.get(header);
    if (s && Date.now() < s.expiresAt) return { via: 'header-session', id: header };
    if (s) adminSessions.delete(header);
  }
  const cookie = parseCookies(req).admin_session;
  if (cookie) {
    const s = adminSessions.get(cookie);
    if (s && Date.now() < s.expiresAt) return { via: 'cookie', id: cookie };
    if (s) adminSessions.delete(cookie);
  }
  return null;
}
// Returns true when authorised; otherwise sends 503 (no ADMIN_TOKEN) or 401.
function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) { sendJson(res, 503, { ok: false, error: 'admin not configured: set ADMIN_TOKEN env and restart the server' }); return false; }
  if (!getAdminSession(req)) { sendJson(res, 401, { ok: false, error: 'admin login required — POST /api/admin/login or send X-Admin-Token' }); return false; }
  return true;
}
function maskToken(t) {
  if (!t) return '';
  return t.slice(0, 6) + '…';
}
function adminShareInfo(s) {
  return { id: s.id || null, token_masked: maskToken(s.token), user_id: s.user_id, created_at: s.created_at, expires_at: s.expires_at, enabled: s.enabled, disabled_by: s.disabledBy || null, access_count: s.access_count, last_ip: normalizeIp(s.last_ip) || s.last_ip, last_user_agent: s.last_user_agent, last_access_at: s.last_access_at };
}
function findShareByRef(ref) {
  if (!ref) return null;
  if (shares.has(ref)) return shares.get(ref);
  for (const s of shares.values()) if (s.id === ref) return s;
  return null;
}
// Atomic write: temp file in the same dir + rename. nodes.json also keeps a
// one-generation backup (nodes.json.bak) of the previous version.
function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp-' + process.pid;
  // 0600 from creation, not chmod-after-write: nodes.json can hold real
  // node credentials. Windows ignores the mode but accepts the call.
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (e) { /* Windows */ }
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (e) { /* Windows */ }
}
// Subscription bodies (clash/singbox/links/b64) depend only on NODES and
// NAME_RULE, not on the user/token — the per-user part (Subscription-Userinfo)
// is a separate header. Cache the rendered bodies and invalidate whenever
// nodes or the naming rule change, so a flood of subscription fetches does
// not re-parse every node link and re-merge the ACL rule set each time.
let configEpoch = 0;
const subBodyCache = new Map(); // format -> { epoch, body }
function bumpSubCache() { configEpoch += 1; subBodyCache.clear(); }
function cachedSubBody(format, build) {
  const hit = subBodyCache.get(format);
  if (hit && hit.epoch === configEpoch) return hit.body;
  const body = build();
  subBodyCache.set(format, { epoch: configEpoch, body });
  return body;
}

function saveNodesConfig() {
  const prev = path.join(__dirname, 'config', 'nodes.json.bak');
  try { fs.copyFileSync(CONFIG_PATH, prev); fs.chmodSync(prev, 0o600); } catch (e) { /* first save / Windows */ }
  const doc = { _note: NODES_NOTE, name_rule: NAME_RULE, nodes: NODES };
  atomicWrite(CONFIG_PATH, JSON.stringify(doc));
  bumpSubCache();
}
function saveSettingsFile() {
  const doc = {
    carrot_threshold: CARROT_THRESHOLD,
    share_ttl_hours: SHARE_TTL_HOURS,
    name_rule: NAME_RULE,
    probe_cache_seconds: Math.floor(PROBE_CACHE_MS / 1000),
  };
  atomicWrite(SETTINGS_PATH, JSON.stringify(doc, null, 2) + '\n');
  return doc;
}
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'node';
}
function uniqueKey(base) {
  let key = base, i = 2;
  while (NODES.some((n) => n.key === key)) { key = base + '-' + i; i += 1; }
  return key;
}
// Node expiry: stored as a YYYY-MM-DD date string in nodes.json.
// null = not set (shown as —), undefined = invalid input (caller 400s).
function normalizeExpiry(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  const d = new Date(s);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}
function validateProbeId(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isInteger(n) || n <= 0) return undefined; // invalid marker
  return n;
}
function parseAnyLink(link, fallbackName) {
  if (typeof link !== 'string') return { protocol: '', parsed: null };
  const l = link.trim();
  if (l.startsWith('vless://')) return { protocol: 'vless', parsed: parseVless(l, fallbackName) };
  if (l.startsWith('hy2://') || l.startsWith('hysteria2://')) return { protocol: 'hy2', parsed: parseHy2(l, fallbackName) };
  return { protocol: '', parsed: null };
}
function nodeAdminView(n, probeMap) {
  const parsed = parseNodeLink(n, n.name);
  const p = probeMap ? probeMap.get(n.probe_node_id) : null;
  return {
    key: n.key, name: n.name, region: n.region || '', protocol: nodeProtocol(n),
    link: nodeLink(n),
    server: parsed ? parsed.server : null, server_port: parsed ? parsed.server_port : null,
    sni: parsed ? (parsed.sni || (parsed.tls && parsed.tls.server_name) || null) : null,
    link_name: parsed ? parsed.tag : null,
    probe_node_id: n.probe_node_id ?? null, probe_name: p ? p.name : (n.probe_name || null), expires_at: normalizeExpiry(n.expires_at), expires_at_probe: normalizeExpiry(p ? p.expires_at : null),
    online: p ? !!p.online : null, probe_missing: !p,
  };
}

// decodeURIComponent throws URIError on a literal '%' that is not a valid
// escape. A link with such a password/fragment must NOT silently vanish from
// the subscription; keep the raw text instead.
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

// --- hy2:// link parsing -------------------------------------------------
// hysteria2:// and hy2:// are both accepted (sublinkPro convention).
// Userinfo is percent-decoded ONCE: both of these preserve the full credential
//   hy2://user:pass@host:port   -> password "user:pass"
//   hy2://user%3Apass@host:port -> password "user:pass" (URL keeps %3A in
//   username; decodeURIComponent once turns it into the colon)
// Single-password links (hy2://onlypass@host) keep password "onlypass".
// Preserved params: sni, insecure, obfs, obfs-password, pinSHA256,
// ports (port-hopping range, e.g. 20000-50000), hop-interval.
function parseHy2(link, fallbackName) {
  try {
    const u = new URL(link);
    if (u.protocol !== 'hysteria2:' && u.protocol !== 'hy2:') return null;
    // Decode userinfo once. Note: URL already splits user:pass on a literal
    // colon, but leaves %3A encoded inside username — decode once recovers it.
    const rawUserinfo = u.username + (u.password ? ':' + u.password : '');
    const password = safeDecode(rawUserinfo);
    if (!password || !u.hostname) return null;
    const port = parseInt(u.port || '443', 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const params = u.searchParams;
    const sni = params.get('sni') || u.hostname;
    const insecure = params.get('insecure') === '1' || params.get('insecure') === 'true';
    const obfs = params.get('obfs');
    const obfsPassword = params.get('obfs-password');
    const pinSHA256 = params.get('pinSHA256') || params.get('pin-sha256') || null;
    const ports = params.get('ports') || params.get('port-hopping') || null;
    const hopInterval = params.get('hop-interval') || params.get('hopInterval') || null;
    const name = safeDecode(u.hash ? u.hash.slice(1) : '') || fallbackName;
    const out = {
      type: 'hysteria2', tag: name, server: u.hostname, server_port: port,
      version: 2, password, network: 'udp',
      tls: { enabled: true, server_name: sni, insecure },
    };
    if (pinSHA256) out.tls.pinSHA256 = pinSHA256;
    if (obfs === 'salamander' && obfsPassword) out.obfs = { type: 'salamander', password: obfsPassword };
    else if (obfs && obfs !== 'none') out.obfs = { type: obfs, password: obfsPassword || '' };
    if (ports) out.ports = ports;
    if (hopInterval) out.hopInterval = hopInterval;
    return out;
  } catch (e) { return null; }
}

// --- vless:// link parsing -------------------------------------------------
// vless://<uuid>@<host>:<port>?<query>#<name>
// Preserved exactly (sublinkPro REALITY convention):
//   encryption, flow, security, sni, fp, pbk, sid, type, path, host,
//   serviceName, mode, alpn, spx, pqv.
//   support-x25519mlkem768: "true"/"1" -> true, "false"/"0" -> false,
//   absent -> undefined (true/false stay distinct from omission — never
//   default it). spx/pqv map to reality-opts spider-x / mldsa65-verify in
//   Clash and are preserved verbatim in the URI output; when absent they
//   are simply absent, never invented.
//   security=reality -> tls.reality in sing-box, reality-opts in Clash,
//   reality-public-key / reality-short-id in Surge.
//   encryption is kept verbatim (e.g. mlkem768x25519plus.native.0rtt....).
function parseVless(link, fallbackName) {
  try {
    const u = new URL(link);
    if (u.protocol !== 'vless:') return null;
    const uuid = safeDecode(u.username);
    if (!uuid || !u.hostname) return null;
    const port = parseInt(u.port || '443', 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const p = u.searchParams;
    const rawSupport = p.get('support-x25519mlkem768');
    let support;
    if (rawSupport === 'true' || rawSupport === '1') support = true;
    else if (rawSupport === 'false' || rawSupport === '0') support = false;
    // any other value: leave undefined (do not guess)
    const security = (p.get('security') || 'none').toLowerCase();
    if (security === 'reality' && !p.get('pbk')) return null; // REALITY needs pbk; without it the config silently degrades to plain TLS
    const name = safeDecode(u.hash ? u.hash.slice(1) : '') || fallbackName;
    return {
      type: 'vless', tag: name, server: u.hostname, server_port: port,
      uuid, flow: p.get('flow') || undefined,
      encryption: p.get('encryption') || undefined,
      network: (p.get('type') || 'tcp').toLowerCase(), security,
      sni: p.get('sni') || undefined, fp: p.get('fp') || undefined,
      pbk: p.get('pbk') || undefined, sid: p.get('sid') || undefined,
      supportX25519MLKEM768: support,
      spx: p.get('spx') || undefined, pqv: p.get('pqv') || undefined,
      path: p.get('path') || undefined, host: p.get('host') || undefined,
      serviceName: p.get('serviceName') || undefined,
      mode: p.get('mode') || undefined, alpn: p.get('alpn') || undefined,
      rawLink: link,
    };
  } catch (e) { return null; }
}

// Generic node link: "link" accepts any supported scheme (hy2://,
// hysteria2://, vless://); "hy2_link" is the legacy field and still works.
function nodeLink(n) { return n.link || n.hy2_link || null; }
function nodeProtocol(n) {
  const l = nodeLink(n);
  if (!l) return '';
  if (l.startsWith('vless://')) return 'vless';
  if (l.startsWith('hy2://') || l.startsWith('hysteria2://')) return 'hy2';
  return '';
}
function parseNodeLink(n, fallbackName) {
  const link = nodeLink(n);
  if (!link) return null;
  if (link.startsWith('vless://')) return parseVless(link, fallbackName);
  return parseHy2(link, fallbackName);
}
// Rule variables: $Flag, $LinkCountryName, $Name, $Protocol, $Index,
// $DuplicateIndex (0 for first of a name, 1 for the second, ...).
// Default rule (config/nodes.json "name_rule"): "[$Flag] $LinkCountryName - $Name"
const COUNTRY_NAMES = {
  HK: '香港', US: '美国', JP: '日本', SG: '新加坡', KR: '韩国', GB: '英国',
  DE: '德国', FR: '法国', CA: '加拿大', AU: '澳大利亚', NL: '荷兰', TW: '台湾',
  CN: '中国', IN: '印度', ID: '印度尼西亚', TH: '泰国', VN: '越南', MY: '马来西亚',
  PH: '菲律宾', RU: '俄罗斯', BR: '巴西', TR: '土耳其', AE: '阿联酋',
};
function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '';
  const c = cc.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(127397 + c.charCodeAt(0), 127397 + c.charCodeAt(1));
}
function shortName(n) {
  // Config names are "US · Nuyek" style; $Name is the part after "· ".
  const name = String(n.name || n.key || '');
  const i = name.indexOf('·');
  return (i >= 0 ? name.slice(i + 1) : name).trim() || name;
}
function flagAtStart(s) {
  // True if s starts with a regional-indicator flag emoji (two code points
  // U+1F1E6..U+1F1FF). Such a name is already decorated — keep it as-is
  // instead of adding another flag via the naming rule.
  const cps = Array.from(String(s || ''));
  return cps.length >= 2
    && cps[0].codePointAt(0) >= 0x1F1E6 && cps[0].codePointAt(0) <= 0x1F1FF
    && cps[1].codePointAt(0) >= 0x1F1E6 && cps[1].codePointAt(0) <= 0x1F1FF;
}
function displayNames() {
  // Render each node's display name once, assigning $DuplicateIndex by
  // counting identical base names (rule with $DuplicateIndex removed).
  const seen = new Map();
  return NODES.map((n, idx) => {
    const cc = String(n.region || n.country || '').toUpperCase();
    const proto = nodeProtocol(n) || 'hy2';
    const name = shortName(n);
    // Name already starts with a flag (e.g. "🇭🇰 reality-1-v4" from a
    // vless link fragment): keep it as-is, do not double-add a flag.
    if (flagAtStart(name)) {
      const dup = seen.get(name) || 0;
      seen.set(name, dup + 1);
      return (name + (dup ? ' ' + dup : '')).replace(/\s+/g, ' ').trim();
    }
    const base = NAME_RULE
      .replace(/\$DuplicateIndex/g, () => '')
      .replace(/\$Flag/g, () => flagEmoji(cc))
      .replace(/\$LinkCountryName/g, () => COUNTRY_NAMES[cc] || cc)
      .replace(/\$Name/g, () => name)
      .replace(/\$Protocol/g, () => proto)
      .replace(/\$Index/g, () => String(idx));
    const dup = seen.get(base) || 0;
    seen.set(base, dup + 1);
    const tag = NAME_RULE
      .replace(/\$DuplicateIndex/g, () => String(dup))
      .replace(/\$Flag/g, () => flagEmoji(cc))
      .replace(/\$LinkCountryName/g, () => COUNTRY_NAMES[cc] || cc)
      .replace(/\$Name/g, () => name)
      .replace(/\$Protocol/g, () => proto)
      .replace(/\$Index/g, () => String(idx))
      .replace(/\s+/g, ' ').trim();
    return tag;
  });
}
function parsedNodes() {
  // Parsed outbounds (hy2 + vless) with sublinkPro display names as tags.
  const names = displayNames();
  const out = [];
  NODES.forEach((n, i) => {
    const o = parseNodeLink(n, n.name);
    if (!o) return;
    o.tag = names[i];
    o._node = n;
    out.push(o);
  });
  return out;
}
function renamedLink(n, displayTag) {
  // URI output: original link (hy2 or vless) with the fragment replaced by
  // the display name (sublinkPro returns one stored node URI per line for
  // client=uri). For a name that already is the link fragment (flag-kept
  // vless names) this round-trips to the original link verbatim.
  try {
    const u = new URL(nodeLink(n));
    u.hash = '#' + encodeURIComponent(displayTag);
    return u.toString();
  } catch (e) { return nodeLink(n); }
}

// --- sing-box outbound conversion ----------------------------------------
// hy2 parsed objects are already sing-box-shaped; vless needs conversion.
function vlessToSingBox(o) {
  const out = {
    type: 'vless', tag: o.tag, server: o.server, server_port: o.server_port,
    uuid: o.uuid,
  };
  if (o.flow) out.flow = o.flow;
  // VLESS Encryption: included verbatim. Upstream stock sing-box does NOT
  // (yet) accept an "encryption" field on vless outbounds — it is supported
  // by Xray and by sing-box forks (sing-box-lx / TodayCore, which document
  // exactly this field). Never silently dropped; see README.
  if (o.encryption) out.encryption = o.encryption;
  if (o.security && o.security !== 'none') {
    const tls = { enabled: true };
    if (o.sni) tls.server_name = o.sni;
    if (o.alpn) tls.alpn = o.alpn.split(',').map((s) => s.trim()).filter(Boolean);
    if (o.fp) tls.utls = { enabled: true, fingerprint: o.fp };
    if (o.security === 'reality' && o.pbk) {
      tls.reality = { enabled: true, public_key: o.pbk };
      if (o.sid) tls.reality.short_id = o.sid;
      // support-x25519mlkem768 has no sing-box field: the hybrid PQ key
      // exchange is applied automatically for supported uTLS fingerprints.
      // spx/pqv likewise have no sing-box outbound fields; they survive in
      // the URI output and in Clash reality-opts.
    }
    out.tls = tls;
  }
  if (o.network === 'ws') {
    out.transport = { type: 'ws', path: o.path || '/', headers: { Host: o.host || o.sni || o.server } };
  } else if (o.network === 'grpc') {
    out.transport = { type: 'grpc', service_name: o.serviceName || '' };
  } else if (o.network === 'xhttp') {
    out.transport = { type: 'xhttp', path: o.path || '/', host: o.host || o.sni || undefined };
  }
  return out;
}
function toSingBoxOutbound(o) {
  if (o.type === 'vless') return vlessToSingBox(o);
  const { _node, ...rest } = o;
  // sing-box hysteria2 has no ports-range field: keep the first (listen)
  // port; the range is preserved in the URI / Clash outputs.
  return rest;
}

function buildSingBoxConfig() {
  const outbounds = parsedNodes();
  const tags = outbounds.map((o) => o.tag);
  const first = tags[0] || 'direct';
  const full = [
    ...outbounds.map((o) => toSingBoxOutbound(o)),
    { type: 'selector', tag: 'PROXY', outbounds: tags, default: first },
    { type: 'urltest', tag: 'AUTO', outbounds: tags, url: 'https://www.gstatic.com/generate_204', interval: '5m' },
    { type: 'direct', tag: 'direct' },
    { type: 'block', tag: 'block' },
    { type: 'dns', tag: 'dns-out' },
  ];
  const rendered = SINGBOX_TEMPLATE
    .replace('{{OUTBOUNDS}}', () => JSON.stringify(full, null, 2))
    .replace('{{PROXY_TAGS_JSON}}', () => JSON.stringify(tags))
    .replace('{{DEFAULT_TAG}}', () => JSON.stringify(first));
  return JSON.parse(rendered);
}

function yamlStr(s) { return JSON.stringify(String(s == null ? '' : s)); }

// ACL4SSR AdblockPlus rules for Clash (mihomo / FlClash).
// The .ini Simon linked (ACL4SSR/Clash/config/ACL4SSR_AdblockPlus.ini) is NOT
// a Clash YAML template — it is a Sub-Store/ACL definition: `ruleset=<group>,<list>`
// maps a rule list to a proxy group, and `custom_proxy_group=` defines the
// groups. A converter merges a proxy list with it to produce a Clash config.
// We do that merge here: each .list becomes an http rule-provider, each
// ruleset becomes a RULE-SET rule, groups follow the .ini's custom_proxy_group
// lines (same emoji names, same order). Lists are fetched by the CLIENT from
// raw.githubusercontent (they update upstream); only GEOIP,CN is inline.
const ACL_BASE = 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/';
const ACL_RULE_SETS = [
  { name: 'LocalAreaNetwork', file: 'Clash/LocalAreaNetwork.list', group: '🎯 全球直连', behavior: 'classical' },
  { name: 'BanAD', file: 'Clash/BanAD.list', group: '🛑 全球拦截', behavior: 'classical' },
  { name: 'BanProgramAD', file: 'Clash/BanProgramAD.list', group: '🍃 应用净化', behavior: 'classical' },
  { name: 'BanEasyList', file: 'Clash/BanEasyList.list', group: '🆎 AdBlock', behavior: 'classical' },
  { name: 'BanEasyListChina', file: 'Clash/BanEasyListChina.list', group: '🆎 AdBlock', behavior: 'classical' },
  { name: 'BanEasyPrivacy', file: 'Clash/BanEasyPrivacy.list', group: '🆎 AdBlock', behavior: 'classical' },
  { name: 'GoogleCN', file: 'Clash/GoogleCN.list', group: '🎯 全球直连', behavior: 'classical' },
  { name: 'SteamCN', file: 'Clash/Ruleset/SteamCN.list', group: '🎯 全球直连', behavior: 'classical' },
  { name: 'Microsoft', file: 'Clash/Microsoft.list', group: 'Ⓜ️ 微软服务', behavior: 'classical' },
  { name: 'Apple', file: 'Clash/Apple.list', group: '🍎 苹果服务', behavior: 'classical' },
  { name: 'ProxyMedia', file: 'Clash/ProxyMedia.list', group: '🌍 国外媒体', behavior: 'classical' },
  { name: 'Telegram', file: 'Clash/Telegram.list', group: '📲 电报信息', behavior: 'classical' },
  { name: 'ProxyLite', file: 'Clash/ProxyLite.list', group: '🚀 节点选择', behavior: 'classical' },
  { name: 'ChinaDomain', file: 'Clash/ChinaDomain.list', group: '🎯 全球直连', behavior: 'classical' },
  { name: 'ChinaCompanyIp', file: 'Clash/ChinaCompanyIp.list', group: '🎯 全球直连', behavior: 'ipcidr' },
];
function buildClashYaml() {
  const outs = parsedNodes();
  const proxyLines = [];
  for (const o of outs) {
    if (o.type === 'vless') {
      proxyLines.push('  - name: ' + yamlStr(o.tag));
      proxyLines.push('    type: vless');
      proxyLines.push('    server: ' + yamlStr(o.server));
      proxyLines.push('    port: ' + o.server_port);
      proxyLines.push('    uuid: ' + yamlStr(o.uuid));
      proxyLines.push('    network: ' + yamlStr(o.network || 'tcp'));
      proxyLines.push('    tls: ' + (o.security === 'tls' || o.security === 'reality' ? 'true' : 'false'));
      if (o.flow) proxyLines.push('    flow: ' + yamlStr(o.flow));
      if (o.sni) proxyLines.push('    servername: ' + yamlStr(o.sni));
      if (o.fp) proxyLines.push('    client-fingerprint: ' + yamlStr(o.fp));
      if (o.alpn) proxyLines.push('    alpn: ' + yamlStr(o.alpn));
      if (o.security === 'reality' && o.pbk) {
        proxyLines.push('    reality-opts:');
        proxyLines.push('      public-key: ' + yamlStr(o.pbk));
        if (o.sid) proxyLines.push('      short-id: ' + yamlStr(o.sid));
        // support-x25519mlkem768: true/false only when explicitly present;
        // absent stays absent (sublinkPro convention).
        if (typeof o.supportX25519MLKEM768 === 'boolean') proxyLines.push('      support-x25519mlkem768: ' + (o.supportX25519MLKEM768 ? 'true' : 'false'));
        if (o.spx) proxyLines.push('      spider-x: ' + yamlStr(o.spx));
        if (o.pqv) proxyLines.push('      mldsa65-verify: ' + yamlStr(o.pqv));
      }
      if (o.network === 'ws') {
        proxyLines.push('    ws-opts:');
        proxyLines.push('      path: ' + yamlStr(o.path || '/'));
        proxyLines.push('      headers:');
        proxyLines.push('        Host: ' + yamlStr(o.host || o.sni || o.server));
      }
      if (o.network === 'grpc') {
        proxyLines.push('    grpc-opts:');
        proxyLines.push('      grpc-service-name: ' + yamlStr(o.serviceName || ''));
      }
      continue;
    }
    proxyLines.push('  - name: ' + yamlStr(o.tag));
    proxyLines.push('    type: hysteria2');
    proxyLines.push('    server: ' + yamlStr(o.server));
    proxyLines.push('    port: ' + o.server_port);
    proxyLines.push('    password: ' + yamlStr(o.password));
    proxyLines.push('    sni: ' + yamlStr(o.tls.server_name));
    if (o.tls.insecure) proxyLines.push('    skip-cert-verify: true');
    if (o.tls.pinSHA256) proxyLines.push('    fingerprint: ' + yamlStr(o.tls.pinSHA256));
    if (o.ports) proxyLines.push('    ports: ' + yamlStr(o.ports));
    if (o.obfs) {
      proxyLines.push('    obfs: ' + yamlStr(o.obfs.type));
      if (o.obfs.password) proxyLines.push('    obfs-password: ' + yamlStr(o.obfs.password));
    }
  }
  const names = outs.map((o) => o.tag);
  const list = '[' + names.map(yamlStr).join(', ') + ']';
  // Groups follow the .ini's custom_proxy_group lines (same names/order).
  // The `.*` suffix in the .ini is a proxy filter meaning "all proxies";
  // here that is the explicit node list.
  const groupLines = [
    '  - name: 🚀 节点选择',
    '    type: select',
    '    proxies: [' + ['♻️ 自动选择', 'DIRECT'].map(yamlStr).join(', ') + (names.length ? ', ' + names.map(yamlStr).join(', ') : '') + ']',
    '  - name: ♻️ 自动选择',
    '    type: url-test',
    '    proxies: ' + list,
    '    url: https://www.gstatic.com/generate_204',
    '    interval: 300',
    '    tolerance: 50',
    '  - name: 🌍 国外媒体',
    '    type: select',
    '    proxies: [' + ['🚀 节点选择', '♻️ 自动选择', '🎯 全球直连'].map(yamlStr).join(', ') + (names.length ? ', ' + names.map(yamlStr).join(', ') : '') + ']',
    '  - name: 📲 电报信息',
    '    type: select',
    '    proxies: [' + ['🚀 节点选择', '🎯 全球直连'].map(yamlStr).join(', ') + (names.length ? ', ' + names.map(yamlStr).join(', ') : '') + ']',
    '  - name: Ⓜ️ 微软服务',
    '    type: select',
    '    proxies: [' + ['🎯 全球直连', '🚀 节点选择'].map(yamlStr).join(', ') + (names.length ? ', ' + names.map(yamlStr).join(', ') : '') + ']',
    '  - name: 🍎 苹果服务',
    '    type: select',
    '    proxies: [' + ['🚀 节点选择', '🎯 全球直连'].map(yamlStr).join(', ') + (names.length ? ', ' + names.map(yamlStr).join(', ') : '') + ']',
    '  - name: 🎯 全球直连',
    '    type: select',
    '    proxies: [' + ['DIRECT', '🚀 节点选择', '♻️ 自动选择'].map(yamlStr).join(', ') + ']',
    '  - name: 🛑 全球拦截',
    '    type: select',
    '    proxies: [REJECT, DIRECT]',
    '  - name: 🍃 应用净化',
    '    type: select',
    '    proxies: [REJECT, DIRECT]',
    '  - name: 🆎 AdBlock',
    '    type: select',
    '    proxies: [REJECT, DIRECT]',
    '  - name: 🐟 漏网之鱼',
    '    type: select',
    '    proxies: [' + ['🚀 节点选择', '🎯 全球直连', '♻️ 自动选择'].map(yamlStr).join(', ') + (names.length ? ', ' + names.map(yamlStr).join(', ') : '') + ']',
  ];
  const providerLines = [];
  for (const rs of ACL_RULE_SETS) {
    providerLines.push('  ' + rs.name + ':');
    providerLines.push('    type: http');
    providerLines.push('    behavior: ' + rs.behavior);
    providerLines.push('    url: ' + yamlStr(ACL_BASE + rs.file));
    providerLines.push('    path: ./ruleset/' + rs.name + '.yaml');
    providerLines.push('    interval: 86400');
  }
  const ruleLines = ACL_RULE_SETS.map((rs) => '  - RULE-SET,' + rs.name + ',' + rs.group);
  ruleLines.push('  - GEOIP,CN,🎯 全球直连,no-resolve');
  ruleLines.push('  - MATCH,🐟 漏网之鱼');
  return CLASH_TEMPLATE
    .replace('{{PROXIES}}', () => proxyLines.join('\n'))
    .replace('{{GROUPS}}', () => groupLines.join('\n'))
    .replace('{{RULE_PROVIDERS}}', () => providerLines.join('\n'))
    .replace('{{RULES}}', () => ruleLines.join('\n'));
}

function buildLinksText() {
  const names = displayNames();
  return NODES.map((n, i) => renamedLink(n, names[i])).filter(Boolean).join('\n') + '\n';
}

function surgeLine(o) {
  if (o.type === 'vless') return surgeVlessLine(o);
  // Surge hysteria2: Name = hysteria2, server, port, password=..., sni=...,
  //   obfs=salamander, obfs-password=..., skip-cert-verify=true
  const parts = ['hysteria2', o.server, String(o.server_port), 'password=' + o.password, 'sni=' + o.tls.server_name];
  if (o.tls.insecure) parts.push('skip-cert-verify=true');
  if (o.obfs) {
    parts.push('obfs=' + o.obfs.type);
    if (o.obfs.password) parts.push('obfs-password=' + o.obfs.password);
  }
  return o.tag + ' = ' + parts.join(', ');
}
function surgeVlessLine(o) {
  // Surge VLESS (iOS 6.0.0+ / Mac 6.12.0+, Surge manual):
  //   Name = vless, host, port, username=<uuid>, flow=xtls-rprx-vision,
  //   sni=..., reality-public-key=..., reality-short-id=...,
  //   encryption=mlkem768x25519plus.... (setting reality-public-key enables
  //   REALITY, which implies TLS — no separate tls=true needed for it).
  const parts = ['vless', o.server, String(o.server_port), 'username=' + o.uuid];
  if (o.flow) parts.push('flow=' + o.flow);
  if (o.security === 'tls') parts.push('tls=true');
  if (o.sni) parts.push('sni=' + o.sni);
  if (o.fp) parts.push('client-fingerprint=' + o.fp);
  if (o.security === 'reality' && o.pbk) {
    parts.push('reality-public-key=' + o.pbk);
    if (o.sid) parts.push('reality-short-id=' + o.sid);
  }
  if (o.encryption && o.encryption !== 'none') parts.push('encryption=' + o.encryption);
  if (o.network === 'ws') {
    parts.push('ws=true');
    if (o.path) parts.push('ws-path=' + o.path);
    if (o.host) parts.push('ws-headers=Host:' + o.host);
  }
  if (o.network === 'grpc') {
    parts.push('grpc=true');
    if (o.serviceName) parts.push('grpc-service-name=' + o.serviceName);
  }
  return o.tag + ' = ' + parts.join(', ');
}
function buildSurgeConfig(req, token) {
  const outs = parsedNodes();
  const names = outs.map((o) => o.tag);
  const lines = [];
  lines.push('#!MANAGED-CONFIG ' + baseUrl(req) + '/c/?token=' + token + ' interval=86400 strict=true');
  lines.push('');
  lines.push('[Proxy]');
  for (const o of outs) lines.push(surgeLine(o));
  lines.push('');
  lines.push('[Proxy Group]');
  lines.push('PROXY = select, ' + names.join(', '));
  lines.push('AUTO = url-test, ' + names.join(', ') + ', url=https://www.gstatic.com/generate_204, interval=300');
  lines.push('');
  lines.push('[Rule]');
  lines.push('IP-CIDR,192.168.0.0/16,DIRECT');
  lines.push('IP-CIDR,10.0.0.0/8,DIRECT');
  lines.push('IP-CIDR,172.16.0.0/12,DIRECT');
  lines.push('FINAL,PROXY');
  return lines.join('\n') + '\n';
}

// Client resolution (sublinkPro: GET /c/?token=..&client=<idx>).
// client values: clash, mihomo (=clash YAML), sing-box, singbox, json
// (=sing-box JSON), v2ray (=base64 links), uri (=plain hy2 links),
// surge (=Surge config), links (=uri), b64 (=v2ray).
// ?format= is an alias for client on /sub/:token. ?format= wins over UA;
// client= wins over ?format=. Browsers (no client UA) get 'html'.
// UA notes: surge -> surge; loon/egern/stash/surfboard/shadowrocket/quanx
// -> uri (in sublinkPro these expanded formats need the Sub-Store sidecar;
// this build returns the plain hy2 URI list for them, not a full
// conversion — see README).
function resolveClient(req) {
  const u = new URL(req.url, 'http://localhost');
  const raw = (u.searchParams.get('client') || u.searchParams.get('format') || '').trim().toLowerCase();
  if (raw) {
    if (raw === 'clash' || raw === 'mihomo' || raw === 'yaml' || raw === 'yml') return 'clash';
    if (raw === 'sing-box' || raw === 'singbox' || raw === 'json') return 'singbox';
    if (raw === 'surge') return 'surge';
    if (raw === 'v2ray' || raw === 'b64' || raw === 'base64') return 'b64';
    if (raw === 'uri' || raw === 'links' || raw === 'link' || raw === 'txt' || raw === 'plain') return 'links';
    if (raw === 'html' || raw === 'page') return 'html';
  }
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (!ua) return 'html';
  if (ua.includes('surge')) return 'surge';
  if (ua.includes('sing-box') || ua.includes('singbox') || ua.includes('hiddify') || ua.includes('karing')) return 'singbox';
  if (ua.includes('clash') || ua.includes('mihomo') || ua.includes('clashmeta') || ua.includes('clash-meta') || ua.includes('verge')) return 'clash';
  // Expanded clients: sublinkPro serves these via Sub-Store; here: URI list.
  if (ua.includes('shadowrocket') || ua.includes('nekobox') || ua.includes('v2ray') || ua.includes('streisand') || ua.includes('loon') || ua.includes('egern') || ua.includes('stash') || ua.includes('surfboard') || ua.includes('quanx') || ua.includes('quantumult')) return 'links';
  // Browser UA (Mozilla + Chrome/Firefox/Safari/Edg, no client keyword above) -> chooser page.
  if (ua.includes('mozilla') && (ua.includes('chrome') || ua.includes('firefox') || ua.includes('safari') || ua.includes('edg'))) return 'html';
  return 'links'; // other / generic clients: plain hy2 link list
}
// Backwards-compatible name used by older call sites.
function detectFormat(req) { return resolveClient(req); }

function subUrls(req, token) {
  const base = baseUrl(req) + '/sub/' + token;
  const cbase = baseUrl(req) + '/c/?token=' + token;
  return {
    singbox: base + '?format=singbox',
    clash: base + '?format=clash',
    links: base + '?format=links',
    b64: base + '?format=b64',
    surge: base + '?format=surge',
    uri: base + '?format=uri',
    // sublinkPro consume endpoint (same token, client param):
    c_url: cbase,
    c_singbox: cbase + '&client=sing-box',
    c_clash: cbase + '&client=clash',
    c_mihomo: cbase + '&client=mihomo',
    c_uri: cbase + '&client=uri',
    c_v2ray: cbase + '&client=v2ray',
    c_surge: cbase + '&client=surge',
    // Plain base URL: UA-split (sing-box gets JSON, Clash gets YAML, browser gets HTML chooser).
    url: base,
    import_url: 'sing-box://import-remote-profile?url=' + encodeURIComponent(base + '?format=singbox'),
  };
}

// Node-total traffic for Subscription-Userinfo: sums over MAPPED probe nodes only.
// upload = sum month_tx, download = sum month_rx, total = sum traffic_limit (limit 0 excluded).
// expire = last day of the current month, 23:59:59 local time.
function probeTotals(probeNodes) {
  let upload = 0, download = 0, total = 0;
  const seen = new Set();
  for (const n of NODES) {
    // Several gateway nodes may map to the same probe id: count that
    // machine's traffic exactly once.
    if (!n.probe_node_id || seen.has(n.probe_node_id)) continue;
    seen.add(n.probe_node_id);
    const p = probeNodes.find((x) => x.id === n.probe_node_id);
    if (!p) continue;
    upload += p.month_tx || 0;
    download += p.month_rx || 0;
    if (p.traffic_limit) total += p.traffic_limit;
  }
  return { upload, download, total, expire: Math.floor(monthEndExpireMs(Date.now()) / 1000) };
}

// Subscription-Userinfo expire: last day of the CURRENT month in
// Asia/Shanghai, 23:59:59. Computed in UTC+8 explicitly — the server's local
// timezone may be UTC, where "this month" can lag Shanghai across the month
// boundary (e.g. Nov 30 16:30 UTC is already Dec 1 in Shanghai; the old
// local-time formula then returned an expire IN THE PAST for ~8h/month).
function monthEndExpireMs(nowMs) {
  const sh = new Date(nowMs + 8 * 3600 * 1000);
  return Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth() + 1, 0, 23, 59, 59) - 8 * 3600 * 1000;
}
function userinfoHeader(t) {
  const parts = ['upload=' + t.upload, 'download=' + t.download];
  if (t.total > 0) parts.push('total=' + t.total);
  parts.push('expire=' + t.expire);
  return parts.join('; ');
}

// --- probe (1e.lol) ------------------------------------------------------
let probeCache = { at: 0, data: null, source: 'live' };
let probeLiveData = null; // last SUCCESSFUL live payload, kept apart from the fallback cache
// A failed fetch is cached too (with a longer TTL) so a down probe does not
// make every request pay the full 10 s timeout. In-flight fetches are shared
// so a burst after cache expiry triggers one upstream call, not N.
const PROBE_FAIL_CACHE_MS = Math.max(1000, parseInt(process.env.PROBE_FAIL_CACHE_MS || '60000', 10) || 60000);
let probeInflight = null;
async function fetchProbe() {
  const now = Date.now();
  const ttl = probeCache.source === 'live' ? PROBE_CACHE_MS : PROBE_FAIL_CACHE_MS;
  if (probeCache.data && now - probeCache.at < ttl) return probeCache;
  if (probeInflight) return probeInflight;
  probeInflight = (async () => {
    try {
      const r = await fetch(PROBE_URL, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('probe HTTP ' + r.status);
      const j = await r.json();
      if (!Array.isArray(j.nodes)) throw new Error('probe: no nodes array');
      probeLiveData = j.nodes;
      probeCache = { at: Date.now(), data: j.nodes, source: 'live' };
    } catch (e) {
      console.error('Probe fetch failed, using labelled sample fallback:', e.message);
      // Keep any stale live data (labelled) when we have it; otherwise sample.
      // Cache the failure with at=now so the next request does not re-fetch.
      // Only real live data may be labelled live-stale. Reusing
      // probeCache.data here relabelled the SAMPLE payload as stale-live on
      // the second failure, contradicting the "sample fallback" promise.
      const stale = probeLiveData;
      probeCache = { at: Date.now(), data: stale || SAMPLE_PROBE, source: stale ? 'live-stale' : 'sample-fallback' };
    } finally {
      probeInflight = null;
    }
    return probeCache;
  })();
  return probeInflight;
}

function mapNodes(probeNodes) {
  return NODES.map((n) => {
    const p = probeNodes.find((x) => x.id === n.probe_node_id) || null;
    if (!p) {
      // Node is not in the probe (probe_node_id null or unknown): traffic
      // and status are UNKNOWN — null, never fabricated zeros.
      return { key: n.key, name: n.name, region: n.region, expires_at: normalizeExpiry(n.expires_at), probe_node_id: n.probe_node_id ?? null, probe_name: n.probe_name, online: null, probe_missing: true, net_rx: null, net_tx: null, day_used: null, month_used: null, traffic_limit: null, remaining: null, pct_used: null, reset_day: null, cpu: null, uptime: null };
    }
    const m = p.metrics || {};
    const monthRx = p.month_rx || 0, monthTx = p.month_tx || 0;
    const monthUsed = typeof p.month_used === 'number' ? p.month_used : monthRx + monthTx;
    const limit = p.traffic_limit || 0;
    return {
      key: n.key, name: n.name, region: n.region || p.country || '', expires_at: normalizeExpiry(n.expires_at) || normalizeExpiry(p.expires_at),
      probe_node_id: p.id, probe_name: p.name,
      online: !!p.online, net_rx: m.net_rx || 0, net_tx: m.net_tx || 0,
      day_used: (p.day_rx || 0) + (p.day_tx || 0),
      month_used: monthUsed, traffic_limit: limit,
      remaining: limit ? Math.max(0, limit - monthUsed) : null,
      pct_used: limit ? +(monthUsed / limit * 100).toFixed(2) : null,
      reset_day: p.traffic_reset_day || 1, traffic_mode: p.traffic_mode || 'sum',
      cpu: typeof m.cpu === 'number' ? m.cpu : null, uptime: m.uptime || null,
    };
  });
}

// --- EMOS ----------------------------------------------------------------
async function emosCheck(token, knownIdentity) {
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  // Identity is MANDATORY: a failed sign/check must never degrade to the
  // shared 'unknown' user, or one login revokes every other user's link.
  const identityPromise = knownIdentity
    ? Promise.resolve(knownIdentity)
    : fetch(EMOS_BASE + '/api/sign/check', { headers, signal: AbortSignal.timeout(10000) })
        .then(async (r) => {
          if (!r.ok) throw new Error('sign/check HTTP ' + r.status);
          const j = await r.json().catch(() => ({}));
          if (j.is_sign !== true || !j.user_id) throw new Error('sign/check did not confirm a signed-in user');
          return { user_id: String(j.user_id) };
        });
  const [carrotRes, identity] = await Promise.all([
    fetch(EMOS_BASE + '/api/carrot/current', { headers, signal: AbortSignal.timeout(10000) }),
    identityPromise,
  ]);
  if (!carrotRes.ok) throw new Error('EMOS carrot check failed: HTTP ' + carrotRes.status);
  const carrotJson = await carrotRes.json();
  const carrot = Number(carrotJson.carrot);
  if (!Number.isFinite(carrot)) throw new Error('EMOS carrot response has no numeric carrot');
  const userId = identity && identity.user_id ? String(identity.user_id) : '';
  if (!userId || userId === 'unknown') throw new Error('EMOS identity check failed: missing user_id');
  return { carrot, user_id: userId, username: null };
}
// Re-checks only need the balance; identity was proven at login.
async function emosCarrotOnly(token) {
  const r = await fetch(EMOS_BASE + '/api/carrot/current', {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('EMOS carrot check failed: HTTP ' + r.status);
  const j = await r.json();
  const carrot = Number(j.carrot);
  if (!Number.isFinite(carrot)) throw new Error('EMOS carrot response has no numeric carrot');
  return carrot;
}

// --- EMOS /link 登录跳转回调 ----------------------------------------------
// Primary login (verified reference: somebyteorg/emos_music, a real EMOS client).
// The login button does NOT use a popup: it does
//   window.location.href = getEmosLoginUrl(window.location.origin)
// where getEmosLoginUrl builds:
//   GET {EMOS_ORIGIN}/link?uuid=<crypto.randomUUID()>&name=<app name>&url=<callback URL>
// After the user logs in on EMOS, EMOS redirects the browser to the callback
// URL carrying a token in the URL. The app must extract and persist that
// token, then verify it server-side. The emos-api Postman file for link登录跳转
// confirms the exact shape (GET {{url}}/link?uuid={{$randomUUID}}&name=测试登录
// &url=https://emos-link.local) but has NO response example, so whether EMOS
// echoes uuid back in the callback is UNVERIFIED — the callback below accepts
// a callback without uuid, but rejects a uuid that does not match a pending
// login (bad_state). The token itself is always verified server-side via
// /api/sign/check + /api/carrot/current, so a forged callback cannot log in.
// Callback URL base: env PUBLIC_URL if set (e.g. https://sub.example.com),
// otherwise the request Host header (x-forwarded-proto or socket.encrypted
// decides http/https). The callback must be reachable by the USER's browser,
// not by EMOS's server — so http://127.0.0.1:3000 works when testing on the
// same machine, but a remote user needs the public domain (see README).
// Note: a token can only arrive in the callback QUERY string — a server
// cannot see a URL #hash, so if EMOS ever puts the token in the hash the
// callback would see no_token; document that if it happens.
const EMOS_APP_NAME = process.env.EMOS_APP_NAME || 'emos-sub';
// v1.5.14 (M2): DEMO_ENABLED bypasses the carrot gate entirely and gives
// every caller the same demo-user. Refuse it in production and warn loudly
// so a leaked env var cannot silently open a free subscription endpoint.
const DEMO_ENABLED = process.env.DEMO_ENABLED === '1' && process.env.NODE_ENV !== 'production';
if (process.env.DEMO_ENABLED === '1' && !DEMO_ENABLED) {
  console.error('WARNING: DEMO_ENABLED=1 ignored because NODE_ENV=production (demo login bypasses the carrot gate)');
} else if (DEMO_ENABLED) {
  console.warn('WARNING: DEMO_ENABLED=1 — anyone can log in with an arbitrary carrot; never use this in production');
}
// PUBLIC_URL: the public base users reach this gateway at, e.g.
// https://sub.example.com. Normalised: a bare domain without a scheme gets
// https:// prepended (a scheme-less PUBLIC_URL would otherwise build a
// callback like "sub.example.com/auth/..." which EMOS cannot redirect to),
// trailing slashes stripped. Invalid values fail loudly at startup.
let PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
if (PUBLIC_URL && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(PUBLIC_URL)) PUBLIC_URL = 'https://' + PUBLIC_URL;
if (PUBLIC_URL && !/^https?:\/\/[^/]+$/.test(PUBLIC_URL)) {
  console.error('PUBLIC_URL 无效：' + process.env.PUBLIC_URL + '（应为 https://域名 或 http://域名:端口，不带路径）');
  process.exit(1);
}
const EMOS_LOGIN_TTL_MS = 10 * 60 * 1000;
const pendingEmosLogins = new Map(); // uuid -> {createdAt}; consume-once, 10 min
// Host allow-list for building URLs: only hostname/port characters.
// A crafted Host (e.g. x" onclick="...) used to flow into the chooser page's
// href and into Surge managed-config lines. Anything else falls back to
// localhost so a bad Host can never produce a malicious URL.
function validHost(h) {
  return typeof h === 'string' && h.length > 0 && h.length <= 253 && /^[A-Za-z0-9._:\[\]-]+$/.test(h);
}
function publicBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  // Only http/https are valid schemes, and only from a trusted proxy peer.
  // An unvalidated X-Forwarded-Proto used to allow arbitrary schemes
  // (e.g. javascript:) into subscription URLs and Surge managed-config lines.
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const peer = req.socket && req.socket.remoteAddress;
  const trustXf = proxyTrusted(peer, TRUST_PROXY_MODE);
  const proto = (trustXf && (xf === 'http' || xf === 'https')) ? xf : (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = validHost(req.headers.host) ? req.headers.host : ('127.0.0.1:' + PORT);
  return proto + '://' + host;
}
// Session cookies get Secure when the public base is https (Simon runs
// plain http on the VPS IP today, so this is a no-op until he puts a
// domain + HTTPS in front — then it turns on automatically).
function cookieSecure(req) { return publicBaseUrl(req).startsWith('https://') ? '; Secure' : ''; }
function prunePendingEmosLogins() {
  const now = Date.now();
  for (const [k, v] of pendingEmosLogins) {
    if (now - v.createdAt > EMOS_LOGIN_TTL_MS) pendingEmosLogins.delete(k);
  }
}
function buildEmosLoginUrl(req) {
  prunePendingEmosLogins();
  const uuid = crypto.randomUUID();
  pendingEmosLogins.set(uuid, { createdAt: Date.now() });
  // Cap the table: without this, spamming /auth/emos grows the Map
  // unboundedly (each entry lives 10 min). Oldest goes first.
  while (pendingEmosLogins.size > 1000) pendingEmosLogins.delete(pendingEmosLogins.keys().next().value);
  const callback = publicBaseUrl(req) + '/auth/emos/callback';
  const login_url = EMOS_BASE + '/link?uuid=' + encodeURIComponent(uuid)
    + '&name=' + encodeURIComponent(EMOS_APP_NAME)
    + '&url=' + encodeURIComponent(callback);
  return { login_url, uuid, callback };
}
// Strict sign-in check for the callback: sign/check only returns
// {is_sign, user_id} — it does NOT return a token, so this only proves the
// token EMOS gave us is a live login. Non-200 or is_sign !== true -> reject.
// Caveat: if EMOS's is_sign means "signed in TODAY" rather than "logged in",
// a valid user who has not signed in today would be rejected here; the
// error page tells them to sign in on EMOS first. If Simon finds valid
// users blocked, relax this to "non-200 only" (see README).
async function emosSignCheck(token) {
  const r = await fetch(EMOS_BASE + '/api/sign/check', {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('sign/check HTTP ' + r.status);
  const j = await r.json().catch(() => ({}));
  if (j.is_sign !== true) throw new Error('sign/check is_sign is not true');
  return { user_id: j.user_id || 'unknown' };
}
// Issue a user session + per-user share after a successful EMOS check.
// Shared by POST /api/auth (manual token / demo) and the /link callback —
// do not duplicate this logic. Never logs or renders the EMOS token.
function issueUserSession(req, result, token, demo) {
  // One live console session per user_id: a fresh login ends the previous
  // console session. The subscription link is NOT revoked (v1.5.13): before
  // this, every re-login minted a new share token, so every client holding
  // the old URL got 403.
  for (const [sid, s] of sessions) {
    if (s.user_id === result.user_id) sessions.delete(sid);
  }
  const sessionId = randHex(16);
  const now = Date.now();
  // Reuse the user's existing share so the distributed link never changes
  // on re-login. A system-disabled share (carrot drop / grace expiry) is
  // re-enabled: this login just proved the carrot is above the threshold
  // again. A user- or admin-disabled share stays dead (it may have leaked);
  // a fresh share is minted instead. Stale duplicates are dropped: one
  // live link per person.
  let share = null;
  for (const s of shares.values()) {
    if (s.user_id !== result.user_id) continue;
    if (!share || (s.created_at || 0) > (share.created_at || 0)) share = s;
  }
  for (const s of [...shares.values()]) {
    if (s.user_id === result.user_id && s !== share) shares.delete(s.token);
  }
  if (share && !share.enabled && share.disabledBy !== 'system') {
    shares.delete(share.token);
    share = null;
  }
  if (share && !share.enabled) { share.enabled = true; share.disabledBy = null; }
  // v1.5.14 (H2): a fresh login is a fresh proof of carrot, so it must
  // refresh a share that reached its own TTL. Otherwise the reused token
  // carries the old expires_at and every re-login deadlocks into 403 until
  // the hourly sweeper happens to prune it.
  if (share && share.expires_at && share.expires_at <= now) {
    const ttl = shareTtlMs();
    share.expires_at = ttl ? now + ttl : null;
  }
  if (!share) share = createShare(sessionId, result.user_id);
  share.sessionId = sessionId;
  share.emosToken = token || null;
  share.lastCarrotCheck = now;
  share.lastCarrotOkAt = now;
  share.carrot = result.carrot;
  const subToken = share.token;
  sessions.set(sessionId, { user_id: result.user_id, username: result.username, carrot: result.carrot, emosToken: token || null, demo, expiresAt: now + SESSION_TTL_MS, lastCarrotCheck: now, lastCarrotOkAt: now, shareToken: subToken });
  saveStateNow();
  const urls = subUrls(req, subToken);
  return { sessionId, share, subToken, sub_url: baseUrl(req) + '/sub/' + subToken, sub_urls: urls, import_url: urls.import_url };
}

// --- handlers ------------------------------------------------------------
async function handleAuth(req, res) {
  // Each attempt costs two EMOS API calls: cap it so the gateway cannot be
  // used as an EMOS-check oracle or a DDoS amplifier.
  if (!rateLimitCheck(req, res, 'auth:' + clientIp(req), 30, 10 * 60 * 1000)) return;
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const demoCarrot = typeof body.carrot === 'number' ? body.carrot : (typeof body.carrot === 'string' && body.carrot !== '' ? Number(body.carrot) : NaN);

  let result;
  let demo = false;
  if (token) {
    try { result = await emosCheck(token); }
    catch (e) { return sendJson(res, 502, { ok: false, error: 'EMOS check failed: ' + e.message }); }
  } else if (Number.isFinite(demoCarrot) && DEMO_ENABLED) {
    // Demo login is off by default; enable only for local testing with DEMO_ENABLED=1.
    demo = true;
    result = { carrot: demoCarrot, user_id: 'demo-user', username: 'demo-user' };
  } else {
    return sendJson(res, 400, { ok: false, error: 'Provide {token} (EMOS Bearer token)' });
  }

  const carrot = result.carrot;
  if (!(carrot > CARROT_THRESHOLD)) {
    return sendJson(res, 200, { ok: false, gated: false, user_id: result.user_id, username: result.username, carrot, threshold: CARROT_THRESHOLD, shortfall: CARROT_THRESHOLD + 1 - carrot, reason: 'carrot_insufficient' });
  }
  const issued = issueUserSession(req, result, token, demo);
  const sessionId = issued.sessionId;
  const share = issued.share;
  const subToken = issued.subToken;
  const subUrl = issued.sub_url;
  const urls = issued.sub_urls;
  return sendJson(res, 200, { ok: true, gated: true, user_id: result.user_id, username: result.username, carrot, threshold: CARROT_THRESHOLD, demo, session: sessionId, sub_token: subToken, sub_url: subUrl, sub_urls: urls, import_url: urls.import_url, share: shareInfo(share), expires_in_seconds: Math.floor(SESSION_TTL_MS / 1000) });
}

// GET /auth/emos — start EMOS /link login: issue a one-time uuid, then
// 302 the browser to EMOS. No popup, plain top-level navigation, exactly
// like the emos_music reference client.
function handleEmosLogin(req, res) {
  if (!rateLimitCheck(req, res, 'emos-login:' + clientIp(req), 30, 10 * 60 * 1000)) return;
  const { login_url } = buildEmosLoginUrl(req);
  res.writeHead(302, { Location: login_url, 'Cache-Control': 'no-store' });
  return res.end();
}
// GET /api/auth/emos/login-url — same URL as JSON (testing / debugging).
function handleEmosLoginUrl(req, res) {
  if (!rateLimitCheck(req, res, 'emos-login:' + clientIp(req), 30, 10 * 60 * 1000)) return;
  const { login_url, callback } = buildEmosLoginUrl(req);
  return sendJson(res, 200, { ok: true, login_url, callback, app_name: EMOS_APP_NAME });
}
// GET /auth/emos/callback — EMOS redirects the browser here after login,
// carrying the token in the query string (?token=, ?access_token= accepted
// as a fallback alias; ?token= wins). Server-side verification, then the
// same session + share as POST /api/auth, an HttpOnly session cookie, and a
// 302 to / with a clean URL. The EMOS token is never put in the redirect
// Location, never rendered in a page, and never logged — it lives only in
// the in-memory session, same as the manual-token flow.
async function handleEmosCallback(req, res) {
  // v1.5.14 (M1): this endpoint mints sessions and makes 2 EMOS calls per
  // hit — it must be rate-limited like /auth/emos and /api/auth.
  if (!rateLimitCheck(req, res, 'emos-callback:' + clientIp(req), 30, 10 * 60 * 1000)) return;
  const u = new URL(req.url, 'http://localhost');
  const token = (u.searchParams.get('token') || u.searchParams.get('access_token') || '').trim();
  const uuid = u.searchParams.get('uuid') || '';
  const fail = (code, carrot) => {
    let loc = '/?emos_error=' + code;
    if (typeof carrot === 'number') loc += '&carrot=' + carrot;
    if (code === 'carrot_insufficient') loc += '&threshold=' + CARROT_THRESHOLD;
    res.writeHead(302, { Location: loc, 'Cache-Control': 'no-store' });
    res.end();
  };
  if (!token) return fail('no_token');
  if (uuid) {
    // EMOS echoed our uuid back: it must match a pending login, else reject.
    const p = pendingEmosLogins.get(uuid);
    if (!p || Date.now() - p.createdAt > EMOS_LOGIN_TTL_MS) return fail('bad_state');
    pendingEmosLogins.delete(uuid); // consume-once
  }
  // No uuid in the callback: EMOS did not echo it (unverified behaviour —
  // the Postman file has no response example). Accept it anyway; the token
  // itself is verified server-side below, so a forged callback cannot log in.
  let sign;
  try { sign = await emosSignCheck(token); }
  catch (e) { return fail('not_signed_in'); }
  let result;
  // Reuse the sign/check result: 2 EMOS calls for the callback, not 3.
  try { result = await emosCheck(token, sign); }
  catch (e) { return fail('not_signed_in'); }
  if (!(result.carrot > CARROT_THRESHOLD)) return fail('carrot_insufficient', result.carrot);
  const issued = issueUserSession(req, result, token, false);
  res.writeHead(302, {
    Location: '/',
    'Set-Cookie': 'emos_session=' + issued.sessionId + '; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax' + cookieSecure(req),
    'Cache-Control': 'no-store',
  });
  return res.end();
}

async function handleNodes(req, res) {
  const s = getSession(req);
  if (!s) return sendJson(res, 401, { ok: false, error: 'missing or expired X-Session — login first' });
  const probe = await fetchProbe();
  const nodes = mapNodes(probe.data);
  return sendJson(res, 200, { ok: true, user_id: s.user_id, carrot: s.carrot, demo: s.demo, probe_source: probe.source, probe_note: probe.source === 'live' ? 'live 1e.lol data' : 'SAMPLE fallback — probe fetch failed, values are NOT live', traffic_note: 'Node-total server traffic from probe (whole NIC, not hy2-only, not per-user)', nodes });
}

function handleSubLink(req, res) {
  const s = getSession(req);
  if (!s) return sendJson(res, 401, { ok: false, error: 'missing or expired X-Session — login first' });
  // No live share (admin-revoked, disabled or expired): say so with a 410
  // instead of building a URL around a null/stale token (".../sub/null").
  // The console already treats a non-200 here as "log in again".
  const share = getShare(s.shareToken);
  if (!share) return sendJson(res, 410, { ok: false, error: 'subscription revoked or expired — refresh the link or log in again' });
  const urls = subUrls(req, share.token);
  return sendJson(res, 200, { ok: true, user_id: s.user_id, demo: s.demo, sub_url: urls.url, sub_urls: urls, import_url: urls.import_url, share: shareInfo(share) });
}

// POST /api/logout — end the current user session (cookie and/or X-Session)
// and clear the emos_session cookie. Added 2026-11-26: the console hides the
// login card once the dashboard shows, so users need a way back out.
// v1.5.13: logout ends only the console session; the share survives, so
// logging out must not 403 every client holding the link.
function handleLogout(req, res) {
  const s = getSession(req);
  if (s) { sessions.delete(s.sid); }
  saveStateNow();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'emos_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' + cookieSecure(req), ...securityHeaders() });
  return res.end(JSON.stringify({ ok: true }));
}

// POST /api/sub/refresh — rotate the share token; the old token 403s immediately.
async function handleSubRefresh(req, res) {
  const s = getSession(req);
  if (!s) return sendJson(res, 401, { ok: false, error: 'missing or expired X-Session — login first' });
  const sess = sessions.get(s.sid);
  if (!sess) return sendJson(res, 401, { ok: false, error: 'missing or expired X-Session — login first' });
  // A null shareToken means the link was revoked/disabled (admin revoke-all,
  // single revoke, or the user's own disable). Only a fresh EMOS login may
  // mint a new link; self-service refresh must not undo a revocation.
  if (!sess.shareToken) return sendJson(res, 403, { ok: false, error: 'subscription revoked or disabled — please log in again' });
  const old = shares.get(sess.shareToken);
  if (!old || !old.enabled) return sendJson(res, 403, { ok: false, error: 'subscription revoked or disabled — please log in again' });
  // Rotating must not bypass the gate: a carrot that dropped since login
  // must not mint a fresh link without a live EMOS check. (Re-login does
  // the same check; refresh is no cheaper.) The check runs on the share
  // (v1.5.13); the session's cached carrot is synced for the console.
  if (old.emosToken && Date.now() - (old.lastCarrotCheck || 0) > CARROT_RECHECK_MS) {
    const verdict = await recheckCarrot(old);
    if (verdict === 'revoked') return sendJson(res, 403, { ok: false, error: 'carrot dropped below ' + CARROT_THRESHOLD + ' (or EMOS unreachable too long) — please log in again' });
    if (typeof old.carrot === 'number') { sess.carrot = old.carrot; sess.lastCarrotCheck = old.lastCarrotCheck; sess.lastCarrotOkAt = old.lastCarrotOkAt; }
  }
  old.enabled = false; shares.delete(sess.shareToken);
  const share = createShare(s.sid, s.user_id);
  share.emosToken = old.emosToken || sess.emosToken || null;
  share.carrot = old.carrot ?? null;
  share.lastCarrotCheck = old.lastCarrotCheck || Date.now();
  share.lastCarrotOkAt = old.lastCarrotOkAt || Date.now();
  sess.shareToken = share.token;
  saveStateNow();
  const urls = subUrls(req, share.token);
  return sendJson(res, 200, { ok: true, user_id: s.user_id, sub_token: share.token, sub_url: urls.url, sub_urls: urls, import_url: urls.import_url, share: shareInfo(share) });
}

// POST /api/sub/disable — disable the current share; /sub and /c return 403
// until the user re-authenticates (which creates a fresh share).
function handleSubDisable(req, res) {
  const s = getSession(req);
  if (!s) return sendJson(res, 401, { ok: false, error: 'missing or expired X-Session — login first' });
  const sess = sessions.get(s.sid);
  const share = shares.get(s.shareToken);
  if (share) { share.enabled = false; share.disabledBy = 'user'; }
  if (sess) sess.shareToken = null; // refresh must not resurrect a disabled link
  saveStateNow();
  return sendJson(res, 200, { ok: true, user_id: s.user_id, disabled: true, share: shareInfo(share) });
}

// Carrot re-check for a share. Returns:
//   'ok'      — EMOS confirms carrot still > threshold (fresh for 10 min)
//   'revoked' — carrot PROVEN below threshold, or the grace period ran out
//               with no successful check: the share is disabled (kept, so a
//               fresh login can re-enable the same link).
//   'stale'   — EMOS unreachable, or the token is dead (401/403), this time:
//               serve this one request, retry soon (60 s). A dead token does
//               NOT prove the user lost their carrot — EMOS tokens expire,
//               so treating 401 as a revoke killed every link a day after
//               login (v1.5.13). Only the grace cap still revokes.
// (2026-11-26 audit) The old code set lastCarrotCheck BEFORE the threshold
// test, so one failed re-check granted 10 more minutes of free serving.
async function recheckCarrot(share) {
  try {
    const carrot = await emosCarrotOnly(share.emosToken);
    share.carrot = carrot;
    if (!(carrot > CARROT_THRESHOLD)) {
      share.enabled = false; share.disabledBy = 'system'; saveStateNow();
      return 'revoked';
    }
    share.lastCarrotCheck = Date.now();
    share.lastCarrotOkAt = Date.now();
    return 'ok';
  } catch (e) {
    const lastOk = share.lastCarrotOkAt || share.lastCarrotCheck || 0;
    if (Date.now() - lastOk > CARROT_GRACE_MS) {
      console.error('Carrot grace period exceeded, disabling share');
      share.enabled = false; share.disabledBy = 'system'; saveStateNow();
      return 'revoked';
    }
    console.error('Carrot re-check failed (transient, retry in 60s):', e.message);
    share.lastCarrotCheck = Date.now() - CARROT_RECHECK_MS + 60 * 1000;
    return 'stale';
  }
}

// Resolve a subscription token, enforcing share expiry and the EMOS carrot
// re-check. v1.5.13: the link is NOT tied to a login session — a session
// lasts 24 h, but the subscription must survive it. The carrot gate is
// enforced by the periodic re-check on the share itself.
async function resolveShare(req, res, token) {
  const share = getShare(token);
  if (!share) { sendJson(res, 403, { ok: false, error: 'invalid, disabled or expired subscription token' }); return null; }
  // Grace is enforced on every fetch, not only at re-check time: once the
  // last successful check is older than CARROT_GRACE_MS, the link dies even
  // if the next re-check is still backed off (60 s after a transient fail).
  if (Date.now() - (share.lastCarrotOkAt || 0) > CARROT_GRACE_MS) {
    share.enabled = false; share.disabledBy = 'system'; saveStateNow();
    sendJson(res, 403, { ok: false, error: 'subscription needs re-login — EMOS unreachable too long, please log in again' }); return null;
  }
  // Re-check carrot for real EMOS shares (cached 10 min). Shares without a
  // token (migrated from a dead session, or demo) skip the live check and
  // are bounded by the grace window above.
  if (share.emosToken && Date.now() - (share.lastCarrotCheck || 0) > CARROT_RECHECK_MS) {
    const verdict = await recheckCarrot(share);
    if (verdict === 'revoked') { sendJson(res, 403, { ok: false, error: 'carrot dropped below ' + CARROT_THRESHOLD + ' (or EMOS unreachable too long) — subscription revoked, please log in again' }); return null; }
    // 'ok' or 'stale': serve this request.
  }
  // Access log (sublinkPro per-link access count + IP logs).
  share.access_count += 1;
  share.last_ip = clientIp(req);
  share.last_user_agent = req.headers['user-agent'] || null;
  share.last_access_at = Date.now();
  markStateDirty();
  return { share };
}

async function serveSubscription(req, res, token) {
  // Subscription fetches are the most hammerable endpoint (token guessing
  // is infeasible at 128 bit, but a flood still costs probe + EMOS calls).
  if (!rateLimitCheck(req, res, 'sub:' + clientIp(req), 120, 60 * 1000)) return;
  const resolved = await resolveShare(req, res, token);
  if (!resolved) return;
  const format = resolveClient(req);
  const urls = subUrls(req, token);
  // Subscription-Userinfo: NODE-TOTAL traffic (sum over mapped probe nodes),
  // NOT per-user usage. upload=sum month_tx, download=sum month_rx,
  // total=sum traffic_limit (limit-0 nodes excluded), expire=end of this month.
  const probe = await fetchProbe();
  const totals = probeTotals(probe.data);
  const userinfo = userinfoHeader(totals);
  // sublinkPro convention: never cache a subscription across devices;
  // reverse proxies must preserve User-Agent (that is what picks the format).
  const commonHeaders = { 'Cache-Control': 'private, no-store', 'Subscription-Userinfo': userinfo, 'Profile-Title': 'EMOS-gated sing-box', ...securityHeaders() };

  if (format === 'html') {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const page = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>订阅链接 · EMOS 订阅网关</title>'
        + '<style>' + UI_CSS + '</style></head><body class="narrow"><div class="wrap">'
        + '<div class="topbar"><div class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h5l4 5h7"/><circle cx="4" cy="6" r="1.6"/><circle cx="20" cy="11" r="1.6"/><path d="M4 18h16"/></svg></div><div><h1>订阅链接</h1><p class="subtitle">按客户端自动识别格式</p></div><span class="ver">EMOS</span></div>'
        + '<p class="muted">专属订阅地址，萝卜 ≤ ' + CARROT_THRESHOLD + ' 即失效。请在客户端里粘贴这条链接，不要用浏览器直接下载。</p>'
        + '<div class="card"><h2>按客户端自动识别</h2><div class="sub-row"><span class="lbl">订阅地址</span><code><a href="' + esc(urls.c_url) + '">' + esc(urls.c_url) + '</a></code></div><p class="muted" style="margin:16px 0 0"><a href="' + esc(urls.import_url) + '">导入配置</a></p></div>'
        + '<p class="muted">同一条链接，FlClash / Clash Verge 返回 Clash，sing-box / Hiddify / Karing 返回 JSON，Surge 返回 Surge 配置，Shadowrocket、Loon 等返回通用链接列表。Subscription-Userinfo 为节点总流量，不是个人用量；到期时间为本月底 23:59。</p>'
        + '</div></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...commonHeaders });
    return res.end(page);
  }
  // Build the body BEFORE writeHead: a builder that throws after the 200
  // headers are sent leaves the connection hanging (and used to crash the
  // process via the un-awaited handler — see dispatcher).
  if (format === 'clash') {
    const body = cachedSubBody('clash', buildClashYaml);
    res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8', 'profile-update-interval': '24', ...commonHeaders });
    return res.end(body);
  }
  if (format === 'surge') {
    const body = buildSurgeConfig(req, token);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...commonHeaders });
    return res.end(body);
  }
  if (format === 'links') {
    const body = cachedSubBody('links', buildLinksText);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...commonHeaders });
    return res.end(body);
  }
  if (format === 'b64') {
    const body = cachedSubBody('b64', () => Buffer.from(buildLinksText(), 'utf8').toString('base64') + '\n');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...commonHeaders });
    return res.end(body);
  }
  // singbox (default for sing-box / Hiddify / Karing UA, and ?format=singbox)
  const body = cachedSubBody('singbox', () => JSON.stringify(buildSingBoxConfig(), null, 2));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...commonHeaders });
  res.end(body);
}

async function handleSub(req, res, subToken) { return serveSubscription(req, res, subToken); }

// --- admin API handlers ---------------------------------------------------
async function handleAdminLogin(req, res) {
  if (!ADMIN_TOKEN) return sendJson(res, 503, { ok: false, error: 'admin not configured: set ADMIN_TOKEN env and restart the server' });
  // Brute-force guard: 5 wrong guesses lock this IP for 15 min.
  if (adminLoginBlocked(clientIp(req))) return sendJson(res, 429, { ok: false, error: 'too many failed logins, try again later' });
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
  // Trim: copy-paste from chat/notes often adds a trailing space or newline.
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  // Compare by BUFFER byte length, not JS string length: for a multibyte
  // token (e.g. Chinese) the two differ, and timingSafeEqual throws when
  // the buffers are different lengths — so compare buffers, never strings.
  const a = Buffer.from(token), b = Buffer.from(ADMIN_TOKEN);
  const ok = a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) { adminLoginFail(clientIp(req)); return sendJson(res, 401, { ok: false, error: 'wrong admin token' }); }
  adminLoginFails.delete(clientIp(req));
  const sid = randHex(16);
  adminSessions.set(sid, { createdAt: Date.now(), expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
  saveStateNow();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': 'admin_session=' + sid + '; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax' + cookieSecure(req), ...securityHeaders() });
  // Also return the session id in the body: if the browser does not store
  // or send the HttpOnly cookie (partitioned cookies, privacy modes), the
  // page falls back to sending it as an X-Admin-Token header instead.
  return res.end(JSON.stringify({ ok: true, session: sid }));
}
function handleAdminLogout(req, res) {
  const c = parseCookies(req).admin_session;
  if (c) adminSessions.delete(c);
  // Also drop a session presented via the X-Admin-Token header fallback.
  const h = req.headers['x-admin-token'];
  if (typeof h === 'string' && adminSessions.has(h)) adminSessions.delete(h);
  saveStateNow();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': 'admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' + cookieSecure(req), ...securityHeaders() });
  return res.end(JSON.stringify({ ok: true }));
}
function handleAdminPage(req, res) {
  // Always serve the admin page (200), even when ADMIN_TOKEN is unset:
  // the page probes GET /api/admin/health on load and shows a clear
  // "后台未配置" panel with the exact restart command when it gets a 503.
  // Returning a bare 503 page here used to leave the user with no way to
  // tell a misconfiguration from a broken login form.
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders() });
  return res.end(ADMIN_HTML_RENDERED);
}
async function handleAdminApi(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (!requireAdmin(req, res)) return;
  let bodyStatus = 400;
  const readJsonBody = async () => {
    try { return await readBody(req); } catch (e) { bodyStatus = e.status || 400; return null; }
  };
  const badBody = () => sendJson(res, bodyStatus, { ok: false, error: bodyStatus === 413 ? 'request body too large' : 'invalid JSON' });
  if (req.method === 'GET' && p === '/api/admin/ip-check') return sendJson(res, 200, ipDiagnostics(req));
  // ---- Nodes ----
  if (req.method === 'GET' && p === '/api/admin/nodes') {
    const probe = await fetchProbe();
    const probeMap = new Map(probe.data.map((x) => [x.id, x]));
    return sendJson(res, 200, { ok: true, probe_source: probe.source, nodes: NODES.map((n) => nodeAdminView(n, probeMap)) });
  }
  if (req.method === 'POST' && p === '/api/admin/nodes/parse') {
    const body = await readJsonBody();
    if (!body) return badBody();
    const link = typeof body.link === 'string' ? body.link.trim() : '';
    if (!link) return sendJson(res, 400, { ok: false, error: 'link is required' });
    const { protocol, parsed } = parseAnyLink(link, '');
    if (!protocol || !parsed) return sendJson(res, 400, { ok: false, error: 'unsupported or unparsable link: only hy2://, hysteria2:// and vless:// are accepted' });
    return sendJson(res, 200, { ok: true, protocol, parsed });
  }
  if (req.method === 'POST' && p === '/api/admin/nodes') {
    const body = await readJsonBody();
    if (!body) return badBody();
    const link = typeof body.link === 'string' ? body.link.trim() : '';
    if (!link) return sendJson(res, 400, { ok: false, error: 'link is required' });
    const { protocol, parsed } = parseAnyLink(link, '');
    if (!protocol || !parsed) return sendJson(res, 400, { ok: false, error: 'unsupported or unparsable link: only hy2://, hysteria2:// and vless:// are accepted' });
    const probeId = validateProbeId(body.probe_node_id);
    if (probeId === undefined) return sendJson(res, 400, { ok: false, error: 'probe_node_id must be a positive integer or null' });
    const region = typeof body.region === 'string' ? body.region.trim().toUpperCase() : '';
    const expiresAt = normalizeExpiry(body.expires_at);
    if (expiresAt === undefined) return sendJson(res, 400, { ok: false, error: 'expires_at must be a date like 2027-11-14 or null' });
    let name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) name = parsed.tag || (protocol + ' node');
    if (region && name.indexOf('·') < 0) name = region + ' · ' + name;
    let key = typeof body.key === 'string' ? slugify(body.key) : '';
    if (key) {
      if (NODES.some((n) => n.key === key)) return sendJson(res, 400, { ok: false, error: 'key already exists: ' + key });
    } else {
      key = uniqueKey(protocol + '-' + slugify((region ? region + '-' : '') + shortName({ name })));
    }
    const node = { key, name, region, link, probe_node_id: probeId, probe_name: null, expires_at: expiresAt };
    NODES.push(node);
    saveNodesConfig();
    return sendJson(res, 200, { ok: true, node });
  }
  if (req.method === 'POST' && p === '/api/admin/nodes/reorder') {
    const body = await readJsonBody();
    if (!body || !Array.isArray(body.keys)) return sendJson(res, 400, { ok: false, error: 'keys: [...] is required' });
    const keys = body.keys.map((k) => String(k));
    const current = NODES.map((n) => n.key);
    if (keys.length !== current.length || keys.some((k) => current.indexOf(k) < 0)) {
      return sendJson(res, 400, { ok: false, error: 'keys must contain exactly the current node keys, in the new order' });
    }
    const reordered = keys.map((k) => NODES.find((n) => n.key === k));
    if (reordered.some((n) => !n)) return sendJson(res, 400, { ok: false, error: 'reorder failed: a node key could not be resolved' });
    NODES = reordered;
    saveNodesConfig();
    return sendJson(res, 200, { ok: true, keys: NODES.map((n) => n.key) });
  }
  const nodeMatch = p.match(/^\/api\/admin\/nodes\/([^/]+)$/);
  if (nodeMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const key = safeDecode(nodeMatch[1]);
    const idx = NODES.findIndex((n) => n.key === key);
    if (idx < 0) return sendJson(res, 404, { ok: false, error: 'node not found: ' + key });
    if (req.method === 'DELETE') {
      const removed = NODES.splice(idx, 1)[0];
      saveNodesConfig();
      return sendJson(res, 200, { ok: true, removed: { key: removed.key, name: removed.name } });
    }
    const body = await readJsonBody();
    if (!body) return badBody();
    const n = NODES[idx];
    if (typeof body.link === 'string' && body.link.trim()) {
      const link = body.link.trim();
      const r = parseAnyLink(link, '');
      if (!r.protocol || !r.parsed) return sendJson(res, 400, { ok: false, error: 'unsupported or unparsable link: only hy2://, hysteria2:// and vless:// are accepted' });
      n.link = link;
      delete n.hy2_link;
    }
    if (typeof body.name === 'string' && body.name.trim()) n.name = body.name.trim();
    if (typeof body.region === 'string') n.region = body.region.trim().toUpperCase();
    if ('probe_node_id' in body) {
      const pid = validateProbeId(body.probe_node_id);
      if (pid === undefined) return sendJson(res, 400, { ok: false, error: 'probe_node_id must be a positive integer or null' });
      n.probe_node_id = pid;
    }
    if ('probe_name' in body && (body.probe_name === null || typeof body.probe_name === 'string')) n.probe_name = body.probe_name || null;
    if ('expires_at' in body) { const e = normalizeExpiry(body.expires_at); if (e === undefined) return sendJson(res, 400, { ok: false, error: 'expires_at must be a date like 2027-11-14 or null' }); n.expires_at = e; }
    saveNodesConfig();
    return sendJson(res, 200, { ok: true, node: n });
  }
  // ---- Shares ----
  if (req.method === 'GET' && p === '/api/admin/shares') {
    const list = [...shares.values()].sort((a, b) => b.created_at - a.created_at).map(adminShareInfo);
    return sendJson(res, 200, { ok: true, count: list.length, shares: list, note: 'Shares are created by EMOS login (one per user_id); the admin cannot mint a share without a user_id.' });
  }
  if (req.method === 'POST' && p === '/api/admin/shares/revoke-all') {
    const count = shares.size;
    shares.clear();
    // Keep sessions in sync: a stale shareToken makes /api/sub-link return a
    // dead URL (the subscription itself is already 403, so this is a UI fix).
    for (const sess of sessions.values()) sess.shareToken = null;
    saveStateNow();
    return sendJson(res, 200, { ok: true, revoked: count, note: 'All subscription tokens are now invalid; users must log in again to get a new share.' });
  }
  const shareAction = p.match(/^\/api\/admin\/shares\/([^/]+)\/(refresh|enable|disable)$/);
  if (req.method === 'POST' && shareAction) {
    const s = findShareByRef(safeDecode(shareAction[1]));
    if (!s) return sendJson(res, 404, { ok: false, error: 'share not found' });
    const action = shareAction[2];
    if (action === 'refresh') {
      shares.delete(s.token);
      const ns = createShare(s.sessionId, s.user_id);
      ns.emosToken = s.emosToken || null;
      ns.carrot = s.carrot ?? null;
      ns.lastCarrotCheck = s.lastCarrotCheck || 0;
      ns.lastCarrotOkAt = s.lastCarrotOkAt || Date.now();
      const sess = sessions.get(s.sessionId);
      if (sess) sess.shareToken = ns.token;
      saveStateNow();
      return sendJson(res, 200, { ok: true, share: adminShareInfo(ns), note: 'old token is invalid immediately' });
    }
    s.enabled = action === 'enable';
    s.disabledBy = action === 'enable' ? null : 'admin';
    const sess = sessions.get(s.sessionId);
    if (sess) {
      if (action === 'enable' && !sess.shareToken) sess.shareToken = s.token;
      if (action === 'disable' && sess.shareToken === s.token) sess.shareToken = null;
    }
    saveStateNow();
    return sendJson(res, 200, { ok: true, share: adminShareInfo(s) });
  }
  const shareDel = p.match(/^\/api\/admin\/shares\/([^/]+)$/);
  if (req.method === 'DELETE' && shareDel) {
    const s = findShareByRef(safeDecode(shareDel[1]));
    if (!s) return sendJson(res, 404, { ok: false, error: 'share not found' });
    shares.delete(s.token);
    const sess = sessions.get(s.sessionId);
    if (sess && sess.shareToken === s.token) sess.shareToken = null;
    saveStateNow();
    return sendJson(res, 200, { ok: true, revoked: s.id || s.token });
  }
  // ---- Settings ----
  if (req.method === 'GET' && p === '/api/admin/settings') {
    return sendJson(res, 200, { ok: true, settings: { carrot_threshold: CARROT_THRESHOLD, share_ttl_hours: SHARE_TTL_HOURS, name_rule: NAME_RULE, probe_cache_seconds: Math.floor(PROBE_CACHE_MS / 1000) }, sources: SETTINGS_SOURCES, note: 'Precedence at startup: env var > config/settings.json > default. A PUT applies immediately in-memory and writes settings.json; a restart with the env var set reverts that field to the env value.' });
  }
  if (req.method === 'PUT' && p === '/api/admin/settings') {
    const body = await readJsonBody();
    if (!body) return badBody();
    const warnings = [];
    if ('carrot_threshold' in body) {
      const v = body.carrot_threshold;
      if (!Number.isInteger(v) || v < 0) return sendJson(res, 400, { ok: false, error: 'carrot_threshold must be an integer >= 0' });
      CARROT_THRESHOLD = v;
      SETTINGS_SOURCES.carrot_threshold = 'settings';
      if (process.env.CARROT_THRESHOLD) warnings.push('CARROT_THRESHOLD env is set; this value will be overridden by the env value on restart.');
    }
    if ('share_ttl_hours' in body) {
      const v = body.share_ttl_hours;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return sendJson(res, 400, { ok: false, error: 'share_ttl_hours must be a number >= 0 (0 = never expires)' });
      SHARE_TTL_HOURS = v;
      SETTINGS_SOURCES.share_ttl_hours = 'settings';
      if (process.env.SHARE_TTL_HOURS) warnings.push('SHARE_TTL_HOURS env is set; this value will be overridden by the env value on restart.');
    }
    if ('name_rule' in body) {
      const v = body.name_rule;
      if (typeof v !== 'string' || !v.trim()) return sendJson(res, 400, { ok: false, error: 'name_rule must be a non-empty string' });
      if (v.trim() !== NAME_RULE) bumpSubCache();
      NAME_RULE = v.trim();
      SETTINGS_SOURCES.name_rule = 'settings';
    }
    if ('probe_cache_seconds' in body) {
      const v = body.probe_cache_seconds;
      if (!Number.isInteger(v) || v < 5 || v > 3600) return sendJson(res, 400, { ok: false, error: 'probe_cache_seconds must be an integer between 5 and 3600' });
      PROBE_CACHE_MS = v * 1000;
      SETTINGS_SOURCES.probe_cache_seconds = 'settings';
      if (process.env.PROBE_CACHE_SECONDS) warnings.push('PROBE_CACHE_SECONDS env is set; this value will be overridden by the env value on restart.');
    }
    const saved = saveSettingsFile();
    return sendJson(res, 200, { ok: true, settings: saved, sources: SETTINGS_SOURCES, warnings });
  }
  // ---- Health ----
  if (req.method === 'GET' && p === '/api/admin/health') {
    const probe = await fetchProbe();
    return sendJson(res, 200, { ok: true, version: VERSION, admin_configured: !!ADMIN_TOKEN, nodes: NODES.length, shares: shares.size, sessions: sessions.size, probe_source: probe.source, probe_nodes: probe.data ? probe.data.length : 0, uptime_seconds: Math.floor(process.uptime()), carrot_threshold: CARROT_THRESHOLD });
  }
  return sendJson(res, 404, { ok: false, error: 'unknown admin endpoint' });
}

// --- admin page (single page, plain HTML/JS, no build step) ---------------
// Shared UI tokens for console, admin and chooser pages.
const UI_CSS = `:root{
 --bg:#0b0d14;--surface:#11141c;--raised:#1a1e28;
 --text:#eef0f5;--text-2:#a3a9b8;--muted:#7a8296;
 --line:rgba(238,240,245,.09);--line-2:rgba(238,240,245,.16);
 --accent:#5ad1c4;--btn-ink:#0b0d14;
 --positive:#4cc38a;--negative:#e5484d;--warning:#d9a441;
 --ease:cubic-bezier(.22,1,.36,1);
 --sans:"IBM Plex Sans",Inter,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
 --mono:ui-monospace,"SFMono-Regular","JetBrains Mono",Consolas,"Liberation Mono",monospace
}
[data-theme="light"]{
 --bg:#f5f7fa;--surface:#ffffff;--raised:#eceff4;
 --text:#111827;--text-2:#4b5565;--muted:#6b7487;
 --line:rgba(17,24,39,.10);--line-2:rgba(17,24,39,.18);
 --accent:#0f766e;--btn-ink:#ffffff;
 --positive:#16a34a;--negative:#dc2626;--warning:#b45309
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{min-height:100vh;background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
body.narrow{min-height:100vh;display:flex;align-items:center}
.wrap{max-width:1440px;margin:0 auto;padding:24px 32px 64px}
body.narrow .wrap{max-width:880px;width:100%;padding-block:24px}
.topbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 24px;padding:0 0 16px;border-bottom:1px solid var(--line)}
.brand-mark{width:32px;height:32px;flex:none;display:flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--accent)}
.brand-mark svg{width:18px;height:18px}
.topbar h1{font-size:20px;font-weight:500;letter-spacing:0;line-height:1.2;margin:0}
.subtitle{font-size:13px;color:var(--muted);margin:2px 0 0}
.ver{font-family:var(--mono);font-size:12px;color:var(--muted);margin-left:auto}
h1,h2,h3{font-weight:500}
.th{font-family:var(--mono);color:var(--text)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:24px;margin:0 0 24px}
.card h2{font-size:14px;color:var(--text-2);letter-spacing:0;text-transform:none;margin:0 0 16px}
.card h2 .count{color:var(--muted);font-family:var(--mono);font-size:12px}
.muted{color:var(--muted);font-size:13px}
.bad{color:var(--negative)}.ok{color:var(--positive)}.warn{color:var(--warning)}
.unlock-controls{display:flex;gap:8px;flex-wrap:wrap}
.unlock-controls button{padding:8px 12px;font-size:12px}
.unlock-tags{display:flex;flex-wrap:wrap;gap:6px}
.utag{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-family:var(--mono);padding:3px 8px;border-radius:999px;border:1px solid var(--line);background:var(--raised);color:var(--text-2);white-space:nowrap}
.utag.available{color:var(--positive);border-color:var(--positive)}
.utag.partial{color:var(--warning);border-color:var(--warning)}
.utag.restricted,.utag.error{color:var(--negative);border-color:var(--negative)}
.utag.unsupported,.utag.unknown,.utag.untested{opacity:.6}
.utag b{font-weight:500}
.utag small{font-size:10px;opacity:.8}
.unlock-row td{background:var(--raised);padding:12px 16px}
.unlock-empty{font-size:12px;color:var(--muted)}
.expand-btn{background:none;border:0;color:var(--accent);cursor:pointer;font-size:12px;padding:2px 6px;font-family:var(--mono)}
.expand-btn:hover{background:none;color:var(--accent);text-decoration:underline}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.hidden{display:none!important}
button{font:inherit;font-size:14px;font-weight:500;line-height:1.2;color:var(--btn-ink);background:var(--text);border:1px solid transparent;border-radius:8px;padding:12px 16px;margin:0;cursor:pointer;transition:background-color .15s var(--ease),border-color .15s var(--ease),color .15s var(--ease)}
button:hover{background:var(--text-2)}
button:active{transform:scale(.98)}
button:focus-visible,input:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.ghost{background:var(--raised);border-color:var(--line);color:var(--text)}
button.ghost:hover{background:var(--line-2);border-color:var(--line-2);color:var(--text)}
.link-btn{background:none;border:0;color:var(--muted);padding:8px 4px}
.link-btn:hover{background:none;color:var(--text);text-decoration:underline}
button.danger{background:transparent;border-color:var(--negative);color:var(--negative)}
button.danger:hover{background:var(--raised);color:var(--negative)}
button.big{padding:12px 20px}
button:disabled{opacity:.5;cursor:wait}
label{display:block;font-size:13px;color:var(--text-2);margin:0 0 8px}
input,textarea{width:100%;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:12px;font:inherit;font-size:14px;outline:none;transition:border-color .15s var(--ease)}
input:focus,textarea:focus{border-color:var(--accent)}
textarea{resize:vertical}
code{font-family:var(--mono);font-size:13px;background:var(--raised);padding:2px 6px;border-radius:4px;word-break:break-all}
pre{background:var(--raised);border:1px solid var(--line);border-radius:8px;padding:16px;overflow:auto;font-family:var(--mono);font-size:13px;line-height:1.5;margin:16px 0}
.stats{display:flex;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);border-radius:12px;margin:0 0 24px;overflow:hidden}
.stat{flex:1 1 0;min-width:180px;padding:20px 24px;border-right:1px solid var(--line)}
.stat:last-child{border-right:0}
.stat .k{font-size:12px;color:var(--muted)}
.stat .v{font-family:var(--mono);font-size:30px;font-weight:500;line-height:1.1;margin:8px 0 0;font-variant-numeric:tabular-nums}
.stat .s{font-size:12px;color:var(--muted);margin:4px 0 0}
.table-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
thead th{position:static;background:transparent;font-size:12px;font-weight:400;color:var(--muted);text-align:left;padding:12px 16px;border-bottom:1px solid var(--line);text-transform:none;letter-spacing:0}
th,td{text-align:left;padding:12px 16px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:hover{background:var(--raised)}
tbody tr:last-child td{border-bottom:0}
td button{background:var(--raised);border:1px solid var(--line);color:var(--text);padding:8px 12px;font-size:12px;margin:0 4px 4px 0}
td button:hover{background:var(--line-2);color:var(--text)}
td button.danger{background:transparent;border-color:var(--negative);color:var(--negative)}
td button.danger:hover{background:var(--raised);color:var(--negative)}
td button[data-act="up"],td button[data-act="down"]{padding:8px;min-width:32px}
td button svg{width:16px;height:16px;display:block;margin:0 auto}
td button:last-child{margin-right:0}
.pill{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:400;color:var(--text-2);background:none;border:0;border-radius:0;padding:0;white-space:nowrap}
.tag{font-family:var(--mono);font-size:12px;color:var(--muted)}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--muted);flex:none}
.pill.ok::before{background:var(--positive)}
.pill.bad::before{background:var(--negative)}
.pill.warn::before{background:var(--warning)}
.pill.accent::before{background:var(--accent)}
.bar{height:4px;width:60%;margin:8px 0 0 auto;background:var(--raised);border-radius:2px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent);border-radius:2px}
.sub-row{display:flex;align-items:center;gap:12px;background:var(--raised);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0}
.sub-row::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent);flex:none}
.sub-row .lbl{flex:none;font-size:12px;color:var(--muted);width:auto}
.sub-row code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:none;padding:0;font-size:13px;color:var(--text)}
.sub-row code a{color:var(--text)}
.sub-row button{flex:none;margin:0}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 0}
.msg{font-size:13px;color:var(--text-2);margin:12px 0 0;padding:0;background:none;border:0;min-height:0}
.msg.err{color:var(--negative);background:none}
.msg.ok{color:var(--positive);background:none}
.msg:empty{display:none}
.warn-card{border-color:var(--line-2)}
.big-num{font-family:var(--mono);font-size:28px;font-weight:500;line-height:1.1;margin:8px 0}
.login-wrap{max-width:400px;margin:40px auto 0}
#loginCard{max-width:480px;margin:40px auto 24px}
.login-card{text-align:left}
.login-card input{text-align:left}
.lock{width:36px;height:36px;display:flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:8px;background:var(--raised);color:var(--text-2);margin:0 0 20px}
.lock svg{width:18px;height:18px}
.login-card h2{font-size:18px;color:var(--text)}
.login-card .muted{margin:0 0 20px}
.login-card button{width:100%;margin:16px 0 0}
#adminMsg{min-height:20px;margin:12px 0 0;font-size:13px;color:var(--text-2)}
#adminMsg.err{color:var(--negative)}
.cmd{display:flex;align-items:center;gap:12px;background:var(--raised);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0;font-family:var(--mono);font-size:13px;overflow-x:auto}
.cmd code{background:none;padding:0;white-space:nowrap}
.cmd button{margin:0 0 0 auto;flex:none}
.row{display:flex;gap:16px;flex-wrap:wrap;margin:0 0 16px}
.row>div{flex:1;min-width:200px}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:0 0 16px}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.healthline{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 20px;padding:12px 16px;background:var(--surface);border:1px solid var(--line);border-radius:8px}
.healthline .muted{margin-right:auto}
.tabs{display:flex;gap:0;margin:0 0 24px;border-bottom:1px solid var(--line)}
.tabs button.tab{background:none;border:0;border-bottom:2px solid transparent;border-radius:0;color:var(--muted);padding:12px 20px;font-size:14px;font-weight:400;margin:0}
.tabs button.tab:hover{background:none;color:var(--text);transform:none}
.tabs button.tab.active{background:none;color:var(--text);border-bottom-color:var(--accent)}
.empty{padding:32px 16px;text-align:center;color:var(--muted);font-size:13px}
.node-table th:nth-child(4),.node-table td:nth-child(4),.node-table th:nth-child(5),.node-table td:nth-child(5){text-align:right;font-family:var(--mono)}
.shares-table th:nth-child(5),.shares-table td:nth-child(5){text-align:right;font-family:var(--mono)}
#formTitle{margin-top:24px}
@media (max-width:640px){
 .wrap{padding:16px 16px 48px}
 .card{padding:16px}
 .stat{padding:16px}
 .stat .v{font-size:22px}
 .topbar h1{font-size:18px}
 .form-grid{grid-template-columns:1fr}
 .row{flex-direction:column;gap:0}
 .node-table{overflow:visible;margin:0;padding:0}
 .node-table thead{display:none}
 .node-table table,.node-table tbody,.node-table tr,.node-table td{display:block;width:100%}
 .node-table tr{border:1px solid var(--line);border-radius:8px;padding:4px 12px;margin:12px 0;background:var(--surface)}
 .node-table td{border-bottom:1px solid var(--line);padding:10px 0;text-align:left}
 .node-table td:last-child{border-bottom:0}
 .node-table td[data-label]:not([data-label=""])::before{content:attr(data-label);display:block;font-size:11px;color:var(--muted);margin-bottom:4px}
 .sub-row{flex-wrap:wrap}
 .sub-row .lbl{width:100%}
 .sub-row code{white-space:normal}
}`;

const ADMIN_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>后台管理 · EMOS 订阅网关</title><script>try{var t=localStorage.getItem("emos-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script><style>${UI_CSS}</style></head><body><div class="wrap">
<div class="topbar"><div class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h5l4 5h7"/><circle cx="4" cy="6" r="1.6"/><circle cx="20" cy="11" r="1.6"/><path d="M4 18h16"/></svg></div><div><h1>后台管理</h1><p class="subtitle">EMOS 订阅网关 · 只有站长能进</p></div><span class="ver">{{VERSION}}</span><button type="button" class="ghost" id="btnTheme">白天模式</button></div>
<p class="muted">管理节点、分享链接与设置，保存后立即生效。</p>

<div class="card warn-card hidden" id="unconfiguredCard"><h2>后台未配置</h2>
<p>服务器启动时未设置 <code>ADMIN_TOKEN</code>。</p>
<p class="muted">用以下命令重新启动（替换为你的口令），然后重新打开 /admin：</p>
<div class="cmd"><code>ADMIN_TOKEN=你的口令 node server.js</code><button type="button" class="ghost" id="btnCopyCmd">复制</button></div>
<p class="muted">也可以用控制脚本：<code>./manage.sh install --admin-token 你的口令</code>。口令不要写进任何文件或聊天记录。</p>
<p><button type="button" id="btnRecheck">重新检查</button></p></div>

<div class="login-wrap hidden" id="loginWrap"><div class="card login-card" id="loginCard">
<div class="lock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>
<h2>站长登录</h2><p class="muted">输入管理员口令（ADMIN_TOKEN）</p>
<label for="adminToken">管理员口令</label>
<input id="adminToken" type="password" placeholder="输入 ADMIN_TOKEN" autocomplete="off">
<button type="button" id="btnAdminLogin">登录</button>
<p id="adminMsg" class="muted"></p></div></div>

<div class="hidden" id="adminApp">
<div class="stats" id="healthChips"></div>
<div class="healthline"><span id="healthLine" class="muted"></span><button type="button" class="ghost" id="btnLogout">退出登录</button></div>

<nav class="tabs" id="adminTabs"><button type="button" class="tab active" data-tab="nodes">节点</button><button type="button" class="tab" data-tab="shares">分享</button><button type="button" class="tab" data-tab="settings">设置</button></nav>

<div class="card panel" data-panel="nodes"><div class="section-head"><h2>节点 <span class="count" id="nodeCount"></span></h2><span class="pill" id="probeNote"></span></div>
<div class="table-scroll"><table><thead><tr><th>Key</th><th>名称</th><th>到期</th><th>协议</th><th>服务器</th><th>探针</th><th>操作</th></tr></thead><tbody id="nodeRows"></tbody></table></div>
<h2 style="margin-top:20px">解锁检测</h2>
<p class="muted" id="unlockAdminNote"></p>
<div class="bar" id="unlockProgressBar" style="display:none"><i style="width:0%"></i></div>
<div class="actions unlock-controls"><button type="button" class="ghost" id="btnUnlockToggle">解锁检测：开启</button> <button type="button" class="ghost" id="btnUnlockRun">立即检测</button></div>
<p id="unlockAdminMsg" class="msg"></p>
<h2 id="formTitle">添加节点</h2>
<label>节点链接（hy2:// / hysteria2:// / vless://）</label>
<textarea id="nodeLink" rows="3" placeholder="hysteria2://密码@域名:端口?sni=域名&obfs=salamander&obfs-password=xxx#名字"></textarea>
<div class="row"><div><label>显示名（可选）</label><input id="nodeName" placeholder="例如 PSM-sb-hy2-opju"></div>
<div><label>地区代码（可选，如 HK / JP / US）</label><input id="nodeRegion" placeholder="JP"></div></div>
<div class="row"><div><label>探针 id（可选）</label><input id="nodeProbe" type="number" placeholder="20"></div>
<div><label>Key（可选，自动生成）</label><input id="nodeKey" placeholder="hy2-jp-xxx"></div></div>
<div class="row"><div><label>到期时间（可选，如 2027-11-14）</label><input id="nodeExpiry" type="date"></div></div>
<div class="actions"><button type="button" id="btnParse">解析预览</button> <button type="button" id="btnSaveNode">保存节点</button> <button type="button" class="ghost hidden" id="btnCancelEdit">取消编辑</button></div>
<pre id="nodePreview" class="hidden"></pre><p id="nodeMsg" class="msg"></p></div>

<div class="card panel hidden" data-panel="shares"><h2>分享链接</h2>
<p class="muted">用户登录后自动创建，每人一条；Token 仅显示前 6 位。</p>
<div class="table-scroll shares-table"><table><thead><tr><th>Token</th><th>用户</th><th>创建 / 到期</th><th>状态</th><th>访问</th><th>最后 IP / 访问</th><th>操作</th></tr></thead><tbody id="shareRows"></tbody></table></div>
<p class="actions"><button type="button" class="danger" id="btnRevokeAll">全部吊销</button></p><p id="shareMsg" class="msg"></p></div>

<div class="card panel hidden" data-panel="settings"><h2>设置</h2>
<div class="form-grid">
<div><label>萝卜门槛（默认 500）</label><input id="setThreshold" type="number"></div>
<div><label>分享有效期（小时，0 = 永不过期）</label><input id="setTtl" type="number" step="any"></div>
<div><label>探针缓存（秒）</label><input id="setProbeCache" type="number"></div>
<div><label>节点命名规则</label><input id="setNameRule"></div>
</div>
<p class="muted" id="setSources"></p>
<button type="button" id="btnSaveSettings">保存设置</button> <p id="setMsg" class="msg"></p>
<div class="section-head" style="margin-top:24px"><h2>反代 IP 诊断</h2></div>
<p class="muted">检查反向代理是否把真实客户端 IP 传给了本服务；分享页的「最后 IP」依赖它。</p>
<button type="button" class="ghost" id="btnIpCheck">检查来源 IP</button>
<pre id="ipCheckOut" class="hidden"></pre></div>
</div></div>
<script>
function applyTheme(t){document.documentElement.setAttribute("data-theme",t);var b=document.getElementById("btnTheme");if(b)b.textContent=t==="light"?"夜间模式":"白天模式";try{localStorage.setItem("emos-theme",t)}catch(e){}}
document.getElementById("btnTheme").onclick=function(){applyTheme(document.documentElement.getAttribute("data-theme")==="light"?"dark":"light")};
applyTheme(document.documentElement.getAttribute("data-theme")||"dark");
var nodes=[],editingKey=null,adminSession=null;
document.getElementById('btnIpCheck').onclick=async function(){var r=await api('GET','/api/admin/ip-check'),o=document.getElementById('ipCheckOut');o.classList.remove('hidden');o.textContent=JSON.stringify(r.json,null,2);};
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function fmtTime(t){return t?new Date(t).toLocaleString():'—'}
async function api(method,path,body){
  var o={method:method,credentials:'include',headers:{'Content-Type':'application/json'}};
  if(adminSession)o.headers['X-Admin-Token']=adminSession;
  if(body!==undefined)o.body=JSON.stringify(body);
  try{
    var r=await fetch(path,o);var j=null;try{j=await r.json()}catch(e){}
    return{status:r.status,json:j||{}};
  }catch(e){
    // fetch 本身抛错（断网、服务重启、跨域被挡）以前会静默失败，页面看起来
    // 像“点了没反应”。现在把它当成一次带错误信息的返回，让调用方显示出来。
    return{status:0,json:{ok:false,error:'网络错误：'+e.message}};
  }
}
function showLogin(msg){
  document.getElementById('loginWrap').classList.remove('hidden');
  document.getElementById('adminApp').classList.add('hidden');
  document.getElementById('unconfiguredCard').classList.add('hidden');
  var m=document.getElementById('adminMsg');
  m.textContent=msg||'';
  m.classList.toggle('err',!!msg);
}
function showUnconfigured(){
  document.getElementById('loginWrap').classList.add('hidden');
  document.getElementById('adminApp').classList.add('hidden');
  document.getElementById('unconfiguredCard').classList.remove('hidden');
}
function showApp(){
  document.getElementById('loginWrap').classList.add('hidden');
  document.getElementById('unconfiguredCard').classList.add('hidden');
  document.getElementById('adminApp').classList.remove('hidden');
}
function statChip(k,v,s){return '<div class="stat"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div>'+(s?'<div class="s">'+esc(s)+'</div>':'')+'</div>'}
async function loadHealth(){
  var r=await api('GET','/api/admin/health');
  if(r.status!==200)return;
  var j=r.json;
  document.getElementById('healthChips').innerHTML=
    statChip('节点',j.nodes+' 条','订阅内容')+
    statChip('分享',j.shares+' 条','每人一条')+
    statChip('登录会话',j.sessions+' 个','用户在线')+
    statChip('探针',j.probe_source,j.probe_nodes+' 台');
  document.getElementById('healthLine').textContent='萝卜门槛 > '+j.carrot_threshold+' · 已运行 '+Math.floor(j.uptime_seconds/60)+' 分钟';
}
async function loadNodes(){
  var r=await api('GET','/api/admin/nodes');
  if(r.status===401){adminSession=null;showLogin('登录已过期，请重新登录。');return false}
  if(r.status===503){showUnconfigured();return false}
  if(r.status===0){document.getElementById('nodeMsg').textContent=r.json.error||'网络错误。';document.getElementById('nodeMsg').classList.add('err');return false}
  if(!r.json.ok){document.getElementById('nodeMsg').textContent='拉取失败：'+(r.json.error||'');return false}
  nodes=r.json.nodes;
  document.getElementById('probeNote').textContent='探针：'+r.json.probe_source;
  document.getElementById('nodeCount').textContent='共 '+nodes.length+' 条';
  var h='';
  nodes.forEach(function(n,i){
    var probe=n.probe_node_id==null?'—':'#'+n.probe_node_id+' '+(n.online===true?'<span class="pill ok">在线</span>':n.online===false?'<span class="pill bad">离线</span>':'<span class="pill">不在探针里</span>');
    h+='<tr><td><code>'+esc(n.key)+'</code></td><td><b>'+esc(n.name)+'</b><br><span class="muted">'+esc(n.region)+'</span></td><td>'+(n.expires_at?esc(n.expires_at):(n.expires_at_probe?esc(n.expires_at_probe)+' <span class="muted">探针</span>':'—'))+'</td><td><span class="tag">'+esc(n.protocol||'—')+'</span></td><td>'+esc(n.server||'—')+':'+(n.server_port==null?'—':n.server_port)+'<br><span class="muted">sni: '+esc(n.sni||'—')+'</span></td><td>'+probe+'</td><td><button type="button" data-act="edit" data-i="'+i+'">编辑</button> <button type="button" class="ghost" data-act="up" data-i="'+i+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg></button><button type="button" class="ghost" data-act="down" data-i="'+i+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button> <button type="button" class="danger" data-act="del" data-i="'+i+'">删除</button></td></tr>';
  });
  document.getElementById('nodeRows').innerHTML=h||'<tr><td colspan="7"><div class="empty">暂无节点 · 在下方添加第一条</div></td></tr>';
  return true;
}
async function loadShares(){
  var r=await api('GET','/api/admin/shares');
  if(r.status!==200)return;
  var h='';
  r.json.shares.forEach(function(s){
    h+='<tr><td><code>'+esc(s.token_masked)+'</code></td><td><code>'+esc(s.user_id)+'</code></td><td>'+fmtTime(s.created_at)+'<br><span class="muted">到期：'+fmtTime(s.expires_at)+'</span></td><td>'+(s.enabled?'<span class="pill ok">启用</span>':'<span class="pill bad">停用' + (s.disabled_by === 'user' ? '（用户）' : s.disabled_by === 'admin' ? '（管理员）' : s.disabled_by === 'system' ? '（系统）' : '') + '</span>')+'</td><td>'+s.access_count+' 次</td><td>'+esc(s.last_ip||'—')+'<br><span class="muted">'+fmtTime(s.last_access_at)+'</span></td><td><button type="button" data-act="refresh" data-id="'+esc(s.id)+'">刷新</button> '+(s.enabled?'<button type="button" class="ghost" data-act="disable" data-id="'+esc(s.id)+'">停用</button>':'<button type="button" class="ghost" data-act="enable" data-id="'+esc(s.id)+'">启用</button>')+' <button type="button" class="danger" data-act="revoke" data-id="'+esc(s.id)+'">吊销</button></td></tr>';
  });
  document.getElementById('shareRows').innerHTML=h||'<tr><td colspan="7"><div class="empty">暂无分享 · 用户首次登录后自动出现</div></td></tr>';
}
async function loadSettings(){
  var r=await api('GET','/api/admin/settings');
  if(r.status!==200)return;
  var s=r.json.settings;
  document.getElementById('setThreshold').value=s.carrot_threshold;
  document.getElementById('setTtl').value=s.share_ttl_hours;
  document.getElementById('setNameRule').value=s.name_rule;
  document.getElementById('setProbeCache').value=s.probe_cache_seconds;
  var src=r.json.sources;
  document.getElementById('setSources').textContent='来源：门槛='+src.carrot_threshold+'，有效期='+src.share_ttl_hours+'，命名='+src.name_rule+'，探针缓存='+src.probe_cache_seconds+'。优先级：启动时环境变量 > settings.json > 默认值。';
}
async function loadAll(){
  var ok=await loadNodes();
  if(!ok)return;
  showApp();
  await loadShares();await loadSettings();await loadHealth();await loadUnlockAdmin();
}
var unlockAdminState={};
// Human-readable scan progress: which node, how far, how long — so a stall
// is visible instead of a bare "检测中…". A node taking >30s gets flagged
// as possibly stuck (worst case is ~4 sequential 8s probe timeouts).
function unlockProgressText(j){
  var p=j.progress;
  if(!p)return '';
  var secs=function(a,b){return Math.max(0,Math.round(((b||Date.now())-a)/1000))};
  if(p.phase==='starting')return '检测中… 正在启动 mihomo（校验配置），已用时 '+secs(p.startedAt)+' 秒';
  if(p.phase==='checking'){
    var s='检测中 '+p.currentIndex+'/'+p.total+'：'+(p.currentKey||'')+'（已完成 '+p.done+' 个，失败 '+p.failed+' 个），已用时 '+secs(p.startedAt)+' 秒';
    if(p.nodeStartedAt&&Date.now()-p.nodeStartedAt>30000)s+='（当前节点已 '+secs(p.nodeStartedAt)+' 秒，可能卡住）';
    return s;
  }
  if(p.phase==='finished')return '已完成 '+p.done+'/'+p.total+'（失败 '+p.failed+' 个），用时 '+secs(p.startedAt,p.finishedAt)+' 秒';
  if(p.phase==='failed')return '检测失败：'+(p.error||'未知错误');
  return '';
}
async function loadUnlockAdmin(){
  var r=await api('GET','/api/unlock');
  if(r.status!==200)return;
  var j=r.json;if(!j.ok)return;
  unlockAdminState=j;
  var n=document.getElementById('unlockAdminNote');
  if(n){
    if(!j.available){n.textContent='解锁检测未启用：服务器环境变量 UNLOCK_ENABLED 未设为 1（需重启服务）。';}
    else if(j.running){n.textContent=unlockProgressText(j)||'解锁检测进行中… 完成后自动刷新。';}
    else if(!j.enabled){n.textContent='解锁检测已关闭：24H 定时和立即检测都不再运行。';}
    else{
      var base='解锁检测已开启，每 24 小时后台更新，上次 '+(j.updatedAt?new Date(j.updatedAt).toLocaleString():'尚未完成')+(j.lastError?'（最近错误：'+j.lastError+'）':'');
      var pt=unlockProgressText(j);
      n.textContent=(pt&&j.progress&&(j.progress.phase==='finished'||j.progress.phase==='failed'))?base+'；'+pt:base;
    }
  }
  var bar=document.getElementById('unlockProgressBar');
  if(bar){
    var pct=(j.progress&&j.progress.total)?Math.round(j.progress.done/j.progress.total*100):0;
    var fill=bar.querySelector('i');if(fill)fill.style.width=pct+'%';
    bar.style.display=j.running?'':'none';
  }
  var t=document.getElementById('btnUnlockToggle');
  if(t){t.textContent='解锁检测：'+(j.enabled?'开启':'关闭');t.disabled=!j.available;}
  var b=document.getElementById('btnUnlockRun');
  if(b){b.disabled=!j.available||!j.enabled||!!j.running;b.textContent=j.running?'检测中…':'立即检测';}
}
document.getElementById('btnUnlockToggle').onclick=async function(){
  var want=!unlockAdminState.enabled;
  var r=await api('POST','/api/unlock/toggle',{enabled:want});
  if(!r.json.ok){document.getElementById('unlockAdminMsg').textContent='切换失败：'+(r.json.error||r.status);return}
  document.getElementById('unlockAdminMsg').textContent='';
  await loadUnlockAdmin();
};
document.getElementById('btnUnlockRun').onclick=async function(){
  var r=await api('POST','/api/unlock/run',{});
  if(!r.json.ok&&r.status!==409){document.getElementById('unlockAdminMsg').textContent='启动检测失败：'+(r.json.error||r.status);return}
  document.getElementById('unlockAdminMsg').textContent='';
  await loadUnlockAdmin();
  // Poll until the background scan finishes, refreshing the progress line
  // on every tick — polling without re-rendering is what left the note
  // frozen on "检测中…" with a 0-second elapsed time.
  var ticks=0;
  var timer=setInterval(async function(){
    await loadUnlockAdmin();
    ticks+=1;
    if(!unlockAdminState.running||ticks>120)clearInterval(timer);
  },1000);
};
// 先探一次后台健康状态再决定显示什么：已登录直接进后台；未配置显示
// “后台未配置”大面板；未登录才显示登录框。不要让用户对着一个永远登
// 不上去的登录框发呆。
async function initAdmin(){
  var r=await api('GET','/api/admin/health');
  if(r.status===200){await loadAll();return;}
  if(r.status===503){showUnconfigured();return;}
  if(r.status===0){showLogin(r.json.error||'无法连接服务器。');return;}
  showLogin('');
}
window.editNode=function(i){var n=nodes[i];if(!n)return;editingKey=n.key;document.getElementById('formTitle').textContent='编辑节点：'+n.key;document.getElementById('nodeLink').value=n.link||'';document.getElementById('nodeName').value=n.name;document.getElementById('nodeRegion').value=n.region||'';document.getElementById('nodeProbe').value=n.probe_node_id==null?'':n.probe_node_id;document.getElementById('nodeKey').value=n.key;document.getElementById('nodeExpiry').value=n.expires_at||'';document.getElementById('nodeKey').disabled=true;document.getElementById('btnCancelEdit').classList.remove('hidden');document.getElementById('nodeMsg').textContent='正在编辑 '+n.key+'：改链接会重新解析；不改链接只改名字/地区/探针 id/到期时间。';window.scrollTo(0,document.getElementById('formTitle').offsetTop)};
window.delNode=async function(key){if(!confirm('确定删除节点 '+key+'？订阅里会立刻去掉它。'))return;var r=await api('DELETE','/api/admin/nodes/'+encodeURIComponent(key));if(!r.json.ok){document.getElementById('nodeMsg').textContent='删除失败：'+(r.json.error||'');return}document.getElementById('nodeMsg').textContent='已删除 '+key+'。';await loadNodes();await loadHealth()};
window.moveNode=async function(i,dir){var j=i+dir;if(j<0||j>=nodes.length)return;var keys=nodes.map(function(n){return n.key});var t=keys[i];keys[i]=keys[j];keys[j]=t;var r=await api('POST','/api/admin/nodes/reorder',{keys:keys});if(!r.json.ok){document.getElementById('nodeMsg').textContent='排序失败：'+(r.json.error||'');return}await loadNodes()};
window.shareAct=async function(id,action){var r=await api('POST','/api/admin/shares/'+encodeURIComponent(id)+'/'+action);if(!r.json.ok){document.getElementById('shareMsg').textContent='操作失败：'+(r.json.error||'');return}document.getElementById('shareMsg').textContent=action==='refresh'?'已刷新，旧链接立即失效。':(action==='disable'?'已停用。':'已启用。');await loadShares()};
window.shareDel=async function(id){if(!confirm('确定吊销这条分享？对应用户的订阅链接立即失效。'))return;var r=await api('DELETE','/api/admin/shares/'+encodeURIComponent(id));if(!r.json.ok){document.getElementById('shareMsg').textContent='吊销失败：'+(r.json.error||'');return}document.getElementById('shareMsg').textContent='已吊销。';await loadShares()};
// Event delegation: no user/server data is ever interpolated into JS code
// inside an HTML attribute (HTML-entity escaping is NOT JS-string escaping).
document.getElementById('nodeRows').addEventListener('click',function(e){
  var b=e.target.closest('button[data-act]'); if(!b)return;
  var i=Number(b.getAttribute('data-i')),a=b.getAttribute('data-act');
  if(a==='edit')editNode(i);
  else if(a==='up')moveNode(i,-1);
  else if(a==='down')moveNode(i,1);
  else if(a==='del'){var n=nodes[i];if(n)delNode(n.key);}
});
document.getElementById('shareRows').addEventListener('click',function(e){
  var b=e.target.closest('button[data-act]'); if(!b)return;
  var id=b.getAttribute('data-id'),a=b.getAttribute('data-act');
  if(a==='revoke')shareDel(id); else shareAct(id,a);
});
document.getElementById('btnAdminLogin').onclick=async function(){
  var btn=document.getElementById('btnAdminLogin');
  var msg=document.getElementById('adminMsg');
  var t=document.getElementById('adminToken').value.trim();
  if(!t){msg.textContent='先输入口令。';msg.classList.add('err');return;}
  btn.disabled=true;btn.textContent='登录中…';
  try{
    var r=await api('POST','/api/admin/login',{token:t});
    if(r.status===503){msg.textContent='后台未配置：服务器没有设置 ADMIN_TOKEN。';msg.classList.add('err');return;}
    if(r.status===0){msg.textContent=r.json.error||'网络错误。';msg.classList.add('err');return;}
    if(!r.json.ok){msg.textContent='登录失败：'+(r.json.error||'');msg.classList.add('err');return;}
    // Cookie 是主路径；同时把会话 id 留在内存里，后续请求都带
    // X-Admin-Token 头——浏览器不存/不发 cookie 时也能继续用。
    if(r.json.session)adminSession=r.json.session;
    document.getElementById('adminToken').value='';
    msg.textContent='';msg.classList.remove('err');
    await loadAll();
  }catch(e){
    msg.textContent='登录失败：'+e.message;msg.classList.add('err');
  }finally{
    btn.disabled=false;btn.textContent='登录';
  }
};
document.getElementById('adminToken').addEventListener('keydown',function(e){
  if(e.key==='Enter'){e.preventDefault();document.getElementById('btnAdminLogin').click();}
});
document.getElementById('btnLogout').onclick=async function(){
  try{await api('POST','/api/admin/logout');}catch(e){}
  adminSession=null;showLogin('已退出。');
};
document.getElementById('btnRecheck').onclick=function(){initAdmin();};
document.getElementById('btnCopyCmd').onclick=function(){
  var cmd='ADMIN_TOKEN=你的口令 node server.js';
  if(navigator.clipboard){navigator.clipboard.writeText(cmd).then(function(){document.getElementById('btnCopyCmd').textContent='已复制';});}
};
document.getElementById('btnParse').onclick=async function(){var link=document.getElementById('nodeLink').value.trim();if(!link){document.getElementById('nodeMsg').textContent='先粘贴节点链接。';return}var r=await api('POST','/api/admin/nodes/parse',{link:link});var pre=document.getElementById('nodePreview');pre.classList.remove('hidden');if(!r.json.ok){pre.textContent='解析失败：'+(r.json.error||'');return}pre.textContent='协议：'+r.json.protocol+'\\n'+JSON.stringify(r.json.parsed,null,2);document.getElementById('nodeMsg').textContent='解析成功，确认无误后点“保存节点”。'};
document.getElementById('btnSaveNode').onclick=async function(){var link=document.getElementById('nodeLink').value.trim();var name=document.getElementById('nodeName').value.trim();var region=document.getElementById('nodeRegion').value.trim();var probe=document.getElementById('nodeProbe').value;var key=document.getElementById('nodeKey').value.trim();var expiry=document.getElementById('nodeExpiry').value;if(!link){document.getElementById('nodeMsg').textContent='链接不能为空。';return}var body={link:link,name:name,region:region,probe_node_id:probe===''?null:Number(probe),expires_at:expiry||null};var r;if(editingKey){r=await api('PUT','/api/admin/nodes/'+encodeURIComponent(editingKey),body)}else{if(key)body.key=key;r=await api('POST','/api/admin/nodes',body)}if(!r.json.ok){document.getElementById('nodeMsg').textContent='保存失败：'+(r.json.error||'');return}document.getElementById('nodeMsg').textContent='已保存：'+(r.json.node&&r.json.node.key);editingKey=null;document.getElementById('formTitle').textContent='添加节点';document.getElementById('nodeLink').value='';document.getElementById('nodeName').value='';document.getElementById('nodeRegion').value='';document.getElementById('nodeProbe').value='';document.getElementById('nodeExpiry').value='';document.getElementById('nodeKey').value='';document.getElementById('nodeKey').disabled=false;document.getElementById('btnCancelEdit').classList.add('hidden');document.getElementById('nodePreview').classList.add('hidden');await loadNodes();await loadHealth()};
document.getElementById('btnCancelEdit').onclick=function(){editingKey=null;document.getElementById('formTitle').textContent='添加节点';document.getElementById('nodeLink').value='';document.getElementById('nodeName').value='';document.getElementById('nodeRegion').value='';document.getElementById('nodeProbe').value='';document.getElementById('nodeExpiry').value='';document.getElementById('nodeKey').value='';document.getElementById('nodeKey').disabled=false;document.getElementById('btnCancelEdit').classList.add('hidden');document.getElementById('nodeMsg').textContent=''};
document.getElementById('btnRevokeAll').onclick=async function(){if(!confirm('确定吊销全部订阅链接？所有用户的订阅立即失效，他们需要重新登录。'))return;var r=await api('POST','/api/admin/shares/revoke-all');if(!r.json.ok){document.getElementById('shareMsg').textContent='操作失败：'+(r.json.error||'');return}document.getElementById('shareMsg').textContent='已吊销 '+r.json.revoked+' 条分享。';await loadShares()};
document.getElementById('btnSaveSettings').onclick=async function(){var body={carrot_threshold:Number(document.getElementById('setThreshold').value),share_ttl_hours:Number(document.getElementById('setTtl').value),name_rule:document.getElementById('setNameRule').value,probe_cache_seconds:Number(document.getElementById('setProbeCache').value)};var r=await api('PUT','/api/admin/settings',body);if(!r.json.ok){document.getElementById('setMsg').textContent='保存失败：'+(r.json.error||'');return}var w=(r.json.warnings||[]).join(' ');document.getElementById('setMsg').textContent='已保存，立即生效。'+(w?' 注意：'+w:'');await loadSettings()};
/* tab navigation — pure UI, no data/API change; remembers last tab locally */
function switchTab(name){
  var tabs=document.querySelectorAll('#adminTabs .tab');
  for(var i=0;i<tabs.length;i++)tabs[i].classList.toggle('active',tabs[i].getAttribute('data-tab')===name);
  var panels=document.querySelectorAll('[data-panel]');
  for(var j=0;j<panels.length;j++)panels[j].classList.toggle('hidden',panels[j].getAttribute('data-panel')!==name);
  try{localStorage.setItem('emos-admin-tab',name)}catch(e){}
}
(function initTabs(){
  var tabs=document.querySelectorAll('#adminTabs .tab');
  for(var i=0;i<tabs.length;i++)(function(b){b.onclick=function(){switchTab(b.getAttribute('data-tab'))}})(tabs[i]);
  var saved=null;try{saved=localStorage.getItem('emos-admin-tab')}catch(e){}
  if(saved)switchTab(saved);
})();
initAdmin();
</script></body></html>`;

// --- console HTML (single page, no dependencies) -------------------------
const HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EMOS 订阅控制台</title><script>try{var t=localStorage.getItem("emos-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script><style>${UI_CSS}</style></head><body><div class="wrap">
<div class="topbar"><div class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h5l4 5h7"/><circle cx="4" cy="6" r="1.6"/><circle cx="20" cy="11" r="1.6"/><path d="M4 18h16"/></svg></div><div><h1>EMOS 订阅控制台</h1><p class="subtitle">核验 EMOS 萝卜余额，领取你的专属订阅链接</p></div><span class="ver">{{VERSION}}</span><button type="button" class="ghost" id="btnTheme">白天模式</button></div>

<div class="card" id="loginCard"><h2>登录</h2>
<p class="muted">用 EMOS 账号登录，核验萝卜后进入控制台</p>
<p><a href="/auth/emos"><button type="button" class="big">用 EMOS 账号登录</button></a></p>
<p id="loginMsg" class="msg"></p></div>

<div class="card warn-card hidden" id="gatedCard"><h2>未达标</h2><div id="gatedMsg"></div><p class="muted">萝卜 &gt; <span class="th">500</span> 才能看到节点和订阅链接。去 EMOS 签到 / 赚萝卜后再来。</p></div>

<div class="hidden" id="dash">
<div class="stats">
<div class="stat"><div class="k">萝卜</div><div class="v" id="statCarrot">—</div><div class="s">门槛 &gt; <span class="th">500</span></div></div>
<div class="stat"><div class="k">节点</div><div class="v" id="statNodes">—</div><div class="s">订阅内容</div></div>
<div class="stat"><div class="k">订阅访问</div><div class="v" id="statAccess">—</div><div class="s">本条链接</div></div>
</div>
<div class="card"><h2>节点 · 总流量</h2><div class="table-scroll node-table"><table><thead><tr><th>节点</th><th>到期</th><th>状态</th><th>今日</th><th>本月已用 / 限额</th><th>解锁</th></tr></thead><tbody id="nodeRows"><tr><td colspan="6" class="muted">正在载入节点…</td></tr></tbody></table></div><p class="muted" id="unlockNote" style="margin-top:12px"></p></div>
<div class="card"><h2>订阅链接</h2><p>用户：<code id="who"></code> · 萝卜：<b id="carrotOut"></b>（门槛 &gt; <span class="th">500</span>）</p>
<p class="muted">订阅链接（每人专属，粘贴到客户端即可）：</p>
<div class="sub-row"><span class="lbl">订阅地址</span><code id="subAuto"></code><button type="button" id="btnCopyAuto">复制</button></div>
<p class="muted">一条链接全客户端通用，服务端按客户端自动识别格式（FlClash / Clash Verge 返回 Clash，sing-box / Hiddify / Karing 返回 JSON，Surge 返回 Surge 配置，Shadowrocket、Loon 等返回通用链接列表）。</p>
<p class="muted" id="shareInfo"></p>
<div class="actions"><button type="button" class="ghost" id="btnRotate">轮换链接</button> <button type="button" class="danger" id="btnDisable">停用链接</button> <button type="button" class="link-btn" id="btnLogout">退出登录</button></div>
<p class="muted" id="copyMsg"></p></div>
</div>
</div>
<script>
function applyTheme(t){document.documentElement.setAttribute("data-theme",t);var b=document.getElementById("btnTheme");if(b)b.textContent=t==="light"?"夜间模式":"白天模式";try{localStorage.setItem("emos-theme",t)}catch(e){}}
document.getElementById("btnTheme").onclick=function(){applyTheme(document.documentElement.getAttribute("data-theme")==="light"?"dark":"light")};
applyTheme(document.documentElement.getAttribute("data-theme")||"dark");
var session=null,subUrls=null,bootAuthed=false;
function legacyCopy(t,ok,fail){var a=document.createElement("textarea");a.value=t;a.setAttribute("readonly","");a.style.position="fixed";a.style.top="-1000px";document.body.appendChild(a);a.select();var done=false;try{done=document.execCommand("copy")}catch(e){}document.body.removeChild(a);done?ok():fail();}
function copyText(t,msg){var el=document.getElementById("copyMsg");var ok=function(){el.textContent=msg||"已复制。"};var fail=function(){el.textContent="自动复制失败，请手动复制："+t;el.style.userSelect="all";el.style.overflowWrap="anywhere";};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,function(){legacyCopy(t,ok,fail)})}else{legacyCopy(t,ok,fail)}}
function fmtExpiry(v){if(!v)return '—';var d=new Date(v);if(isNaN(d.getTime()))return esc(v);var s=String(v).length>=10?String(v).slice(0,10):d.toISOString().slice(0,10);var days=Math.ceil((d.getTime()-Date.now())/86400000);if(days<0)return s+' <span class="pill bad">已过期</span>';if(days<=14)return s+' <span class="pill bad">剩 '+days+' 天</span>';return s+' <span class="muted">剩 '+days+' 天</span>';}
function fmt(n){if(n==null)return "-";var u=["B","KB","MB","GB","TB"],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return n.toFixed(n>=100?0:1)+" "+u[i]}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/\'/g,"&#39;")}
function showMsg(t){document.getElementById("loginMsg").textContent=t}
function setShareInfo(sh){
  if(!sh)return;
  document.getElementById("shareInfo").textContent="订阅链接：创建于 "+new Date(sh.created_at).toLocaleString()+(sh.expires_at?"，到期 "+new Date(sh.expires_at).toLocaleString():"，永不过期")+"，已访问 "+(sh.access_count||0)+" 次"+(sh.last_access_at?"，上次访问 "+new Date(sh.last_access_at).toLocaleString():"");
  var sa=document.getElementById("statAccess");if(sa)sa.textContent=sh.access_count||0;
}
var gateThreshold=500;
function applyThreshold(t){gateThreshold=t;var i,a=document.querySelectorAll(".th");for(i=0;i<a.length;i++)a[i].textContent=t;}
fetch("/api/public-settings").then(function(r){return r.json();}).then(function(j){if(j&&typeof j.carrot_threshold==="number")applyThreshold(j.carrot_threshold);}).catch(function(){});
function renderGate(j){
  document.getElementById("gatedCard").classList.remove("hidden");
  document.getElementById("dash").classList.add("hidden");
  document.getElementById("gatedMsg").innerHTML="萝卜：<b>"+esc(j.carrot)+"</b><div class=\\"big-num bad\\">还差 "+esc(j.shortfall)+"</div>才到 "+esc(j.threshold+1)+"（&gt; "+esc(j.threshold)+"）。";
}
var unlockState={results:{},providers:[],enabled:false,updatedAt:null,lastError:null};
var expanded={}; // node key -> bool
var STATUS_LABEL={available:"解锁",partial:"部分",restricted:"受限",unsupported:"不支持",unknown:"未知",error:"异常",untested:"未测"};
function unlockTagsHtml(key){
  var d=unlockState.results[key];
  if(!d)return '<span class=\\"unlock-empty\\">暂无解锁数据</span>';
  if(d.error)return '<span class=\\"utag error\\">检测失败：'+esc(d.error)+'</span>';
  if(!d.providers)return '<span class=\\"unlock-empty\\">暂无解锁数据</span>';
  var h='<div class=\\"unlock-tags\\">';
  unlockState.providers.forEach(function(prov){
    var r=d.providers[prov]||{status:"untested"};
    var st=r.status||"untested";
    h+='<span class=\\"utag '+esc(st)+'\\" title=\\"'+esc(prov)+'\\"><b>'+esc(prov)+'</b> '+esc(STATUS_LABEL[st]||st);
    if(r.region)h+=' <small>'+esc(r.region)+'</small>';
    if((st==='error'||st==='unknown')&&r.reason)h+=' <small>'+esc(r.reason)+'</small>';
    h+='</span>';
  });
  return h+'</div>';
}
function toggleUnlock(key){
  expanded[key]=!expanded[key];
  var btn=document.querySelector('[data-unlock-key=\\"'+CSS.escape(key)+'\\"]');
  if(btn)btn.textContent=expanded[key]?"收起":"解锁";
  var row=document.getElementById("unlock-"+CSS.escape(key));
  if(row)row.classList.toggle("hidden",!expanded[key]);
}
document.getElementById("nodeRows").addEventListener("click",function(e){
  var b=e.target.closest("button[data-act=\\"unlock\\"]");
  if(b)toggleUnlock(b.getAttribute("data-unlock-key"));
});
function unlockProgressText(j){
  var p=j.progress;
  if(!p)return '';
  var secs=function(a,b){return Math.max(0,Math.round(((b||Date.now())-a)/1000))};
  if(p.phase==='starting')return '检测中… 正在启动 mihomo（校验配置），已用时 '+secs(p.startedAt)+' 秒';
  if(p.phase==='checking'){
    var s='检测中 '+p.currentIndex+'/'+p.total+'：'+(p.currentKey||'')+'（已完成 '+p.done+' 个，失败 '+p.failed+' 个），已用时 '+secs(p.startedAt)+' 秒';
    if(p.nodeStartedAt&&Date.now()-p.nodeStartedAt>30000)s+='（当前节点已 '+secs(p.nodeStartedAt)+' 秒，可能卡住）';
    return s;
  }
  if(p.phase==='finished')return '已完成 '+p.done+'/'+p.total+'（失败 '+p.failed+' 个），用时 '+secs(p.startedAt,p.finishedAt)+' 秒';
  if(p.phase==='failed')return '检测失败：'+(p.error||'未知错误');
  return '';
}
async function loadUnlock(){
  try{
    var r=await fetch("/api/unlock",{credentials:"include",headers:session?{"X-Session":session}:{}});
    if(!r.ok)return;
    var j=await r.json();
    if(!j.ok)return;
    unlockState=j;
    var n=document.getElementById("unlockNote");
    if(n){
      if(!j.available){n.textContent="解锁检测未启用：服务器环境变量 UNLOCK_ENABLED 未设为 1（需重启服务）";}
      else if(j.running){n.textContent=unlockProgressText(j)||"解锁检测进行中… 完成后节点表会自动刷新。";}
      else if(!j.enabled){n.textContent="解锁检测已关闭，每 24 小时不会再更新。";}
      else{
        var base="解锁检测已开启，每 24 小时后台更新，上次 "+(j.updatedAt?new Date(j.updatedAt).toLocaleString():"尚未完成")+(j.lastError?"（最近错误："+j.lastError+"）":"");
        var pt=unlockProgressText(j);
        n.textContent=(pt&&j.progress&&(j.progress.phase==="finished"||j.progress.phase==="failed"))?base+"；"+pt:base;
      }
    }
  }catch(e){}
}
async function loadNodes(){
  var r;
  try{r=await fetch("/api/nodes",{credentials:"include",headers:session?{"X-Session":session}:{}});}
  catch(e){showMsg("拉取节点失败：网络错误，"+e.message);return;}
  var j=await r.json();
  if(!j.ok){showMsg("拉取节点失败：" + (j.error||""));return}
  document.getElementById("statNodes").textContent=j.nodes.length;
  var html="";
  j.nodes.forEach(function(n){
    var pct=n.pct_used==null?"—":n.pct_used+"%";
    var bar=n.pct_used==null?"":"<div class=\\"bar\\"><i style=\\"width:"+Math.min(100,n.pct_used)+"%\\"></i></div>";
    var pill=n.online===true?'<span class="pill ok">在线</span>':n.online===false?'<span class="pill bad">离线</span>':'<span class="pill">未知 · 不在探针里</span>';
    var key=String(n.key);
    var isOpen=!!expanded[key];
    html+="<tr><td data-label=\\"\\"><b>"+esc(n.name)+"</b></td><td data-label=\\"到期\\">"+fmtExpiry(n.expires_at)+"</td><td data-label=\\"状态\\">"+pill+"</td><td data-label=\\"今日\\">"+fmt(n.day_used)+"</td><td data-label=\\"本月已用 / 限额\\">"+fmt(n.month_used)+" / "+(n.traffic_limit?fmt(n.traffic_limit):"不限")+"<br><span class=\\"muted\\">已用 "+pct+" · 剩余 "+(n.remaining==null?"—":fmt(n.remaining))+"</span>"+bar+"</td><td><button type=\\"button\\" class=\\"expand-btn\\" data-act=\\"unlock\\" data-unlock-key=\\""+esc(key)+"\\">"+(isOpen?"收起":"解锁")+"</button></td></tr>";
    html+="<tr class=\\"unlock-row "+(isOpen?"":"hidden")+"\\" id=\\"unlock-"+esc(key)+"\\"><td colspan=\\"6\\">"+unlockTagsHtml(key)+"</td></tr>";
  });
  document.getElementById("nodeRows").innerHTML=html||"<tr><td colspan=\\"6\\">暂无节点</td></tr>";
}
document.getElementById("btnCopyAuto").onclick=function(){var url=subUrls&&(subUrls.c_url||subUrls.url);if(!url){showMsg("订阅链接还没准备好，请重新登录或稍后再试。");return}copyText(url,"已复制订阅链接，粘贴到客户端即可。");};
document.getElementById("btnRotate").onclick=async function(){var r=await fetch("/api/sub/refresh",{method:"POST",credentials:"include",headers:session?{"X-Session":session}:{}});var j=await r.json();if(!j.ok){showMsg("刷新失败：" + (j.error||""));return}subUrls=j.sub_urls;document.getElementById("subAuto").textContent=subUrls.c_url||subUrls.url;setShareInfo(j.share);document.getElementById("copyMsg").textContent="已生成新订阅链接，旧链接立即失效，请重新导入。"};
document.getElementById("btnDisable").onclick=async function(){if(!confirm("停用后订阅链接立即失效，重新登录才能恢复，确定？"))return;var r=await fetch("/api/sub/disable",{method:"POST",credentials:"include",headers:session?{"X-Session":session}:{}});var j=await r.json();if(j.ok){setShareInfo(j.share);document.getElementById("copyMsg").textContent="订阅链接已停用。"}};
document.getElementById("btnLogout").onclick=async function(){try{await fetch("/api/logout",{method:"POST",credentials:"include",headers:session?{"X-Session":session}:{}});}catch(e){}session=null;subUrls=null;document.getElementById("dash").classList.add("hidden");document.getElementById("gatedCard").classList.add("hidden");document.getElementById("loginCard").classList.remove("hidden");showMsg("已退出登录。")};
(function(){var q=new URLSearchParams(location.search);var e=q.get("emos_error");if(!e)return;var c=q.get("carrot");var t=parseInt(q.get("threshold"),10)||gateThreshold;var m={no_token:"EMOS 回跳里没有带 token，请重新点“用 EMOS 账号登录”再试一次。",bad_state:"登录状态不对（uuid 不匹配或已过期），请重新点“用 EMOS 账号登录”。",not_signed_in:"EMOS 未确认这次登录（sign/check 未通过：可能是 token 无效，或今天还没在 EMOS 签到），请在 EMOS 登录/签到后再试。",carrot_insufficient:"萝卜不够：当前 "+(c||"?")+"，还差 "+(c?Math.max(0,t+1-c):"?")+" 才到 "+(t+1)+"（> "+t+"）。"};showMsg(m[e]||("登录失败："+e));if(e==="carrot_insufficient"){var cv=Number(c),ok=isFinite(cv)&&c!=="";renderGate({carrot:ok?cv:"?",shortfall:ok?Math.max(0,t+1-cv):"?",threshold:t});}history.replaceState(null,"",location.pathname);})();
function showLoggedOut(){
  document.getElementById("dash").classList.add("hidden");
  document.getElementById("gatedCard").classList.add("hidden");
  document.getElementById("loginCard").classList.remove("hidden");
  showMsg("登录状态已失效，请重新登录。");
}
async function tryResume(){
  try{
    var rs=await Promise.all([
      fetch("/api/nodes",{credentials:"include"}),
      fetch("/api/sub-link",{credentials:"include"})
    ]);
    var j=await rs[0].json(),j2=await rs[1].json();
    var authGone=rs[0].status===401||rs[1].status===401||rs[1].status===410;
    if(!rs[0].ok||!j.ok||!rs[1].ok||!j2.ok){if(bootAuthed&&authGone)showLoggedOut();return;}
    subUrls=j2.sub_urls||{singbox:j2.sub_url,clash:j2.sub_url,links:j2.sub_url};
    document.getElementById("gatedCard").classList.add("hidden");
    document.getElementById("dash").classList.remove("hidden");
    document.getElementById("loginCard").classList.add("hidden");
    document.getElementById("who").textContent=j.user_id;
    document.getElementById("carrotOut").textContent=j.carrot;
    document.getElementById("statCarrot").textContent=j.carrot;
    document.getElementById("subAuto").textContent=subUrls.c_url||subUrls.url;
    setShareInfo(j2.share);
    if(!bootAuthed)showMsg("已登录，萝卜 "+j.carrot+"。");
    loadNodes();
  }catch(e){/* transient network error: keep the server-rendered dashboard */}
}
tryResume();
loadUnlock();
setInterval(function(){if(!document.getElementById("dash").classList.contains("hidden")){loadNodes();loadUnlock();}},30000);
</script></body></html>`;
// The session cookie is HttpOnly, so JS cannot decide the first paint.
// Render the authenticated dashboard server-side to avoid a login-card flash.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderConsoleHtml(req) {
  const s = getSession(req);
  const share = s && s.shareToken ? getShare(s.shareToken) : null;
  if (!s || !share) return HTML_RENDERED;
  const urls = subUrls(req, share.token);
  // urls contains only a validated host and hex tokens; JSON is safe inline.
  const boot = JSON.stringify(urls);
  return HTML_RENDERED
    .replace('<div class="card" id="loginCard">', '<div class="card hidden" id="loginCard">')
    .replace('<div class="hidden" id="dash">', '<div id="dash">')
    .replace('<div class="v" id="statCarrot">—</div>', '<div class="v" id="statCarrot">' + escHtml(s.carrot) + '</div>')
    .replace('<code id="who"></code>', '<code id="who">' + escHtml(s.user_id) + '</code>')
    .replace('<b id="carrotOut"></b>', '<b id="carrotOut">' + escHtml(s.carrot) + '</b>')
    .replace('<code id="subAuto"></code>', '<code id="subAuto">' + escHtml(urls.c_url || urls.url) + '</code>')
    .replace('var session=null,subUrls=null,bootAuthed=false;',
             'var session=null,subUrls=' + boot + ',bootAuthed=true;');
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders() });
      return res.end(renderConsoleHtml(req));
    }
    if (req.method === 'GET' && u.pathname === '/health') return sendJson(res, 200, { ok: true, version: VERSION, nodes: NODES.length });
    if (req.method === 'GET' && u.pathname === '/admin') return handleAdminPage(req, res);
    if (req.method === 'POST' && u.pathname === '/api/admin/login') return await handleAdminLogin(req, res);
    if (req.method === 'POST' && u.pathname === '/api/admin/logout') return await handleAdminLogout(req, res);
    if (u.pathname.startsWith('/api/admin/')) return await handleAdminApi(req, res);
    // Public: the carrot threshold is display info (the console subtitle shows it), so no auth needed.
    if (req.method === 'GET' && u.pathname === '/api/public-settings') return sendJson(res, 200, { ok: true, carrot_threshold: CARROT_THRESHOLD });
    if (req.method === 'POST' && u.pathname === '/api/auth') return await handleAuth(req, res);
    if (req.method === 'GET' && u.pathname === '/auth/emos') return handleEmosLogin(req, res);
    if (req.method === 'GET' && u.pathname === '/auth/emos/callback') return await handleEmosCallback(req, res);
    if (req.method === 'GET' && u.pathname === '/api/auth/emos/login-url') return handleEmosLoginUrl(req, res);
    if (req.method === 'GET' && u.pathname === '/api/nodes') return await handleNodes(req, res);
    if (req.method === 'GET' && u.pathname === '/api/unlock') {
      // Read-only state: both the console (shows the unlock column) and the
      // admin panel (owns the controls) need it.
      if (!getSession(req) && !getAdminSession(req)) return sendJson(res, 401, { ok: false, error: 'login required' });
      return sendJson(res, 200, unlockPublic());
    }
    // Admin controls: toggle detection and trigger an immediate scan. These
    // are operator actions, so they require admin auth — a console session
    // must NOT be able to flip them.
    if (req.method === 'POST' && u.pathname === '/api/unlock/toggle') {
      if (!requireAdmin(req, res)) return;
      if (!UNLOCK_ENABLED) return sendJson(res, 400, { ok: false, error: 'unlock detection is disabled by environment (UNLOCK_ENABLED=0)' });
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
      unlockRuntimeEnabled = body.enabled === undefined ? !unlockRuntimeEnabled : !!body.enabled;
      atomicWriteUnlock();
      return sendJson(res, 200, { ok: true, enabled: unlockRuntimeEnabled });
    }
    if (req.method === 'POST' && u.pathname === '/api/unlock/run') {
      if (!requireAdmin(req, res)) return;
      if (!UNLOCK_ENABLED || !unlockRuntimeEnabled) return sendJson(res, 400, { ok: false, error: 'unlock detection is off' });
      if (!fs.existsSync(MIHOMO_BIN)) return sendJson(res, 400, { ok: false, error: 'mihomo binary not found — run ./manage.sh install-mihomo' });
      if (unlockRunning) return sendJson(res, 409, { ok: false, error: 'a detection is already running' });
      // Mark running BEFORE returning so the client's first poll cannot see
      // a false "finished" while the process is still validating config.
      unlockRunning = true;
      // Fire and forget: the client polls GET /api/unlock for `running=false`.
      doUnlock().catch((e) => { unlockLastError = e.message; }).finally(() => { unlockRunning = false; });
      return sendJson(res, 202, { ok: true, started: true });
    }
    if (req.method === 'GET' && u.pathname === '/api/sub-link') return await handleSubLink(req, res);
    if (req.method === 'POST' && u.pathname === '/api/sub/refresh') return await handleSubRefresh(req, res);
    if (req.method === 'POST' && u.pathname === '/api/sub/disable') return await handleSubDisable(req, res);
    if (req.method === 'POST' && u.pathname === '/api/logout') return await handleLogout(req, res);
    if (req.method === 'GET' && (u.pathname === '/c/' || u.pathname === '/c')) {
      const token = u.searchParams.get('token');
      if (!token) return sendJson(res, 400, { ok: false, error: 'missing ?token=' });
      return await serveSubscription(req, res, token);
    }
    if (req.method === 'GET' && u.pathname.startsWith('/sub/')) {
      const token = safeDecode(u.pathname.slice(5));
      return await handleSub(req, res, token);
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error(e);
    // If headers already went out (a builder threw mid-response), there is
    // nothing to send — just close the connection instead of throwing again.
    if (!res.headersSent) return sendJson(res, 500, { ok: false, error: e.message });
    try { res.end(); } catch (_) { /* already closed */ }
  }
});

if (require.main === module) {
  loadState();
  loadUnlock();
  if (UNLOCK_ENABLED) {
    // Defer the first run so boot stays fast; then every 24 h.
    setTimeout(() => { runUnlock(); }, 5000).unref();
    setInterval(() => { runUnlock(); }, UNLOCK_INTERVAL_MS).unref();
  }
  const flushAndExit = () => { if (stateDirty) saveStateNow(); try { unlockLib.stopAllMihomo(); } catch (e) {} process.exit(0); };
  process.on('SIGTERM', flushAndExit);
  process.on('SIGINT', flushAndExit);
  server.listen(PORT, () => {
    console.log('emos-sub v' + VERSION + ' listening on http://127.0.0.1:' + PORT);
    console.log('nodes loaded: ' + NODES.map((n) => n.key + '->probe#' + n.probe_node_id).join(', '));
  });
}
// Pre-rendered pages: avoid a split/join over the full HTML on every request.
const HTML_RENDERED = HTML.split('{{VERSION}}').join(VERSION);
const ADMIN_HTML_RENDERED = ADMIN_HTML.split('{{VERSION}}').join(VERSION);

// Pure helpers exported for test/check-pages.js unit tests (no server started).
module.exports = { server, monthEndExpireMs, normalizeExpiry, validateProbeId, parseHy2, parseVless, resolveClientIp, pickClientIp, normalizeIp, ipDiagnostics, safeDecode, unlockPublic, runUnlock, doUnlock, VERSION };

