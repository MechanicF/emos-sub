// EMOS-gated sing-box gateway v1.4.3 — zero dependencies.
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
// Last-resort nets (2026-11-26 audit): the dispatcher awaits every handler,
// so request errors are caught there. These two only guard against a bug
// that slips past that — log loudly, keep serving, never die on one request.
process.on('unhandledRejection', (e) => { console.error('UNHANDLED REJECTION (kept running):', e); });
process.on('uncaughtException', (e) => { console.error('UNCAUGHT EXCEPTION (kept running):', e); });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const VERSION = '1.4.3';
const CONFIG_PATH = path.join(__dirname, 'config', 'nodes.json');
const CLASH_TEMPLATE_PATH = path.join(__dirname, 'config', 'templates', 'clash.yaml');
const SINGBOX_TEMPLATE_PATH = path.join(__dirname, 'config', 'templates', 'singbox.json');
const PROBE_URL = 'https://1e.lol/api/nodes';
const EMOS_BASE = process.env.EMOS_BASE || 'https://emos.best';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CARROT_RECHECK_MS = Math.max(1000, parseInt(process.env.CARROT_RECHECK_MS || '600000', 10) || 600000);
// Runtime settings (mutable — admin can change them without a restart).
// Precedence at startup: env var > config/settings.json > default.
// CARROT_THRESHOLD: strict, carrot must be > this. SHARE_TTL_HOURS: 0 = never.
// PROBE_CACHE_SECONDS: how long the 1e.lol probe response is cached.
let CARROT_THRESHOLD = 500;
let SHARE_TTL_HOURS = 24;
let PROBE_CACHE_MS = 30 * 1000;
function shareTtlMs() {
  return Number.isFinite(SHARE_TTL_HOURS) && SHARE_TTL_HOURS > 0 ? SHARE_TTL_HOURS * 3600 * 1000 : null;
}
const SETTINGS_PATH = path.join(__dirname, 'config', 'settings.json');
const SETTINGS_SOURCES = { carrot_threshold: 'default', share_ttl_hours: 'default', name_rule: 'default', probe_cache_seconds: 'default' };

let NODES = [];
let NAME_RULE = '[$Flag] $LinkCountryName - $Name';
let NODES_NOTE = 'DEMO TEMPLATE — Replace links with real nodes.';
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
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
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
// forever (slow memory leak + stale shares pointing at dead sessions).
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now > s.expiresAt) { sessions.delete(sid); if (s.shareToken) shares.delete(s.shareToken); }
  }
  for (const [tok, s] of shares) {
    if ((s.expires_at && now > s.expires_at) || !sessions.has(s.sessionId)) shares.delete(tok);
  }
  for (const [sid, s] of adminSessions) if (now > s.expiresAt) adminSessions.delete(sid);
  for (const [k, v] of rateLimits) if (now > v.resetAt) rateLimits.delete(k);
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
    req.on('data', (c) => { data += c; if (data.length > 65536) { req.destroy(); reject(new Error('request body too large')); } });
    req.on('end', () => {
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
  if (Date.now() > s.expiresAt) { sessions.delete(sid); if (s.shareToken) shares.delete(s.shareToken); return null; }
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
  return { id: s.id || null, token_masked: maskToken(s.token), user_id: s.user_id, created_at: s.created_at, expires_at: s.expires_at, enabled: s.enabled, access_count: s.access_count, last_ip: s.last_ip, last_user_agent: s.last_user_agent, last_access_at: s.last_access_at };
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
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}
function saveNodesConfig() {
  const prev = path.join(__dirname, 'config', 'nodes.json.bak');
  try { fs.copyFileSync(CONFIG_PATH, prev); } catch (e) { /* first save: no previous file */ }
  const doc = { _note: NODES_NOTE, name_rule: NAME_RULE, nodes: NODES };
  atomicWrite(CONFIG_PATH, JSON.stringify(doc));
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
    const password = decodeURIComponent(rawUserinfo);
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
    const name = decodeURIComponent(u.hash ? u.hash.slice(1) : '') || fallbackName;
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
    const uuid = decodeURIComponent(u.username);
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
    const name = decodeURIComponent(u.hash ? u.hash.slice(1) : '') || fallbackName;
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
  for (const n of NODES) {
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
async function fetchProbe() {
  const now = Date.now();
  if (probeCache.data && now - probeCache.at < PROBE_CACHE_MS) return probeCache;
  try {
    const r = await fetch(PROBE_URL, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('probe HTTP ' + r.status);
    const j = await r.json();
    if (!Array.isArray(j.nodes)) throw new Error('probe: no nodes array');
    probeCache = { at: now, data: j.nodes, source: 'live' };
    return probeCache;
  } catch (e) {
    console.error('Probe fetch failed, using labelled sample fallback:', e.message);
    // Keep any stale live cache if we have it; otherwise sample (labelled).
    // Cache the failure too: without this, every request paid the full 10 s
    // fetch timeout while the probe was down.
    if (probeCache.data) return { ...probeCache, source: 'live-stale' };
    probeCache = { at: now, data: SAMPLE_PROBE, source: 'sample-fallback' };
    return probeCache;
  }
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
async function emosCheck(token) {
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  const [carrotRes, signRes] = await Promise.all([
    fetch(EMOS_BASE + '/api/carrot/current', { headers, signal: AbortSignal.timeout(10000) }),
    fetch(EMOS_BASE + '/api/sign/check', { headers, signal: AbortSignal.timeout(10000) }).catch(() => null),
  ]);
  if (!carrotRes.ok) throw new Error('EMOS carrot check failed: HTTP ' + carrotRes.status);
  const carrotJson = await carrotRes.json();
  const carrot = Number(carrotJson.carrot);
  if (!Number.isFinite(carrot)) throw new Error('EMOS carrot response has no numeric carrot');
  let userId = 'unknown', username = null;
  if (signRes && signRes.ok) {
    const s = await signRes.json().catch(() => ({}));
    if (s.user_id) userId = s.user_id;
  }
  return { carrot, user_id: userId, username };
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
  // x-forwarded-proto may be a comma list ("https, http") — take the first.
  const xf = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xf || (req.socket && req.socket.encrypted ? 'https' : 'http');
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
  // One live session per user_id: a fresh login revokes the previous one
  // (and its subscription link). Before this, every re-login minted an
  // extra permanently-valid link, so "one link per person" was not true.
  for (const [sid, s] of sessions) {
    if (s.user_id === result.user_id) { sessions.delete(sid); if (s.shareToken) shares.delete(s.shareToken); }
  }
  const sessionId = randHex(16);
  const now = Date.now();
  const share = createShare(sessionId, result.user_id);
  const subToken = share.token;
  sessions.set(sessionId, { user_id: result.user_id, username: result.username, carrot: result.carrot, emosToken: token || null, demo, expiresAt: now + SESSION_TTL_MS, lastCarrotCheck: now, shareToken: subToken });
  const urls = subUrls(req, subToken);
  return { sessionId, share, subToken, sub_url: baseUrl(req) + '/sub/' + subToken, sub_urls: urls, import_url: urls.import_url };
}

// --- handlers ------------------------------------------------------------
async function handleAuth(req, res) {
  // Each attempt costs two EMOS API calls: cap it so the gateway cannot be
  // used as an EMOS-check oracle or a DDoS amplifier.
  if (!rateLimitCheck(req, res, 'auth:' + clientIp(req), 30, 10 * 60 * 1000)) return;
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const demoCarrot = typeof body.carrot === 'number' ? body.carrot : (typeof body.carrot === 'string' && body.carrot !== '' ? Number(body.carrot) : NaN);

  let result;
  let demo = false;
  if (token) {
    try { result = await emosCheck(token); }
    catch (e) { return sendJson(res, 502, { ok: false, error: 'EMOS check failed: ' + e.message }); }
  } else if (Number.isFinite(demoCarrot) && process.env.DEMO_ENABLED === '1') {
    // Demo login is off by default; enable only for local testing with DEMO_ENABLED=1.
    demo = true;
    result = { carrot: demoCarrot, user_id: 'demo-user', username: 'demo-user' };
  } else {
    return sendJson(res, 400, { ok: false, error: 'Provide {token} (EMOS Bearer token)' });
  }

  const carrot = result.carrot;
  if (!(carrot > CARROT_THRESHOLD)) {
    return sendJson(res, 200, { ok: false, gated: false, user_id: result.user_id, username: result.username, carrot, threshold: CARROT_THRESHOLD, shortfall: CARROT_THRESHOLD + 1 - carrot, reason: 'carrot<=500' });
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
  const u = new URL(req.url, 'http://localhost');
  const token = (u.searchParams.get('token') || u.searchParams.get('access_token') || '').trim();
  const uuid = u.searchParams.get('uuid') || '';
  const fail = (code, carrot) => {
    let loc = '/?emos_error=' + code;
    if (typeof carrot === 'number') loc += '&carrot=' + carrot;
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
  try { result = await emosCheck(token); }
  catch (e) { return fail('not_signed_in'); }
  if (sign.user_id && sign.user_id !== 'unknown') result.user_id = sign.user_id;
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
  const share = shares.get(s.shareToken);
  const urls = subUrls(req, s.shareToken);
  return sendJson(res, 200, { ok: true, user_id: s.user_id, demo: s.demo, sub_url: urls.url, sub_urls: urls, import_url: urls.import_url, share: shareInfo(share) });
}

// POST /api/logout — end the current user session (cookie and/or X-Session)
// and clear the emos_session cookie. Added 2026-11-26: the console hides the
// login card once the dashboard shows, so users need a way back out.
function handleLogout(req, res) {
  const s = getSession(req);
  if (s) { sessions.delete(s.sid); if (s.shareToken) shares.delete(s.shareToken); }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'emos_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' + cookieSecure(req) });
  return res.end(JSON.stringify({ ok: true }));
}

// POST /api/sub/refresh — rotate the share token; the old token 403s immediately.
async function handleSubRefresh(req, res) {
  const s = getSession(req);
  if (!s) return sendJson(res, 401, { ok: false, error: 'missing or expired X-Session — login first' });
  const sess = sessions.get(s.sid);
  if (!sess) return sendJson(res, 401, { ok: false, error: 'missing or expired X-Session — login first' });
  // Rotating must not bypass the gate: an admin-disabled share, or a carrot
  // that dropped since login, must not mint a fresh link without a live
  // EMOS check. (Re-login does the same check; refresh is no cheaper.)
  if (sess.emosToken && Date.now() - sess.lastCarrotCheck > CARROT_RECHECK_MS) {
    const verdict = await recheckCarrot(s.sid, sess);
    if (verdict === 'revoked') return sendJson(res, 403, { ok: false, error: 'carrot dropped below 500 (or EMOS token invalid) — please log in again' });
    if (!sessions.get(s.sid)) return sendJson(res, 401, { ok: false, error: 'session ended — please log in again' });
  }
  const old = shares.get(s.shareToken);
  if (old) { old.enabled = false; shares.delete(s.shareToken); }
  const share = createShare(s.sid, s.user_id);
  sess.shareToken = share.token;
  const urls = subUrls(req, share.token);
  return sendJson(res, 200, { ok: true, user_id: s.user_id, sub_token: share.token, sub_url: urls.url, sub_urls: urls, import_url: urls.import_url, share: shareInfo(share) });
}

// POST /api/sub/disable — disable the current share; /sub and /c return 403
// until the user re-authenticates (which creates a fresh share).
function handleSubDisable(req, res) {
  const s = getSession(req);
  if (!s) return sendJson(res, 401, { ok: false, error: 'missing or expired X-Session — login first' });
  const share = shares.get(s.shareToken);
  if (share) share.enabled = false;
  return sendJson(res, 200, { ok: true, user_id: s.user_id, disabled: true, share: shareInfo(share) });
}

// Carrot re-check for a live session. Returns:
//   'ok'      — EMOS confirms carrot still > threshold (fresh for 10 min)
//   'revoked' — carrot dropped, or the EMOS token is dead (401/403):
//               the whole session + share are deleted, caller must 403.
//   'stale'   — EMOS unreachable / 5xx this time: serve this one request,
//               retry soon (60 s) instead of failing every subscription
//               fetch for the whole EMOS outage.
// (2026-11-26 audit) The old code set lastCarrotCheck BEFORE the threshold
// test, so one failed re-check granted 10 more minutes of free serving.
async function recheckCarrot(sid, sess) {
  try {
    const r = await emosCheck(sess.emosToken);
    sess.carrot = r.carrot;
    if (!(r.carrot > CARROT_THRESHOLD)) {
      sessions.delete(sid);
      if (sess.shareToken) shares.delete(sess.shareToken);
      return 'revoked';
    }
    sess.lastCarrotCheck = Date.now();
    return 'ok';
  } catch (e) {
    if (/HTTP 40[13]/.test(e.message || '')) {
      sessions.delete(sid);
      if (sess.shareToken) shares.delete(sess.shareToken);
      return 'revoked';
    }
    console.error('Carrot re-check failed (transient, retry in 60s):', e.message);
    sess.lastCarrotCheck = Date.now() - CARROT_RECHECK_MS + 60 * 1000;
    return 'stale';
  }
}

// Resolve a subscription token to its session, enforcing share + session
// expiry and the EMOS carrot re-check for real sessions.
async function resolveShare(req, res, token) {
  const share = getShare(token);
  if (!share) { sendJson(res, 403, { ok: false, error: 'invalid, disabled or expired subscription token' }); return null; }
  const sess = sessions.get(share.sessionId);
  if (!sess || Date.now() > sess.expiresAt) { shares.delete(token); sendJson(res, 403, { ok: false, error: 'subscription expired' }); return null; }
  // Re-check carrot for real EMOS sessions (cached 10 min). Demo sessions skip.
  if (sess.emosToken && Date.now() - sess.lastCarrotCheck > CARROT_RECHECK_MS) {
    const verdict = await recheckCarrot(share.sessionId, sess);
    if (verdict === 'revoked') { sendJson(res, 403, { ok: false, error: 'carrot dropped below 500 (or EMOS token invalid) — subscription revoked, please log in again' }); return null; }
    // 'ok' or 'stale': serve this request.
  }
  // Access log (sublinkPro per-link access count + IP logs).
  share.access_count += 1;
  share.last_ip = clientIp(req);
  share.last_user_agent = req.headers['user-agent'] || null;
  share.last_access_at = Date.now();
  return { share, sess };
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
  const commonHeaders = { 'Cache-Control': 'private, no-store', 'Subscription-Userinfo': userinfo, 'Profile-Title': 'EMOS-gated sing-box' };

  if (format === 'html') {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const page = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>订阅 · EMOS-gated</title>'
      + '<style>body{margin:0;padding:28px 20px 48px;min-height:100vh;color:#eef2f8;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.6;background:linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.022) 1px,transparent 1px),radial-gradient(1000px 520px at 10% -10%,rgba(99,102,241,.32),transparent 60%),radial-gradient(820px 500px at 95% -5%,rgba(34,211,238,.16),transparent 55%),radial-gradient(720px 520px at 50% 115%,rgba(139,92,246,.14),transparent 60%),linear-gradient(180deg,#080c16,#070a12);background-size:44px 44px,44px 44px,auto,auto,auto,auto}.wrap{max-width:640px;margin:0 auto}.card{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);border-radius:20px;padding:20px 22px;margin:14px 0;box-shadow:0 16px 40px rgba(0,0,0,.42)}h1{font-size:23px;font-weight:800;letter-spacing:-.01em;margin:0 0 6px}h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;margin:0 0 8px}a{color:#93c5fd;text-decoration:none}a:hover{text-decoration:underline}code{word-break:break-all;background:rgba(0,0,0,.4);padding:2px 7px;border-radius:6px;font-size:13px}.muted{color:#94a3b8;font-size:13px}</style></head><body><div class="wrap">'
      + '<h1>订阅链接</h1><p class="muted">专属订阅地址，萝卜 ≤ 500 即失效。请在客户端里粘贴这条链接，不要用浏览器直接下载。</p>'
      + '<div class="card"><h2>订阅链接（按客户端自动识别）</h2><p><a href="' + esc(urls.c_url) + '">' + esc(urls.c_url) + '</a></p><p><a href="' + esc(urls.import_url) + '">一键导入</a></p></div>'
      + '<p class="muted">同一条链接，FlClash / Clash Verge 返回 Clash，sing-box / Hiddify / Karing 返回 JSON，Surge 返回 Surge 配置，Shadowrocket、Loon 等返回通用链接列表。Subscription-Userinfo 为节点总流量，不是个人用量；到期时间为本月底 23:59。</p>'
      + '</div></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...commonHeaders });
    return res.end(page);
  }
  // Build the body BEFORE writeHead: a builder that throws after the 200
  // headers are sent leaves the connection hanging (and used to crash the
  // process via the un-awaited handler — see dispatcher).
  if (format === 'clash') {
    const body = buildClashYaml();
    res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8', 'profile-update-interval': '24', ...commonHeaders });
    return res.end(body);
  }
  if (format === 'surge') {
    const body = buildSurgeConfig(req, token);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...commonHeaders });
    return res.end(body);
  }
  if (format === 'links') {
    const body = buildLinksText();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...commonHeaders });
    return res.end(body);
  }
  if (format === 'b64') {
    const body = Buffer.from(buildLinksText(), 'utf8').toString('base64') + '\n';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...commonHeaders });
    return res.end(body);
  }
  // singbox (default for sing-box / Hiddify / Karing UA, and ?format=singbox)
  const cfg = buildSingBoxConfig();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...commonHeaders });
  res.end(JSON.stringify(cfg, null, 2));
}

async function handleSub(req, res, subToken) { return serveSubscription(req, res, subToken); }

// --- admin API handlers ---------------------------------------------------
async function handleAdminLogin(req, res) {
  if (!ADMIN_TOKEN) return sendJson(res, 503, { ok: false, error: 'admin not configured: set ADMIN_TOKEN env and restart the server' });
  // Brute-force guard: 5 wrong guesses lock this IP for 15 min.
  if (adminLoginBlocked(clientIp(req))) return sendJson(res, 429, { ok: false, error: 'too many failed logins, try again later' });
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
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
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': 'admin_session=' + sid + '; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax' + cookieSecure(req) });
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
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': 'admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' + cookieSecure(req) });
  return res.end(JSON.stringify({ ok: true }));
}
function handleAdminPage(req, res) {
  // Always serve the admin page (200), even when ADMIN_TOKEN is unset:
  // the page probes GET /api/admin/health on load and shows a clear
  // "后台未配置" panel with the exact restart command when it gets a 503.
  // Returning a bare 503 page here used to leave the user with no way to
  // tell a misconfiguration from a broken login form.
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders() });
  return res.end(ADMIN_HTML.split('{{VERSION}}').join(VERSION));
}
async function handleAdminApi(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (!requireAdmin(req, res)) return;
  const readJsonBody = async () => {
    try { return await readBody(req); } catch (e) { return null; }
  };
  // ---- Nodes ----
  if (req.method === 'GET' && p === '/api/admin/nodes') {
    const probe = await fetchProbe();
    const probeMap = new Map(probe.data.map((x) => [x.id, x]));
    return sendJson(res, 200, { ok: true, probe_source: probe.source, nodes: NODES.map((n) => nodeAdminView(n, probeMap)) });
  }
  if (req.method === 'POST' && p === '/api/admin/nodes/parse') {
    const body = await readJsonBody();
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
    const link = typeof body.link === 'string' ? body.link.trim() : '';
    if (!link) return sendJson(res, 400, { ok: false, error: 'link is required' });
    const { protocol, parsed } = parseAnyLink(link, '');
    if (!protocol || !parsed) return sendJson(res, 400, { ok: false, error: 'unsupported or unparsable link: only hy2://, hysteria2:// and vless:// are accepted' });
    return sendJson(res, 200, { ok: true, protocol, parsed });
  }
  if (req.method === 'POST' && p === '/api/admin/nodes') {
    const body = await readJsonBody();
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
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
    NODES = keys.map((k) => NODES.find((n) => n.key === k));
    saveNodesConfig();
    return sendJson(res, 200, { ok: true, keys: NODES.map((n) => n.key) });
  }
  const nodeMatch = p.match(/^\/api\/admin\/nodes\/([^/]+)$/);
  if (nodeMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const key = decodeURIComponent(nodeMatch[1]);
    const idx = NODES.findIndex((n) => n.key === key);
    if (idx < 0) return sendJson(res, 404, { ok: false, error: 'node not found: ' + key });
    if (req.method === 'DELETE') {
      const removed = NODES.splice(idx, 1)[0];
      saveNodesConfig();
      return sendJson(res, 200, { ok: true, removed: { key: removed.key, name: removed.name } });
    }
    const body = await readJsonBody();
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
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
    return sendJson(res, 200, { ok: true, revoked: count, note: 'All subscription tokens are now invalid; users must log in again to get a new share.' });
  }
  const shareAction = p.match(/^\/api\/admin\/shares\/([^/]+)\/(refresh|enable|disable)$/);
  if (req.method === 'POST' && shareAction) {
    const s = findShareByRef(decodeURIComponent(shareAction[1]));
    if (!s) return sendJson(res, 404, { ok: false, error: 'share not found' });
    const action = shareAction[2];
    if (action === 'refresh') {
      shares.delete(s.token);
      const ns = createShare(s.sessionId, s.user_id);
      const sess = sessions.get(s.sessionId);
      if (sess) sess.shareToken = ns.token;
      return sendJson(res, 200, { ok: true, share: adminShareInfo(ns), note: 'old token is invalid immediately' });
    }
    s.enabled = action === 'enable';
    return sendJson(res, 200, { ok: true, share: adminShareInfo(s) });
  }
  const shareDel = p.match(/^\/api\/admin\/shares\/([^/]+)$/);
  if (req.method === 'DELETE' && shareDel) {
    const s = findShareByRef(decodeURIComponent(shareDel[1]));
    if (!s) return sendJson(res, 404, { ok: false, error: 'share not found' });
    shares.delete(s.token);
    return sendJson(res, 200, { ok: true, revoked: s.id || s.token });
  }
  // ---- Settings ----
  if (req.method === 'GET' && p === '/api/admin/settings') {
    return sendJson(res, 200, { ok: true, settings: { carrot_threshold: CARROT_THRESHOLD, share_ttl_hours: SHARE_TTL_HOURS, name_rule: NAME_RULE, probe_cache_seconds: Math.floor(PROBE_CACHE_MS / 1000) }, sources: SETTINGS_SOURCES, note: 'Precedence at startup: env var > config/settings.json > default. A PUT applies immediately in-memory and writes settings.json; a restart with the env var set reverts that field to the env value.' });
  }
  if (req.method === 'PUT' && p === '/api/admin/settings') {
    const body = await readJsonBody();
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
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
const ADMIN_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>后台管理 · EMOS 订阅网关</title><script>try{var t=localStorage.getItem("emos-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script><style>
:root{--bg:#070b14;--card:rgba(255,255,255,.04);--card-solid:#101728;--border:rgba(255,255,255,.08);--text:#f1f5f9;--muted:#8b98ad;--faint:#5b6b82;--accent:#6366f1;--accent2:#22d3ee;--grad:linear-gradient(135deg,#6366f1,#8b5cf6 48%,#22d3ee);--green:#34d399;--green-bg:rgba(52,211,153,.13);--red:#f87171;--red-bg:rgba(248,113,113,.13);--amber:#fbbf24;--amber-bg:rgba(251,191,36,.12);--radius:20px;--shadow:0 16px 40px rgba(0,0,0,.42)}
html[data-theme="light"]{--bg:#edf1f7;--card:rgba(255,255,255,.86);--card-solid:#ffffff;--border:rgba(15,23,42,.09);--text:#0f172a;--muted:#5f6f88;--faint:#94a3b8;--accent:#4f46e5;--accent2:#0891b2;--green:#059669;--green-bg:rgba(5,150,105,.12);--red:#dc2626;--red-bg:rgba(220,38,38,.08);--amber:#b45309;--amber-bg:rgba(180,83,9,.1);--shadow:0 14px 32px rgba(15,23,42,.10)}
html[data-theme="light"] body{background:linear-gradient(rgba(15,23,42,.028) 1px,transparent 1px),linear-gradient(90deg,rgba(15,23,42,.028) 1px,transparent 1px),radial-gradient(1000px 520px at 10% -10%,rgba(99,102,241,.14),transparent 60%),radial-gradient(820px 500px at 95% -5%,rgba(34,211,238,.10),transparent 55%),linear-gradient(180deg,#f8fafc,#e9eef5);background-size:44px 44px,44px 44px,auto,auto,auto}
html[data-theme="light"] .pill{background:rgba(15,23,42,.05)}
html[data-theme="light"] .pill.accent{color:#4338ca;background:rgba(79,70,229,.1);border-color:rgba(79,70,229,.35)}
html[data-theme="light"] a{color:#1d4ed8}
html[data-theme="light"] input,html[data-theme="light"] textarea{background:rgba(255,255,255,.7)}
html[data-theme="light"] button.ghost{background:rgba(15,23,42,.05)}
html[data-theme="light"] button.ghost:hover{background:rgba(15,23,42,.09)}
html[data-theme="light"] th,html[data-theme="light"] td{border-bottom-color:rgba(15,23,42,.07)}
html[data-theme="light"] tbody tr:hover{background:rgba(15,23,42,.03)}
html[data-theme="light"] code{background:rgba(15,23,42,.07)}
html[data-theme="light"] pre{background:rgba(15,23,42,.05)}
html[data-theme="light"] .bar{background:rgba(15,23,42,.1)}
html[data-theme="light"] .stat{background:rgba(255,255,255,.7)}
html[data-theme="light"] .sub-row{background:rgba(255,255,255,.7)}
html[data-theme="light"] .cmd{background:rgba(15,23,42,.05)}
*{box-sizing:border-box}
body::before{content:"";position:fixed;top:0;left:0;right:0;height:2px;background:var(--grad);z-index:50}
::selection{background:rgba(99,102,241,.35)}
body{margin:0;padding:28px 20px 48px;min-height:100vh;color:var(--text);font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.6;background:linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.022) 1px,transparent 1px),radial-gradient(1000px 520px at 10% -10%,rgba(99,102,241,.32),transparent 60%),radial-gradient(820px 500px at 95% -5%,rgba(34,211,238,.16),transparent 55%),radial-gradient(720px 520px at 50% 115%,rgba(139,92,246,.14),transparent 60%),linear-gradient(180deg,#080c16,#070a12);background-size:44px 44px,44px 44px,auto,auto,auto,auto}
.wrap{max-width:1020px;margin:0 auto}
.topbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:10px}
.brand-mark{width:46px;height:46px;border-radius:14px;background:var(--grad);display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px rgba(255,255,255,.16) inset,0 10px 26px rgba(99,102,241,.5);flex:none}
.brand-mark svg{width:24px;height:24px}
h1{font-size:23px;margin:0;letter-spacing:-.01em;font-weight:800}
.subtitle{color:var(--muted);font-size:13px;margin:2px 0 0}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;letter-spacing:.04em;padding:5px 12px;border-radius:999px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--muted);white-space:nowrap}
.pill.ok{color:var(--green);background:var(--green-bg);border-color:rgba(52,211,153,.35)}
.pill.bad{color:var(--red);background:var(--red-bg);border-color:rgba(248,113,113,.35)}
.pill.warn{color:var(--amber);background:var(--amber-bg);border-color:rgba(251,191,36,.35)}
.pill.accent{color:#c7d2fe;background:rgba(99,102,241,.16);border-color:rgba(99,102,241,.4)}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:22px 24px;margin:18px 0;box-shadow:var(--shadow),inset 0 1px 0 rgba(255,255,255,.06);backdrop-filter:blur(10px)}
.card h2{font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0 0 16px}
.card h2 .count{color:var(--faint);letter-spacing:0;text-transform:none}
.muted{color:var(--muted);font-size:13px}
.bad{color:var(--red)} .ok{color:var(--green)} .warn{color:var(--amber)}
a{color:#93c5fd;text-decoration:none} a:hover{text-decoration:underline}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}
input,textarea{width:100%;background:rgba(255,255,255,.05);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:12px 14px;font:inherit;font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(99,102,241,.18)}
input:disabled{opacity:.55}
textarea{resize:vertical}
button{font:inherit;font-size:14px;font-weight:600;color:#fff;background:var(--grad);border:0;border-radius:12px;padding:11px 20px;cursor:pointer;margin:6px 8px 6px 0;box-shadow:0 6px 18px rgba(99,102,241,.38);transition:transform .12s,box-shadow .12s,opacity .12s}
button:hover{transform:translateY(-1px);box-shadow:0 7px 20px rgba(99,102,241,.45)}
button:focus-visible{outline:2px solid var(--accent2);outline-offset:2px}
button:disabled{opacity:.55;cursor:wait;transform:none}
button.ghost{background:rgba(255,255,255,.07);color:var(--text);box-shadow:none;border:1px solid var(--border)}
button.ghost:hover{background:rgba(255,255,255,.12);box-shadow:none}
button.danger{background:linear-gradient(135deg,#dc2626,#b91c1c);box-shadow:0 4px 14px rgba(220,38,38,.3)}
table{width:100%;border-collapse:collapse;font-size:14px}
thead th{position:sticky;top:0;background:var(--card-solid);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
th,td{text-align:left;padding:13px 14px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top}
tbody tr{transition:background .12s} tbody tr:hover{background:rgba(255,255,255,.03)}
tbody tr:last-child td{border-bottom:0}
td button{padding:6px 11px;font-size:13px;margin:2px 4px 2px 0;box-shadow:none}
.table-scroll{overflow-x:auto;margin:0 -4px;padding:0 4px}
code{word-break:break-all;background:rgba(0,0,0,.4);padding:2px 7px;border-radius:6px;font-size:13px}
pre{background:rgba(0,0,0,.4);border:1px solid var(--border);border-radius:10px;padding:14px;overflow:auto;font-size:13px;line-height:1.5;margin:12px 0}
.hidden{display:none!important}
.row{display:flex;gap:14px;flex-wrap:wrap}.row>div{flex:1;min-width:200px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 4px}
.stat{flex:1;min-width:130px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px 18px}
.stat .k{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.stat .k::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--grad);margin-right:7px;vertical-align:1px}
.stat .v{font-size:26px;font-weight:800;letter-spacing:-.01em;margin-top:4px}
.stat .s{font-size:12px;color:var(--faint);margin-top:2px}
.login-wrap{max-width:440px;margin:48px auto 0}
.login-card{text-align:center;padding:32px 28px}
.lock{width:60px;height:60px;margin:0 auto 16px;border-radius:18px;background:var(--grad);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 22px rgba(99,102,241,.45)}
.lock svg{width:30px;height:30px}
.login-card h2{font-size:18px;letter-spacing:0;text-transform:none;color:var(--text);margin:0 0 6px}
.login-card .muted{margin:0 0 8px}
.login-card input{text-align:center}
.login-card button{width:100%;margin:12px 0 4px;padding:12px}
#adminMsg{min-height:20px;margin:10px 0 0;font-size:13px}
#adminMsg.err{color:var(--red)}
.warn-card{border-color:rgba(251,191,36,.45);background:linear-gradient(180deg,rgba(251,191,36,.09),rgba(251,191,36,.02))}
.warn-card h2{color:var(--amber)}
.cmd{display:flex;align-items:center;gap:10px;background:rgba(0,0,0,.45);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:12px 0;font-size:14px;overflow-x:auto}
.cmd code{background:none;padding:0;white-space:nowrap}
.cmd button{margin:0 0 0 auto;flex:none}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 16px}
.msg{font-size:13px;color:var(--muted);margin:8px 0 0;min-height:18px}
.msg.err{color:var(--red)} .msg.ok{color:var(--green)}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
@media (max-width:640px){body{padding:18px 12px 36px}.card{padding:16px}.form-grid{grid-template-columns:1fr}.stat{min-width:calc(50% - 6px)}.topbar{flex-wrap:nowrap}.topbar h1{font-size:19px}.brand-mark{width:38px;height:38px;border-radius:11px}.topbar .pill{display:none}.topbar #btnTheme{margin-left:auto}}
</style></head><body><div class="wrap">
<div class="topbar"><div class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 3 7v6c0 5 4 8 9 9 5-1 9-4 9-9V7l-9-5z"/><path d="M9 12l2 2 4-4"/></svg></div><div><h1>后台管理</h1><p class="subtitle">EMOS 订阅网关 · 只有站长能进</p></div><span class="pill accent" style="margin-left:auto">站长后台 · {{VERSION}}</span><button type="button" class="ghost" id="btnTheme" style="margin:0 0 0 8px">白天模式</button></div>
<p class="muted">管理节点、分享链接与设置，改动立即生效。</p>

<div class="card warn-card hidden" id="unconfiguredCard"><h2>后台未配置</h2>
<p style="margin:0 0 6px">服务器启动时未设置 <code>ADMIN_TOKEN</code>。</p>
<p class="muted" style="margin:0 0 4px">用以下命令重新启动（替换为你的口令），然后重新打开 /admin：</p>
<div class="cmd"><code>ADMIN_TOKEN=你的口令 node server.js</code><button type="button" class="ghost" id="btnCopyCmd">复制</button></div>
<p class="muted" style="margin:0">也可以用控制脚本：<code>./manage.sh install --admin-token 你的口令</code>。口令不要写进任何文件或聊天记录。</p>
<p><button type="button" id="btnRecheck">重新检查</button></p></div>

<div class="login-wrap hidden" id="loginWrap"><div class="card login-card" id="loginCard">
<div class="lock"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>
<h2>站长登录</h2><p class="muted">输入管理员口令（ADMIN_TOKEN）</p>
<label for="adminToken" style="text-align:left">管理员口令</label>
<input id="adminToken" type="password" placeholder="输入 ADMIN_TOKEN" autocomplete="off">
<button type="button" id="btnAdminLogin">登录</button>
<p id="adminMsg" class="muted"></p></div></div>

<div class="hidden" id="adminApp">
<div class="stats" id="healthChips"></div>
<p><span id="healthLine" class="muted"></span> <button type="button" class="ghost" id="btnLogout">退出登录</button></p>

<div class="card"><div class="section-head"><h2>节点 <span class="count" id="nodeCount"></span></h2><span class="pill" id="probeNote"></span></div>
<div class="table-scroll"><table><thead><tr><th>Key</th><th>名称</th><th>到期</th><th>协议</th><th>服务器</th><th>探针</th><th>操作</th></tr></thead><tbody id="nodeRows"></tbody></table></div>
<h2 id="formTitle" style="margin-top:24px">添加节点</h2>
<label>节点链接（hy2:// / hysteria2:// / vless://）</label>
<textarea id="nodeLink" rows="3" placeholder="hysteria2://密码@域名:端口?sni=域名&obfs=salamander&obfs-password=xxx#名字"></textarea>
<div class="row"><div><label>显示名（可选）</label><input id="nodeName" placeholder="例如 PSM-sb-hy2-opju"></div>
<div><label>地区代码（可选，如 HK / JP / US）</label><input id="nodeRegion" placeholder="JP"></div></div>
<div class="row"><div><label>探针 id（可选）</label><input id="nodeProbe" type="number" placeholder="20"></div>
<div><label>Key（可选，自动生成）</label><input id="nodeKey" placeholder="hy2-jp-xxx"></div></div>
<div class="row"><div><label>到期时间（可选，如 2027-11-14）</label><input id="nodeExpiry" type="date"></div></div>
<button type="button" id="btnParse">解析预览</button> <button type="button" id="btnSaveNode">保存节点</button> <button type="button" class="ghost hidden" id="btnCancelEdit">取消编辑</button>
<pre id="nodePreview" class="hidden"></pre><p id="nodeMsg" class="msg"></p></div>

<div class="card"><h2>分享链接（订阅）</h2>
<p class="muted" style="margin-top:0">用户登录后自动创建，每人一条；Token 仅显示前 6 位。</p>
<div class="table-scroll"><table><thead><tr><th>Token</th><th>用户</th><th>创建 / 到期</th><th>状态</th><th>访问</th><th>最后 IP / 访问</th><th>操作</th></tr></thead><tbody id="shareRows"></tbody></table></div>
<p><button type="button" class="danger" id="btnRevokeAll">全部吊销（所有订阅立即失效）</button></p><p id="shareMsg" class="msg"></p></div>

<div class="card"><h2>设置</h2>
<div class="form-grid">
<div><label>萝卜门槛（默认 500）</label><input id="setThreshold" type="number"></div>
<div><label>分享有效期（小时，0 = 永不过期）</label><input id="setTtl" type="number" step="any"></div>
<div><label>探针缓存（秒）</label><input id="setProbeCache" type="number"></div>
<div><label>节点命名规则</label><input id="setNameRule"></div>
</div>
<p class="muted" id="setSources"></p>
<button type="button" id="btnSaveSettings">保存设置</button> <p id="setMsg" class="msg"></p></div>
</div></div>
<script>
function applyTheme(t){document.documentElement.setAttribute("data-theme",t);var b=document.getElementById("btnTheme");if(b)b.textContent=t==="light"?"夜间模式":"白天模式";try{localStorage.setItem("emos-theme",t)}catch(e){}}
document.getElementById("btnTheme").onclick=function(){applyTheme(document.documentElement.getAttribute("data-theme")==="light"?"dark":"light")};
applyTheme(document.documentElement.getAttribute("data-theme")||"dark");
var nodes=[],editingKey=null,adminSession=null;
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
    h+='<tr><td><code>'+esc(n.key)+'</code></td><td><b>'+esc(n.name)+'</b><br><span class="muted">'+esc(n.region)+'</span></td><td>'+(n.expires_at?esc(n.expires_at):(n.expires_at_probe?esc(n.expires_at_probe)+' <span class="muted">探针</span>':'—'))+'</td><td><span class="pill">'+esc(n.protocol||'—')+'</span></td><td>'+esc(n.server||'—')+':'+(n.server_port==null?'—':n.server_port)+'<br><span class="muted">sni: '+esc(n.sni||'—')+'</span></td><td>'+probe+'</td><td><button type="button" onclick="editNode('+i+')">编辑</button> <button type="button" class="ghost" onclick="moveNode('+i+',-1)">↑</button><button type="button" class="ghost" onclick="moveNode('+i+',1)">↓</button> <button type="button" class="danger" onclick="delNode(\\''+esc(n.key)+'\\')">删除</button></td></tr>';
  });
  document.getElementById('nodeRows').innerHTML=h||'<tr><td colspan="7">暂无节点</td></tr>';
  return true;
}
async function loadShares(){
  var r=await api('GET','/api/admin/shares');
  if(r.status!==200)return;
  var h='';
  r.json.shares.forEach(function(s){
    h+='<tr><td><code>'+esc(s.token_masked)+'</code></td><td><code>'+esc(s.user_id)+'</code></td><td>'+fmtTime(s.created_at)+'<br><span class="muted">到期：'+fmtTime(s.expires_at)+'</span></td><td>'+(s.enabled?'<span class="pill ok">启用</span>':'<span class="pill bad">停用</span>')+'</td><td>'+s.access_count+' 次</td><td>'+esc(s.last_ip||'—')+'<br><span class="muted">'+fmtTime(s.last_access_at)+'</span></td><td><button type="button" onclick="shareAct(\\''+s.id+'\\',\\'refresh\\')">刷新</button> '+(s.enabled?'<button type="button" class="ghost" onclick="shareAct(\\''+s.id+'\\',\\'disable\\')">停用</button>':'<button type="button" class="ghost" onclick="shareAct(\\''+s.id+'\\',\\'enable\\')">启用</button>')+' <button type="button" class="danger" onclick="shareDel(\\''+s.id+'\\')">吊销</button></td></tr>';
  });
  document.getElementById('shareRows').innerHTML=h||'<tr><td colspan="7">暂无分享（还没有用户登录过）</td></tr>';
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
  await loadShares();await loadSettings();await loadHealth();
}
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
initAdmin();
</script></body></html>`;

// --- console HTML (single page, no dependencies) -------------------------
const HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EMOS 订阅控制台</title><script>try{var t=localStorage.getItem("emos-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script><style>
:root{--bg:#070b14;--card:rgba(255,255,255,.04);--card-solid:#101728;--border:rgba(255,255,255,.08);--text:#f1f5f9;--muted:#8b98ad;--faint:#5b6b82;--accent:#6366f1;--accent2:#22d3ee;--grad:linear-gradient(135deg,#6366f1,#8b5cf6 48%,#22d3ee);--green:#34d399;--green-bg:rgba(52,211,153,.13);--red:#f87171;--red-bg:rgba(248,113,113,.13);--amber:#fbbf24;--amber-bg:rgba(251,191,36,.12);--radius:20px;--shadow:0 16px 40px rgba(0,0,0,.42)}
html[data-theme="light"]{--bg:#edf1f7;--card:rgba(255,255,255,.86);--card-solid:#ffffff;--border:rgba(15,23,42,.09);--text:#0f172a;--muted:#5f6f88;--faint:#94a3b8;--accent:#4f46e5;--accent2:#0891b2;--green:#059669;--green-bg:rgba(5,150,105,.12);--red:#dc2626;--red-bg:rgba(220,38,38,.08);--amber:#b45309;--amber-bg:rgba(180,83,9,.1);--shadow:0 14px 32px rgba(15,23,42,.10)}
html[data-theme="light"] body{background:linear-gradient(rgba(15,23,42,.028) 1px,transparent 1px),linear-gradient(90deg,rgba(15,23,42,.028) 1px,transparent 1px),radial-gradient(1000px 520px at 10% -10%,rgba(99,102,241,.14),transparent 60%),radial-gradient(820px 500px at 95% -5%,rgba(34,211,238,.10),transparent 55%),linear-gradient(180deg,#f8fafc,#e9eef5);background-size:44px 44px,44px 44px,auto,auto,auto}
html[data-theme="light"] .pill{background:rgba(15,23,42,.05)}
html[data-theme="light"] .pill.accent{color:#4338ca;background:rgba(79,70,229,.1);border-color:rgba(79,70,229,.35)}
html[data-theme="light"] a{color:#1d4ed8}
html[data-theme="light"] input,html[data-theme="light"] textarea{background:rgba(255,255,255,.7)}
html[data-theme="light"] button.ghost{background:rgba(15,23,42,.05)}
html[data-theme="light"] button.ghost:hover{background:rgba(15,23,42,.09)}
html[data-theme="light"] th,html[data-theme="light"] td{border-bottom-color:rgba(15,23,42,.07)}
html[data-theme="light"] tbody tr:hover{background:rgba(15,23,42,.03)}
html[data-theme="light"] code{background:rgba(15,23,42,.07)}
html[data-theme="light"] pre{background:rgba(15,23,42,.05)}
html[data-theme="light"] .bar{background:rgba(15,23,42,.1)}
html[data-theme="light"] .stat{background:rgba(255,255,255,.7)}
html[data-theme="light"] .sub-row{background:rgba(255,255,255,.7)}
html[data-theme="light"] .cmd{background:rgba(15,23,42,.05)}
*{box-sizing:border-box}
body::before{content:"";position:fixed;top:0;left:0;right:0;height:2px;background:var(--grad);z-index:50}
::selection{background:rgba(99,102,241,.35)}
body{margin:0;padding:28px 20px 48px;min-height:100vh;color:var(--text);font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.6;background:linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.022) 1px,transparent 1px),radial-gradient(1000px 520px at 10% -10%,rgba(99,102,241,.32),transparent 60%),radial-gradient(820px 500px at 95% -5%,rgba(34,211,238,.16),transparent 55%),radial-gradient(720px 520px at 50% 115%,rgba(139,92,246,.14),transparent 60%),linear-gradient(180deg,#080c16,#070a12);background-size:44px 44px,44px 44px,auto,auto,auto,auto}
.wrap{max-width:920px;margin:0 auto}
.topbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:10px}
.brand-mark{width:46px;height:46px;border-radius:14px;background:var(--grad);display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px rgba(255,255,255,.16) inset,0 10px 26px rgba(99,102,241,.5);flex:none}
.brand-mark svg{width:24px;height:24px}
h1{font-size:23px;margin:0;letter-spacing:-.01em;font-weight:800}
.subtitle{color:var(--muted);font-size:13px;margin:2px 0 0}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;letter-spacing:.04em;padding:5px 12px;border-radius:999px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--muted);white-space:nowrap}
.pill.ok{color:var(--green);background:var(--green-bg);border-color:rgba(52,211,153,.35)}
.pill.bad{color:var(--red);background:var(--red-bg);border-color:rgba(248,113,113,.35)}
.pill.warn{color:var(--amber);background:var(--amber-bg);border-color:rgba(251,191,36,.35)}
.pill.accent{color:#c7d2fe;background:rgba(99,102,241,.16);border-color:rgba(99,102,241,.4)}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:22px 24px;margin:18px 0;box-shadow:var(--shadow),inset 0 1px 0 rgba(255,255,255,.06);backdrop-filter:blur(10px)}
.card h2{font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0 0 16px}
.muted{color:var(--muted);font-size:13px}
.bad{color:var(--red)} .ok{color:var(--green)} .warn{color:var(--amber)}
a{color:#93c5fd;text-decoration:none} a:hover{text-decoration:underline}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}
input{width:100%;background:rgba(255,255,255,.05);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:12px 14px;font:inherit;font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(99,102,241,.18)}
button{font:inherit;font-size:14px;font-weight:600;color:#fff;background:var(--grad);border:0;border-radius:12px;padding:11px 20px;cursor:pointer;margin:6px 8px 6px 0;box-shadow:0 6px 18px rgba(99,102,241,.38);transition:transform .12s,box-shadow .12s,opacity .12s}
button:hover{transform:translateY(-1px);box-shadow:0 7px 20px rgba(99,102,241,.45)}
button:focus-visible{outline:2px solid var(--accent2);outline-offset:2px}
button:disabled{opacity:.55;cursor:wait;transform:none}
button.ghost{background:rgba(255,255,255,.07);color:var(--text);box-shadow:none;border:1px solid var(--border)}
button.ghost:hover{background:rgba(255,255,255,.12);box-shadow:none}
button.big{font-size:16px;padding:14px 24px;width:100%;margin:6px 0}
.hero{text-align:center;padding:36px 28px;background:linear-gradient(180deg,rgba(99,102,241,.12),rgba(99,102,241,.02) 70%)}
.hero h2{font-size:18px;letter-spacing:0;text-transform:none;color:var(--text);margin:0 0 6px}
.hero .muted{margin:0 0 14px}
.divider{display:flex;align-items:center;gap:12px;color:var(--faint);font-size:12px;letter-spacing:.08em;margin:18px 0 4px}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--border)}
.fallback{text-align:left;margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:14px}
thead th{position:sticky;top:0;background:var(--card-solid);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
th,td{text-align:left;padding:13px 14px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top}
tbody tr{transition:background .12s} tbody tr:hover{background:rgba(255,255,255,.03)}
tbody tr:last-child td{border-bottom:0}
.table-scroll{overflow-x:auto;margin:0 -4px;padding:0 4px}
.bar{height:6px;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden;margin-top:8px}
.bar i{display:block;height:100%;background:var(--grad);border-radius:99px}
code{word-break:break-all;background:rgba(0,0,0,.4);padding:2px 7px;border-radius:6px;font-size:13px}
.hidden{display:none!important}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:4px 0 14px}
.stat{flex:1;min-width:130px;background:rgba(0,0,0,.30);border:1px solid var(--border);border-radius:16px;padding:16px 18px}
.stat .k{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.stat .k::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--grad);margin-right:7px;vertical-align:1px}
.stat .v{font-size:26px;font-weight:800;letter-spacing:-.01em;margin-top:4px}
.stat .s{font-size:12px;color:var(--faint);margin-top:2px}
.sub-row{display:flex;align-items:center;gap:10px;background:linear-gradient(90deg,rgba(99,102,241,.14),rgba(34,211,238,.07));border:1px solid rgba(99,102,241,.30);border-radius:12px;padding:12px 14px;margin:8px 0}
.sub-row .lbl{flex:none;font-size:13px;color:var(--muted);width:172px}
.sub-row code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:none;padding:0}
.sub-row button{flex:none;margin:0;padding:7px 13px;font-size:13px}
.warn-card{border-color:rgba(251,191,36,.45);background:linear-gradient(180deg,rgba(251,191,36,.09),rgba(251,191,36,.02))}
.warn-card h2{color:var(--amber)}
.big-num{font-size:34px;font-weight:800;line-height:1.1;margin:6px 0}
.actions{display:flex;flex-wrap:wrap;gap:2px;margin-top:12px}
.msg{font-size:13px;color:var(--muted);margin:10px 0 0;min-height:18px}
@media (max-width:640px){body{padding:18px 12px 36px}.card{padding:16px}.stat{min-width:calc(50% - 6px)}.sub-row{flex-wrap:wrap}.sub-row .lbl{width:100%}.sub-row code{white-space:normal}.topbar{flex-wrap:nowrap}.topbar h1{font-size:19px}.brand-mark{width:38px;height:38px;border-radius:11px}.topbar .pill{display:none}.topbar #btnTheme{margin-left:auto}.node-table{overflow:visible;margin:0;padding:0}.node-table thead{display:none}.node-table table,.node-table tbody,.node-table tr,.node-table td{display:block;width:100%}.node-table tr{border:1px solid var(--border);border-radius:14px;padding:4px 14px;margin:12px 0;background:var(--card-solid)}.node-table td{border-bottom:1px solid var(--border);padding:10px 0}.node-table td:last-child{border-bottom:0}.node-table td[data-label]:not([data-label=""])::before{content:attr(data-label);display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:2px}}
</style></head><body><div class="wrap">
<div class="topbar"><div class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg></div><div><h1>EMOS 订阅控制台</h1><p class="subtitle">EMOS 登录 · 萝卜 &gt; 500 解锁订阅</p></div><span class="pill accent" style="margin-left:auto">{{VERSION}}</span><button type="button" class="ghost" id="btnTheme" style="margin:0 0 0 8px">白天模式</button></div>
<p class="muted">萝卜 &gt; 500 才能进入控制台；节点流量为探针整机总流量。</p>

<div class="card hero" id="loginCard"><h2>登录</h2>
<p class="muted">用你的 EMOS 账号登录，核验萝卜后进入控制台</p>
<p><a href="/auth/emos"><button type="button" class="big">用 EMOS 账号登录</button></a></p>
<div class="divider">或使用 Token 登录</div>
<div class="fallback">
<label>EMOS Bearer Token</label><input id="token" type="password" placeholder="粘贴 EMOS token" autocomplete="off">
<button type="button" id="btnToken">用 EMOS Token 登录</button>
</div>
<p id="loginMsg" class="msg"></p></div>

<div class="card warn-card hidden" id="gatedCard"><h2>未达标</h2><div id="gatedMsg"></div><p class="muted">萝卜 &gt; 500 才能看到节点和订阅链接。去 EMOS 签到 / 赚萝卜后再来。</p></div>

<div class="hidden" id="dash">
<div class="stats">
<div class="stat"><div class="k">萝卜</div><div class="v" id="statCarrot">—</div><div class="s">门槛 &gt; 500</div></div>
<div class="stat"><div class="k">节点</div><div class="v" id="statNodes">—</div><div class="s">订阅内容</div></div>
<div class="stat"><div class="k">总流量</div><div class="v" id="statTotalTraffic">—</div><div class="s">本月合计</div></div>
<div class="stat"><div class="k">订阅访问</div><div class="v" id="statAccess">—</div><div class="s">本条链接</div></div>
</div>
<div class="card"><h2>节点 · 总流量</h2><div class="table-scroll node-table"><table><thead><tr><th>节点</th><th>到期</th><th>状态</th><th>今日</th><th>本月已用 / 限额</th></tr></thead><tbody id="nodeRows"></tbody></table></div></div>
<div class="card"><h2>已达标</h2><p>用户：<code id="who"></code> · 萝卜：<b id="carrotOut"></b>（门槛 &gt; 500）</p>
<p class="muted">订阅链接（每人专属，粘贴到客户端即可）：</p>
<div class="sub-row"><span class="lbl">订阅链接</span><code id="subAuto"></code><button type="button" id="btnCopyAuto">复制</button></div>
<p class="muted">一条链接全客户端通用，服务端按客户端自动识别格式（FlClash / Clash Verge 返回 Clash，sing-box / Hiddify / Karing 返回 JSON，Surge 返回 Surge 配置，Shadowrocket、Loon 等返回通用链接列表）。</p>
<p class="muted" id="shareInfo"></p>
<div class="actions"><button type="button" id="btnImport">一键导入</button> <button type="button" class="ghost" id="btnRefresh">刷新流量</button> <button type="button" class="ghost" id="btnRotate">刷新订阅链接（旧链接立即失效）</button> <button type="button" class="ghost" id="btnDisable">停用订阅链接</button> <button type="button" class="ghost" id="btnLogout">退出登录</button></div>
<p class="muted" id="copyMsg"></p></div>
</div>
</div><script>
function applyTheme(t){document.documentElement.setAttribute("data-theme",t);var b=document.getElementById("btnTheme");if(b)b.textContent=t==="light"?"夜间模式":"白天模式";try{localStorage.setItem("emos-theme",t)}catch(e){}}
document.getElementById("btnTheme").onclick=function(){applyTheme(document.documentElement.getAttribute("data-theme")==="light"?"dark":"light")};
applyTheme(document.documentElement.getAttribute("data-theme")||"dark");
var session=null,subUrls=null,importUrl="";
function copyText(t,msg){if(navigator.clipboard){navigator.clipboard.writeText(t).then(function(){document.getElementById("copyMsg").textContent=msg||"已复制。"})}else{document.getElementById("copyMsg").textContent=t}}
function fmtExpiry(v){if(!v)return '—';var d=new Date(v);if(isNaN(d.getTime()))return esc(v);var s=String(v).length>=10?String(v).slice(0,10):d.toISOString().slice(0,10);var days=Math.ceil((d.getTime()-Date.now())/86400000);if(days<0)return s+' <span class="pill bad">已过期</span>';if(days<=14)return s+' <span class="pill bad">剩 '+days+' 天</span>';return s+' <span class="muted">剩 '+days+' 天</span>';}
function fmt(n){if(n==null)return "-";var u=["B","KB","MB","GB","TB"],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return n.toFixed(n>=100?0:1)+" "+u[i]}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/\'/g,"&#39;")}
function showMsg(t){document.getElementById("loginMsg").textContent=t}
function setShareInfo(sh){
  if(!sh)return;
  document.getElementById("shareInfo").textContent="订阅链接：创建于 "+new Date(sh.created_at).toLocaleString()+(sh.expires_at?"，到期 "+new Date(sh.expires_at).toLocaleString():"，永不过期")+"，已访问 "+(sh.access_count||0)+" 次"+(sh.last_access_at?"，上次访问 "+new Date(sh.last_access_at).toLocaleString():"");
  var sa=document.getElementById("statAccess");if(sa)sa.textContent=sh.access_count||0;
}
async function doAuth(body){
  showMsg("核验中…");
  var r;
  try{r=await fetch("/api/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});}
  catch(e){showMsg("登录失败：网络错误，"+e.message);return;}
  var j=await r.json();
  if(!j.ok){
    if(j.reason==="carrot<=500"){
      document.getElementById("gatedCard").classList.remove("hidden");
      document.getElementById("dash").classList.add("hidden");
      document.getElementById("gatedMsg").innerHTML="萝卜：<b>"+j.carrot+"</b><div class=\\"big-num bad\\">还差 "+j.shortfall+"</div>才到 501（&gt; 500）。";
      showMsg("未达标：萝卜 "+j.carrot+"，还差 "+j.shortfall+"。");
    }else{showMsg("登录失败：" + (j.error||"未知错误"))}
    return;
  }
  session=j.session;subUrls=j.sub_urls||{singbox:j.sub_url,clash:j.sub_url,links:j.sub_url};importUrl=j.import_url;
  document.getElementById("gatedCard").classList.add("hidden");
  document.getElementById("dash").classList.remove("hidden");
  document.getElementById("loginCard").classList.add("hidden");
  document.getElementById("who").textContent=j.user_id+(j.username?" ("+j.username+")":"");
  document.getElementById("carrotOut").textContent=j.carrot;
  document.getElementById("statCarrot").textContent=j.carrot;
  document.getElementById("subAuto").textContent=subUrls.c_url||subUrls.url;
  setShareInfo(j.share);
  showMsg("已登录，萝卜 "+j.carrot+"。");
  loadNodes();
}
async function loadNodes(){
  var r;
  try{r=await fetch("/api/nodes",{credentials:"include",headers:session?{"X-Session":session}:{}});}
  catch(e){showMsg("拉取节点失败：网络错误，"+e.message);return;}
  var j=await r.json();
  if(!j.ok){showMsg("拉取节点失败：" + (j.error||""));return}
  document.getElementById("statNodes").textContent=j.nodes.length;
  var anyTraffic=j.nodes.some(function(n){return typeof n.month_used==="number";});
  var totalMonth=j.nodes.reduce(function(s,n){return s+(typeof n.month_used==="number"?n.month_used:0);},0);
  document.getElementById("statTotalTraffic").textContent=anyTraffic?fmt(totalMonth):"—";
  var html="";
  j.nodes.forEach(function(n){
    var pct=n.pct_used==null?"—":n.pct_used+"%";
    var bar=n.pct_used==null?"":"<div class=\\"bar\\"><i style=\\"width:"+Math.min(100,n.pct_used)+"\\"></i></div>";
    var pill=n.online===true?'<span class="pill ok">在线</span>':n.online===false?'<span class="pill bad">离线</span>':'<span class="pill">未知 · 不在探针里</span>';
    html+="<tr><td data-label=\\"\\"><b>"+esc(n.name)+"</b></td><td data-label=\\"到期\\">"+fmtExpiry(n.expires_at)+"</td><td data-label=\\"状态\\">"+pill+"</td><td data-label=\\"今日\\">"+fmt(n.day_used)+"</td><td data-label=\\"本月已用 / 限额\\">"+fmt(n.month_used)+" / "+(n.traffic_limit?fmt(n.traffic_limit):"不限")+"<br><span class=\\"muted\\">已用 "+pct+" · 剩余 "+(n.remaining==null?"—":fmt(n.remaining))+"</span>"+bar+"</td></tr>";
  });
  document.getElementById("nodeRows").innerHTML=html||"<tr><td colspan=\\"5\\">暂无节点</td></tr>";
}
document.getElementById("btnToken").onclick=function(){var t=document.getElementById("token").value.trim();if(!t){showMsg("先粘贴 EMOS token");return}doAuth({token:t})};
document.getElementById("btnCopyAuto").onclick=function(){if(subUrls)copyText(subUrls.c_url||subUrls.url,"已复制订阅链接。")};
document.getElementById("btnRotate").onclick=async function(){var r=await fetch("/api/sub/refresh",{method:"POST",credentials:"include",headers:session?{"X-Session":session}:{}});var j=await r.json();if(!j.ok){showMsg("刷新失败：" + (j.error||""));return}subUrls=j.sub_urls;importUrl=j.import_url;document.getElementById("subAuto").textContent=subUrls.c_url||subUrls.url;setShareInfo(j.share);document.getElementById("copyMsg").textContent="已生成新订阅链接，旧链接立即失效，请重新导入。"};
document.getElementById("btnDisable").onclick=async function(){if(!confirm("停用后订阅链接立即失效，重新登录才能恢复，确定？"))return;var r=await fetch("/api/sub/disable",{method:"POST",credentials:"include",headers:session?{"X-Session":session}:{}});var j=await r.json();if(j.ok){setShareInfo(j.share);document.getElementById("copyMsg").textContent="订阅链接已停用。"}};
document.getElementById("btnImport").onclick=function(){if(importUrl)window.location.href=importUrl};
document.getElementById("btnRefresh").onclick=function(){loadNodes()};
document.getElementById("btnLogout").onclick=async function(){try{await fetch("/api/logout",{method:"POST",credentials:"include",headers:session?{"X-Session":session}:{}});}catch(e){}session=null;subUrls=null;importUrl="";document.getElementById("dash").classList.add("hidden");document.getElementById("gatedCard").classList.add("hidden");document.getElementById("loginCard").classList.remove("hidden");showMsg("已退出登录。")};
(function(){var q=new URLSearchParams(location.search);var e=q.get("emos_error");if(!e)return;var c=q.get("carrot");var m={no_token:"EMOS 回跳里没有带 token，请重新点“用 EMOS 账号登录”再试一次。",bad_state:"登录状态不对（uuid 不匹配或已过期），请重新点“用 EMOS 账号登录”。",not_signed_in:"EMOS 未确认这次登录（sign/check 未通过：可能是 token 无效，或今天还没在 EMOS 签到），请在 EMOS 登录/签到后再试。",carrot_insufficient:"萝卜不够：当前 "+(c||"?")+"，还差 "+(c?Math.max(0,501-c):"?")+" 才到 501（> 500）。"};showMsg(m[e]||("登录失败："+e));history.replaceState(null,"",location.pathname);})();
async function tryResume(){
  try{
    var r=await fetch("/api/nodes",{credentials:"include"});
    if(!r.ok)return;
    var j=await r.json();
    if(!j.ok)return;
    var r2=await fetch("/api/sub-link",{credentials:"include"});
    var j2=await r2.json();
    if(!j2.ok)return;
    subUrls=j2.sub_urls||{singbox:j2.sub_url,clash:j2.sub_url,links:j2.sub_url};
    importUrl=j2.import_url;
    document.getElementById("gatedCard").classList.add("hidden");
    document.getElementById("dash").classList.remove("hidden");
    document.getElementById("loginCard").classList.add("hidden");
    document.getElementById("who").textContent=j.user_id;
    document.getElementById("carrotOut").textContent=j.carrot;
    document.getElementById("statCarrot").textContent=j.carrot;
    document.getElementById("subAuto").textContent=subUrls.c_url||subUrls.url;
    setShareInfo(j2.share);
    showMsg("已登录，萝卜 "+j.carrot+"。");
    loadNodes();
  }catch(e){}
}
tryResume();
setInterval(function(){if(!document.getElementById("dash").classList.contains("hidden"))loadNodes()},30000);
</script></body></html>`;
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders() });
      return res.end(HTML.split('{{VERSION}}').join(VERSION));
    }
    if (req.method === 'GET' && u.pathname === '/health') return sendJson(res, 200, { ok: true, version: VERSION, nodes: NODES.length });
    if (req.method === 'GET' && u.pathname === '/admin') return handleAdminPage(req, res);
    if (req.method === 'POST' && u.pathname === '/api/admin/login') return await handleAdminLogin(req, res);
    if (req.method === 'POST' && u.pathname === '/api/admin/logout') return await handleAdminLogout(req, res);
    if (u.pathname.startsWith('/api/admin/')) return await handleAdminApi(req, res);
    if (req.method === 'POST' && u.pathname === '/api/auth') return await handleAuth(req, res);
    if (req.method === 'GET' && u.pathname === '/auth/emos') return handleEmosLogin(req, res);
    if (req.method === 'GET' && u.pathname === '/auth/emos/callback') return await handleEmosCallback(req, res);
    if (req.method === 'GET' && u.pathname === '/api/auth/emos/login-url') return handleEmosLoginUrl(req, res);
    if (req.method === 'GET' && u.pathname === '/api/nodes') return await handleNodes(req, res);
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
      const token = decodeURIComponent(u.pathname.slice(5));
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
  server.listen(PORT, () => {
    console.log('emos-sub v' + VERSION + ' listening on http://127.0.0.1:' + PORT);
    console.log('nodes loaded: ' + NODES.map((n) => n.key + '->probe#' + n.probe_node_id).join(', '));
  });
}
// Pure helpers exported for test/check-pages.js unit tests (no server started).
module.exports = { server, monthEndExpireMs, normalizeExpiry, validateProbeId, parseHy2, parseVless, VERSION };

