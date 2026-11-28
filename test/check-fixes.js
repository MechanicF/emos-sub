// v1.5.5 security regression. Boots the real server against mock EMOS/probe
// services, so every fix below is verified end-to-end, not just by reading code.
// Run: node test/check-fixes.js   (no network access required)
const http = require('http');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');

let signMode = 'ok';      // 'ok' | 'fail' -> /api/sign/check
let carrotMode = 'ok';    // 'ok' | 'down' -> /api/carrot/current
const mockEmos = http.createServer((req, res) => {
  const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (req.url.startsWith('/api/sign/check')) {
    if (signMode === 'fail') { res.writeHead(503); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ is_sign: true, user_id: 'user-' + tok }));
  }
  if (req.url.startsWith('/api/carrot/current')) {
    if (carrotMode === 'down') { res.writeHead(500); return res.end('{}'); }
    if (carrotMode === 'unauth') { res.writeHead(401); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ carrot: 999 }));
  }
  res.writeHead(404); res.end();
});
const mockProbe = http.createServer((_req, res) => { res.writeHead(500); res.end('down'); });

function req(port, method, p, headers, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(headers || {}) },
    }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    r.on('error', (e) => resolve({ status: 0, body: '', error: e.code || e.message }));
    if (data) r.end(data); else r.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body); } catch (e) { return {}; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond, extra) => { if (cond) { console.log('OK   ' + name); pass += 1; } else { console.error('FAIL ' + name + (extra ? ' — ' + extra : '')); fail += 1; } };

(async () => {
  await new Promise((r) => mockEmos.listen(0, '127.0.0.1', r));
  await new Promise((r) => mockProbe.listen(0, '127.0.0.1', r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emos-fixes-'));
  process.env.ADMIN_TOKEN = 'test-token';
  process.env.DEMO_ENABLED = '';
  process.env.EMOS_BASE = 'http://127.0.0.1:' + mockEmos.address().port;
  process.env.PROBE_URL = 'http://127.0.0.1:' + mockProbe.address().port + '/api/nodes';
  process.env.EMOS_STATE_FILE = path.join(tmp, 'state.json');
  process.env.CARROT_RECHECK_MS = '1000';
  process.env.SHARE_TTL_HOURS = '0'; // v1.5.13 default: shares never expire
  process.env.CARROT_GRACE_MS = '1500';
  process.env.PROBE_FAIL_CACHE_MS = '1000';
  const lib = require(path.join(__dirname, '..', 'server.js'));
  await new Promise((r) => lib.server.listen(0, '127.0.0.1', r));
  const port = lib.server.address().port;
  const ADMIN = { 'X-Admin-Token': 'test-token' };
  const login = (tok) => req(port, 'POST', '/api/auth', {}, { token: tok }).then(json);
  const sub = (tok, headers) => req(port, 'GET', '/sub/' + tok, { 'User-Agent': 'clash', ...(headers || {}) });

  // 1. identity is mandatory: a failed sign/check must not create an 'unknown' user
  signMode = 'fail';
  const rejected = await login('IDENT-FAIL');
  check('sign/check failure rejects login (no shared unknown user)', !rejected.ok && rejected.user_id !== 'unknown',
    'status/body=' + JSON.stringify(rejected).slice(0, 120));
  signMode = 'ok';

  // 2. distinct EMOS users keep distinct links
  const a = await login('AAA'), b = await login('BBB');
  check('two logins get distinct user_id', a.ok && b.ok && a.user_id !== b.user_id, a.user_id + ' / ' + b.user_id);
  check('user A subscription survives user B login', (await sub(a.sub_token)).status === 200);

  // 3. admin revoke-all cannot be undone by a self-service refresh
  const revoked = json(await req(port, 'POST', '/api/admin/shares/revoke-all', ADMIN, {}));
  check('revoke-all reports revoked shares', revoked.ok === true && revoked.revoked >= 1);
  check('old link is 403 after revoke-all', (await sub(a.sub_token)).status === 403);
  const ra = await req(port, 'POST', '/api/sub/refresh', { 'X-Session': a.session }, {});
  check('user refresh after revoke-all is 403', ra.status === 403, 'got ' + ra.status);
  const rb = await req(port, 'POST', '/api/sub/refresh', { 'X-Session': b.session }, {});
  check('every revoked user must re-authenticate', rb.status === 403, 'got ' + rb.status);

  // 4. user-initiated disable also requires a fresh login
  const c = await login('CCC');
  const dis = json(await req(port, 'POST', '/api/sub/disable', { 'X-Session': c.session }, {}));
  check('disable succeeds', dis.ok === true);
  const rc = await req(port, 'POST', '/api/sub/refresh', { 'X-Session': c.session }, {});
  check('refresh after disable is 403', rc.status === 403, 'got ' + rc.status);

  // 5. an explicit admin enable restores the link again
  const d = await login('DDD');
  const shares = json(await req(port, 'GET', '/api/admin/shares', ADMIN));
  const one = (shares.shares || []).find((s) => s.user_id === d.user_id);
  if (one) await req(port, 'POST', '/api/admin/shares/' + one.id + '/disable', ADMIN, {});
  const rd = await req(port, 'POST', '/api/sub/refresh', { 'X-Session': d.session }, {});
  check('admin disable cannot be undone by user refresh', rd.status === 403, 'got ' + rd.status);
  if (one) await req(port, 'POST', '/api/admin/shares/' + one.id + '/enable', ADMIN, {});
  const link = await req(port, 'GET', '/api/sub-link', { 'X-Session': d.session });
  check('admin enable restores a usable sub-link', link.status === 200, 'got ' + link.status);

  // 6. oversized body: 413 JSON instead of a destroyed socket
  const big = await req(port, 'POST', '/api/auth', {}, JSON.stringify({ token: 'x'.repeat(70000) }));
  check('70KB body returns 413 JSON (no ECONNRESET)', big.status === 413 && /too large/.test(big.body), 'got ' + big.status);

  // 7/8. X-Forwarded-Proto allow-list + security headers on subscription bodies
  const e = await login('EEE');
  const chooser = await req(port, 'GET', '/c/?token=' + e.sub_token, {
    'User-Agent': 'Mozilla/5.0 Chrome/120', 'X-Forwarded-Proto': 'javascript:alert(1)//',
  });
  const href = (/href="([^"]+)"/.exec(chooser.body || '') || [])[1] || '';
  check('crafted X-Forwarded-Proto cannot inject a javascript: URL', href.startsWith('http://') && !href.includes('javascript:'), href.slice(0, 90));
  const clash = await sub(e.sub_token);
  check('subscription responses carry nosniff', clash.headers['x-content-type-options'] === 'nosniff');

  // 9. literal '%' must not silently drop a node
  check('unencoded % in hy2 password does not drop the node',
    lib.parseHy2('hysteria2://abc%def@host.example:443?sni=x.example#t') !== null);
  check('unencoded % in fragment does not drop the node',
    lib.parseHy2('hysteria2://pass@host.example:443?sni=x.example#100%done') !== null);

  // 10. probe traffic for one physical machine is counted once.
  // Resolve keys dynamically so this also passes on a fresh clone where
  // nodes.json was seeded from nodes.example.json.
  const nl = json(await req(port, 'GET', '/api/admin/nodes', ADMIN));
  const list = nl.nodes || [];
  const firstProbe = (list[0] && list[0].probe_node_id) || 2;
  const secondKey = list[1] && list[1].key;
  const totalOf = async () => {
    const h = (await sub(e.sub_token)).headers['subscription-userinfo'] || '';
    return Number((/total=(\d+)/.exec(h) || [])[1] || 0);
  };
  const otherProbe = firstProbe === 22 ? 20 : 22;
  if (secondKey) await req(port, 'PUT', '/api/admin/nodes/' + encodeURIComponent(secondKey), ADMIN, { probe_node_id: otherProbe });
  const beforeDedupe = await totalOf();
  if (secondKey) await req(port, 'PUT', '/api/admin/nodes/' + encodeURIComponent(secondKey), ADMIN, { probe_node_id: firstProbe });
  const afterDedupe = await totalOf();
  check('probe traffic is deduplicated by probe id',
    !!secondKey && beforeDedupe > 0 && afterDedupe > 0 && afterDedupe < beforeDedupe,
    'before=' + beforeDedupe + ' after=' + afterDedupe);

  // 11. a second probe failure stays labelled sample-fallback
  const h1 = json(await req(port, 'GET', '/api/admin/health', ADMIN));
  await sleep(1150);
  const h2 = json(await req(port, 'GET', '/api/admin/health', ADMIN));
  check('repeated probe failures stay sample-fallback (never stale-live)',
    h1.probe_source === 'sample-fallback' && h2.probe_source === 'sample-fallback',
    h1.probe_source + ' -> ' + h2.probe_source);

  // 12. EMOS outage has a hard grace cap
  const f = await login('FFF');
  carrotMode = 'down';
  await sleep(1600);
  const outage = await sub(f.sub_token);
  check('EMOS outage beyond CARROT_GRACE_MS revokes the link', outage.status === 403, 'got ' + outage.status);
  carrotMode = 'ok';

  // 13. admin page no longer interpolates data into onclick handlers
  const adminPage = await req(port, 'GET', '/admin', {});
  check('admin tables use data-act event delegation',
    !/onclick="(?:editNode|delNode|shareAct|shareDel)/.test(adminPage.body) && /data-act="edit"/.test(adminPage.body));

  // 14. reverse proxy: the real client IP must reach the share access log
  const g = await login('GGG');
  const sharesOf = async (uid) => {
    const r = json(await req(port, 'GET', '/api/admin/shares', ADMIN));
    return (r.shares || []).find((s) => s.user_id === uid);
  };
  await sub(g.sub_token, { 'X-Forwarded-For': '203.0.113.77' });
  check('XFF from a local reverse proxy is stored as last_ip',
    (await sharesOf(g.user_id) || {}).last_ip === '203.0.113.77');
  await sub(g.sub_token, { 'X-Real-IP': '203.0.113.88' });
  check('X-Real-IP alone is stored as last_ip',
    (await sharesOf(g.user_id) || {}).last_ip === '203.0.113.88');
  await sub(g.sub_token, { 'X-Forwarded-For': '1.1.1.1, 203.0.113.99' });
  check('forged XFF cannot spoof last_ip',
    (await sharesOf(g.user_id) || {}).last_ip === '203.0.113.99');
  check('ip-check requires admin auth', (await req(port, 'GET', '/api/admin/ip-check', {})).status === 401);
  const diag = json(await req(port, 'GET', '/api/admin/ip-check', { ...ADMIN, 'X-Real-IP': '203.0.113.42' }));
  check('ip-check reports the resolved client IP',
    diag.ok === true && diag.resolved === '203.0.113.42' && diag.source === 'x-real-ip',
    JSON.stringify(diag).slice(0, 160));

  // 15. v1.5.13: the subscription link survives the login session.
  // (2026-11-27 bug: the same link worked in client A, then every other
  // client got 403 — the 24 h share TTL, the 24 h session TTL and the
  // EMOS-token-death revoke all killed the link, and re-login minted a
  // new token.)
  const hh = await login('HHH');
  check('new share never expires by default (share_ttl_hours=0)',
    (await sharesOf(hh.user_id) || {}).expires_at === null);
  // logout ends the console session only; the link keeps working
  const loo = await req(port, 'POST', '/api/logout', { 'X-Session': hh.session }, {});
  check('logout succeeds', loo.status === 200, 'got ' + loo.status);
  check('link survives logout (no live session needed)',
    (await sub(hh.sub_token)).status === 200);
  // re-login reuses the same link instead of minting a new one
  const hh2 = await login('HHH');
  check('re-login keeps the same subscription token', hh2.ok && hh2.sub_token === hh.sub_token,
    'old=' + (hh.sub_token || '').slice(0, 8) + ' new=' + (hh2.sub_token || '').slice(0, 8));
  check('same link still serves after re-login', (await sub(hh2.sub_token)).status === 200);
  // a dead EMOS token (401) is grace, not an instant revoke
  carrotMode = 'unauth';
  await sleep(1200); // past CARROT_RECHECK_MS (1000)
  check('EMOS 401 is grace, not a revoke (link still serves)',
    (await sub(hh2.sub_token)).status === 200);
  await sleep(700); // past CARROT_GRACE_MS (1500) since login
  check('link dies only after the grace window runs out',
    (await sub(hh2.sub_token)).status === 403);
  carrotMode = 'ok';
  // a fresh login re-enables the same link (system-disabled shares revive)
  const hh3 = await login('HHH');
  check('re-login re-enables the same link after grace expiry',
    hh3.ok && hh3.sub_token === hh.sub_token, 'got ' + (hh3.sub_token || '').slice(0, 8));
  check('re-enabled link serves again', (await sub(hh3.sub_token)).status === 200);
  // a user-disabled link stays dead across re-login (it may have leaked)
  const ii = await login('III');
  await req(port, 'POST', '/api/sub/disable', { 'X-Session': ii.session }, {});
  const ii2 = await login('III');
  check('re-login after user disable mints a fresh token',
    ii2.ok && ii2.sub_token !== ii.sub_token);
  check('user-disabled link stays 403 after re-login',
    (await sub(ii.sub_token)).status === 403);
  check('fresh link after user disable serves',
    (await sub(ii2.sub_token)).status === 200);

  // 16. v1.5.14 (H1): an expired console session must not delete the share.
  // Regression: getSession() used to call shares.delete(s.shareToken) on
  // session expiry, silently revoking every client of that user as soon as
  // they opened the console again — the exact opposite of v1.5.13's promise.
  // SESSION_TTL_MS is env-driven; to exercise expiry in the same process we
  // start a second server on another port with a 1.2 s session TTL.
  const SESSION_PORT = 3199;
  const sessState = path.join(tmp, 'session-expiry-state.json');
  // CARROT_GRACE_MS must be reset to the production default: this suite sets
  // it to 1500 ms for its own short timeout tests, and inheriting that here
  // would expire the demo share during the 1.6 s wait (a false H1 failure).
  const sessEnv = { ...process.env, PORT: String(SESSION_PORT), SESSION_TTL_MS: '1200',
    SHARE_TTL_HOURS: '0', CARROT_GRACE_MS: '86400000',
    EMOS_STATE_FILE: sessState, DEMO_ENABLED: '1' };
  const { spawn } = require('child_process');
  const sessSrv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')],
    { cwd: path.join(__dirname, '..'), env: sessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  sessSrv.stderr.on('data', () => {});
  for (let i = 0; i < 60; i++) {
    const h = await req(SESSION_PORT, 'GET', '/health', {});
    if (h.status === 200) break;
    await sleep(100);
  }
  const sj = json(await req(SESSION_PORT, 'POST', '/api/auth', {}, { carrot: 600 }));
  check('H1 setup: demo login succeeds', sj.ok === true && !!sj.sub_token,
    JSON.stringify(sj).slice(0, 120));
  check('H1 setup: link works before session expiry',
    (await req(SESSION_PORT, 'GET', '/c/?token=' + encodeURIComponent(sj.sub_token), { 'User-Agent': 'sing-box/1.12.0' })).status === 200);
  await sleep(1600); // past SESSION_TTL_MS (1200)
  // Touch a getSession() endpoint with the now-expired session — this is the
  // exact path that used to delete the share.
  const expiredNodes = await req(SESSION_PORT, 'GET', '/api/nodes', { 'X-Session': sj.session });
  check('H1: expired session is rejected', expiredNodes.status === 401, 'got ' + expiredNodes.status);
  const afterExpiry = await req(SESSION_PORT, 'GET', '/c/?token=' + encodeURIComponent(sj.sub_token), { 'User-Agent': 'sing-box/1.12.0' });
  check('H1: subscription survives session expiry + console touch', afterExpiry.status === 200,
    'got ' + afterExpiry.status + ' ' + afterExpiry.body.slice(0, 100));
  sessSrv.kill('SIGTERM');

  // 17. v1.5.14 (H2): when SHARE_TTL_HOURS > 0, re-login after the share
  // expires must issue a *usable* link. Regression: issueUserSession()
  // reused the expired share but never refreshed expires_at → permanent 403.
  const TTL_PORT = 3201;
  const ttlState = path.join(tmp, 'share-ttl-state.json');
  const ttlEnv = { ...process.env, PORT: String(TTL_PORT), SESSION_TTL_MS: '600000',
    SHARE_TTL_HOURS: '0.001', EMOS_STATE_FILE: ttlState, DEMO_ENABLED: '1' };
  const ttlSrv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')],
    { cwd: path.join(__dirname, '..'), env: ttlEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  ttlSrv.stderr.on('data', () => {});
  for (let i = 0; i < 60; i++) {
    const h = await req(TTL_PORT, 'GET', '/health', {});
    if (h.status === 200) break;
    await sleep(100);
  }
  const tj = json(await req(TTL_PORT, 'POST', '/api/auth', {}, { carrot: 600 }));
  check('H2 setup: short-TTL login succeeds', tj.ok === true && !!tj.sub_token,
    JSON.stringify(tj).slice(0, 120));
  check('H2 setup: link works before TTL',
    (await req(TTL_PORT, 'GET', '/c/?token=' + encodeURIComponent(tj.sub_token), { 'User-Agent': 'sing-box/1.12.0' })).status === 200);
  await sleep(4200); // past 0.001 h = 3.6 s share TTL
  check('H2 setup: link expires after TTL',
    (await req(TTL_PORT, 'GET', '/c/?token=' + encodeURIComponent(tj.sub_token), { 'User-Agent': 'sing-box/1.12.0' })).status === 403);
  const tj2 = json(await req(TTL_PORT, 'POST', '/api/auth', {}, { carrot: 600 }));
  check('H2: re-login after TTL succeeds', tj2.ok === true, JSON.stringify(tj2).slice(0, 120));
  check('H2: re-login refreshes expires_at (same token, new expiry)',
    tj2.sub_token === tj.sub_token && tj2.share && tj2.share.expires_at > Date.now(),
    'old=' + (tj.share || {}).expires_at + ' new=' + (tj2.share || {}).expires_at);
  check('H2: re-issued link is usable',
    (await req(TTL_PORT, 'GET', '/c/?token=' + encodeURIComponent(tj2.sub_token), { 'User-Agent': 'sing-box/1.12.0' })).status === 200);
  ttlSrv.kill('SIGTERM');

  // 18. v1.5.15: unlock subsystem — pure helpers + endpoint auth.
  const unlockLib = require(path.join(__dirname, '..', 'unlock.js'));
  const hy2Link = 'hy2://user%3Apass@example.com:443?sni=example.com&obfs=salamander&obfs-password=secret#n';
  const vlessLink = 'vless://11111111-2222-3333-4444-555555555555@example.com:443?security=reality&pbk=abc&sni=example.com&fp=chrome#v';
  const hy2Proxy = unlockLib.linkToProxy(hy2Link, 'k1');
  check('unlock: hy2 link -> mihomo proxy', !!hy2Proxy && hy2Proxy.type === 'hysteria2' && hy2Proxy.password === 'user:pass');
  const vlessProxy = unlockLib.linkToProxy(vlessLink, 'k2');
  check('unlock: vless reality -> mihomo proxy', !!vlessProxy && vlessProxy.type === 'vless' && !!vlessProxy['reality-opts']);
  check('unlock: unsupported link rejected', unlockLib.linkToProxy('ss://xxx', 'k3') === null);
  const mcfg = unlockLib.buildMihomoConfig([hy2Proxy], 7890, 9090);
  check('unlock: mihomo config has mixed-port + proxy group + rule',
    /mixed-port: 7890/.test(mcfg) && /name: PROXY/.test(mcfg) && /MATCH,PROXY/.test(mcfg));
  check('unlock: config quotes dangerous values (no YAML injection)',
    /password: "user:pass"/.test(mcfg));
  // 7 providers registered
  check('unlock: all 7 providers registered', unlockLib.PROVIDERS.length === 7 &&
    ['netflix', 'disney', 'youtube_premium', 'openai', 'gemini', 'claude', 'bahamut'].every((p) => unlockLib.PROVIDERS.includes(p)));
  // Endpoint requires login
  const unlockAnon = await req(port, 'GET', '/api/unlock', {});
  check('unlock: /api/unlock requires login', unlockAnon.status === 401, 'got ' + unlockAnon.status);
  const unlockUser = await login('UNLOCKUSER');
  const unlockAuthed = json(await req(port, 'GET', '/api/unlock', { 'X-Session': unlockUser.session }));
  check('unlock: /api/unlock returns provider list', unlockAuthed.ok === true &&
    Array.isArray(unlockAuthed.providers) && unlockAuthed.providers.length === 7);

  // 19. v1.5.15 (NEP): probeRequest CONNECT tunnel end-to-end via a mock proxy.
  // The suite's section 18 only covers link parsing/config/auth; the tunnel
  // itself (the riskiest new transport code) had no automated test.
  const targetSrv = http.createServer((_rq, rs) => { rs.writeHead(200, { 'Content-Type': 'text/html' }); rs.end('<html>ad-free premium INNERTUBE_CONTEXT_GL":"US"</html>'); });
  await new Promise((r) => targetSrv.listen(0, '127.0.0.1', r));
  const mockProxy = http.createServer();
  mockProxy.on('connect', (rq, sock) => {
    const [h, pt] = String(rq.url || '').split(':');
    const up = net.connect(Number(pt), h, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); sock.pipe(up); up.pipe(sock); });
    up.on('error', () => { try { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} });
  });
  await new Promise((r) => mockProxy.listen(0, '127.0.0.1', r));
  const tp = targetSrv.address().port, pp = mockProxy.address().port;
  const tun = await unlockLib.probeRequest(pp, 'http://127.0.0.1:' + tp + '/premium', { bodyLimit: 1024 * 1024 });
  check('unlock: CONNECT tunnel returns 200 + markers', tun.status === 200 && /ad-free/.test(tun.body) && /"US"/.test(tun.rawBody || ''));
  const dead = await unlockLib.probeRequest(1, 'http://127.0.0.1:' + tp + '/', {});
  check('unlock: dead proxy returns clean error', !!dead.error && dead.status === 0);
  targetSrv.close(); mockProxy.close();

  // 20. admin controls: the toggle + immediate scan are admin-only (v1.5.18).
  // A console session may still READ the state (it renders the unlock column)
  // but must not flip the switch or trigger a scan.
  const CTRL_PORT = 3232;
  const ctrlState = path.join(tmp, 'ctrl-state.json');
  const ctrlUnlock = path.join(tmp, 'ctrl-unlock.json');
  const ctrlEnv = { ...process.env, PORT: String(CTRL_PORT), DEMO_ENABLED: '1',
    UNLOCK_ENABLED: '1', ADMIN_TOKEN: 'test-token',
    EMOS_STATE_FILE: ctrlState, EMOS_UNLOCK_FILE: ctrlUnlock };
  const ctrlSrv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')],
    { cwd: path.join(__dirname, '..'), env: ctrlEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  ctrlSrv.stderr.on('data', () => {});
  for (let i = 0; i < 60; i++) {
    const h = await req(CTRL_PORT, 'GET', '/health', {});
    if (h.status === 200) break;
    await sleep(100);
  }
  const cl = json(await req(CTRL_PORT, 'POST', '/api/auth', {}, { carrot: 600 }));
  const CH = { 'X-Session': cl.session, 'Content-Type': 'application/json' };
  const AH = { 'X-Admin-Token': 'test-token', 'Content-Type': 'application/json' };
  const cst0 = json(await req(CTRL_PORT, 'GET', '/api/unlock', CH));
  check('unlock control: console can still read state', cst0.available === true && cst0.enabled === true);
  check('unlock progress: state includes progress field', 'progress' in cst0);
  const cAnonGet = await req(CTRL_PORT, 'GET', '/api/unlock', {});
  check('unlock control: state read requires login', cAnonGet.status === 401, 'got ' + cAnonGet.status);
  const cTogConsole = await req(CTRL_PORT, 'POST', '/api/unlock/toggle', CH, { enabled: false });
  check('unlock control: console toggle is rejected (admin only)', cTogConsole.status === 401, 'got ' + cTogConsole.status);
  const cRunConsole = await req(CTRL_PORT, 'POST', '/api/unlock/run', CH, {});
  check('unlock control: console run is rejected (admin only)', cRunConsole.status === 401, 'got ' + cRunConsole.status);
  const coff = json(await req(CTRL_PORT, 'POST', '/api/unlock/toggle', AH, { enabled: false }));
  check('unlock control: admin toggle off succeeds', coff.ok === true && coff.enabled === false);
  const cst1 = json(await req(CTRL_PORT, 'GET', '/api/unlock', CH));
  check('unlock control: disabled state persists', cst1.enabled === false);
  const crawOff = await req(CTRL_PORT, 'POST', '/api/unlock/run', AH, {});
  check('unlock control: immediate scan rejected while off', crawOff.status === 400, 'got ' + crawOff.status);
  json(await req(CTRL_PORT, 'POST', '/api/unlock/toggle', AH, { enabled: true }));
  const craw = await req(CTRL_PORT, 'POST', '/api/unlock/run', AH, {});
  // No mihomo binary in test env -> must be a clean 400 with a clear reason.
  check('unlock control: immediate scan reports missing mihomo clearly', craw.status === 400 &&
    /mihomo/.test(json(craw).error || ''), 'got ' + craw.status + ' ' + craw.body.slice(0, 80));
  const cstAdmin = json(await req(CTRL_PORT, 'GET', '/api/unlock', AH));
  check('unlock control: admin can read state', cstAdmin.ok === true && cstAdmin.available === true);
  const ctrlAnon = await req(CTRL_PORT, 'POST', '/api/unlock/toggle', {}, { enabled: false });
  check('unlock control: toggle requires login', ctrlAnon.status === 401, 'got ' + ctrlAnon.status);
  ctrlSrv.kill('SIGTERM');

  // 21. config validation surfaces mihomo's real error instead of bare exit code.
  // Regression guard for the -c bug: mihomo has no -c flag at all (the config
  // file flag is -f), so a -c in start() breaks every check on a real binary.
  const startSrc = unlockLib.MihomoProxy.prototype.start.toString();
  check('unlock: config error includes validator details',
    typeof unlockLib.MihomoProxy.prototype.start === 'function' &&
    /config invalid/.test(startSrc),
    'start() should run -t and embed stderr');
  check('unlock: mihomo is invoked with -f, not -c',
    /'-f'/.test(startSrc) && !/'-c'/.test(startSrc),
    'mihomo has no -c flag; -f specifies the config file');

  // 22. unlock progress: runUnlockCheck reports starting/started/per-node
  // events, and a binary that hangs on -t fails after 10s instead of
  // wedging the run forever.
  const fakeSrc = `#!/usr/bin/env node
'use strict';
// Minimal fake mihomo: -t exits 0, -v prints a version, run mode answers
// CONNECT with 200 then drops the socket (checkers fail fast) and serves
// the external controller (PUT /proxies/PROXY -> 204).
const fs=require('fs'),net=require('net'),http=require('http');
const args=process.argv.slice(2);
let cfg=null,test=false,ver=false;
for(let i=0;i<args.length;i++){
  if(args[i]==='-f')cfg=args[++i];
  else if(args[i]==='-t')test=true;
  else if(args[i]==='-v')ver=true;
}
if(ver){console.log('Mihomo Meta v1.19.11');process.exit(0);}
if(!cfg){console.error('no config');process.exit(2);}
let text='';try{text=fs.readFileSync(cfg,'utf8');}catch(e){process.exit(2);}
if(test)process.exit(0);
const mixed=Number((/mixed-port:\\s*(\\d+)/.exec(text)||[])[1]);
const ctrl=Number((/external-controller:\\s*127\\.0\\.0\\.1:(\\d+)/.exec(text)||[])[1]||(mixed+1));
const mixedSrv=net.createServer((sock)=>{
  sock.once('data',()=>{
    sock.write('HTTP/1.1 200 Connection Established'+String.fromCharCode(13,10,13,10));
    sock.destroy();
  });
  sock.on('error',()=>{});
});
mixedSrv.listen(mixed,'127.0.0.1');
const ctrlSrv=http.createServer((req,res)=>{
  if(req.method==='PUT'&&req.url==='/proxies/PROXY'){req.resume();res.writeHead(204);res.end();return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end('{"name":"PROXY"}');
});
ctrlSrv.listen(ctrl,'127.0.0.1');
process.on('SIGTERM',()=>{try{mixedSrv.close();ctrlSrv.close();}catch(e){}process.exit(0);});
`;
  const fakeBin = path.join(tmp, 'fake-mihomo');
  fs.writeFileSync(fakeBin, fakeSrc, { mode: 0o755 });
  const events = [];
  const pout = await unlockLib.runUnlockCheck([
    { key: 'p-node-1', link: 'hy2://u:p@example.com:443?sni=example.com', region: 'US' },
    { key: 'p-node-2', link: 'hy2://u:p@example.com:443?sni=example.com', region: 'US' },
  ], fakeBin, { onProgress: (key, status) => events.push([key, status]) });
  const seq = events.map((e) => (e[0] || '') + ':' + e[1]).join(',');
  check('unlock progress: events run starting->checking->done per node',
    seq === ':starting,p-node-1:checking,p-node-1:done,p-node-2:checking,p-node-2:done', 'got ' + seq);
  check('unlock progress: done nodes carry 7 providers',
    pout['p-node-1'] && pout['p-node-1'].providers && Object.keys(pout['p-node-1'].providers).length === 7);
  // -t timeout: a binary that never exits on -t must fail after ~10s, not hang.
  const hangSrc = `#!/usr/bin/env node
'use strict';
if (process.argv.includes('-t')) { setInterval(() => {}, 1000); } else { process.exit(0); }
`;
  const hangBin = path.join(tmp, 'fake-mihomo-hang');
  fs.writeFileSync(hangBin, hangSrc, { mode: 0o755 });
  const hangProxy = new unlockLib.MihomoProxy(hangBin, [unlockLib.linkToProxy('hy2://u:p@example.com:443?sni=example.com', 'h-node')], {});
  const ht0 = Date.now();
  let hangErr = '';
  try { await hangProxy.start(); } catch (e) { hangErr = e.message; } finally { try { hangProxy.stop(); } catch (e) {} }
  const ht = Date.now() - ht0;
  check('unlock progress: -t hang fails after ~10s, not forever',
    /timed out/.test(hangErr) && ht >= 9000 && ht < 20000, 'got ' + ht + 'ms: ' + hangErr.slice(0, 80));

  // 22b. HTTPS requests must go through the CONNECT tunnel, never DIRECT.
  // Regression: `https.request({createConnection, agent:false})` silently
  // opened a direct socket on some Node versions, so every node's egress IP
  // came back as the server's own IP. A proxy that rejects CONNECT with 502
  // must produce proxy_connect_502 — if the request went direct it would
  // instead reach the target and return 200.
  const httpsTarget = http.createServer((_rq, rs) => { rs.writeHead(200); rs.end('DIRECT-LEAK'); });
  await new Promise((r) => httpsTarget.listen(0, '127.0.0.1', r));
  let connectSeen = 0;
  const rejectProxy = http.createServer();
  rejectProxy.on('connect', (_rq, sock) => { connectSeen += 1; try { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} });
  await new Promise((r) => rejectProxy.listen(0, '127.0.0.1', r));
  const httpsRes = await unlockLib.probeRequest(rejectProxy.address().port,
    'https://127.0.0.1:' + httpsTarget.address().port + '/', { timeout: 3000 });
  check('unlock: HTTPS request is pinned to CONNECT tunnel (no DIRECT fallback)',
    connectSeen === 1 && httpsRes.error === 'proxy_connect_502',
    'connectSeen=' + connectSeen + ' error=' + (httpsRes.error || 'none') + ' status=' + httpsRes.status);
  httpsTarget.close(); rejectProxy.close();

  // 22c. The inner HTTPS request must actually travel through the CONNECT
  // tunnel. 22b only covers a rejected CONNECT; the real leak was subtler:
  // CONNECT succeeded (200) but the inner request opened its own DIRECT
  // socket, so every node's egress IP came back as the server's own IP.
  // A recording proxy counts the bytes that arrive on the tunnel after the
  // CONNECT — if the request went direct, zero bytes arrive here.
  let tunnelBytes = 0, tunnelConnects = 0;
  const tunnelTarget = net.createServer((sock) => { sock.on('data', () => {}); sock.on('error', () => {}); setTimeout(() => { try { sock.destroy(); } catch (e) {} }, 300); });
  await new Promise((r) => tunnelTarget.listen(0, '127.0.0.1', r));
  const recProxy = net.createServer((clientSock) => {
    let buf = Buffer.alloc(0);
    clientSock.once('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const m = /^CONNECT ([^ ]+) HTTP\/1\.1/i.exec(buf.toString('latin1'));
      if (!m) { clientSock.destroy(); return; }
      tunnelConnects += 1;
      const [host, portStr] = m[1].split(':');
      const up = net.connect(Number(portStr), host, () => {
        clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        clientSock.pipe(up); up.pipe(clientSock);
      });
      clientSock.on('data', (c) => { tunnelBytes += c.length; });
      clientSock.on('error', () => {});
      up.on('error', () => {});
    });
    clientSock.on('error', () => {});
  });
  await new Promise((r) => recProxy.listen(0, '127.0.0.1', r));
  await unlockLib.probeRequest(recProxy.address().port,
    'https://127.0.0.1:' + tunnelTarget.address().port + '/', { timeout: 4000 });
  check('unlock: inner HTTPS request travels through the CONNECT tunnel',
    tunnelConnects === 1 && tunnelBytes > 0,
    'connects=' + tunnelConnects + ' tunnelBytes=' + tunnelBytes);
  tunnelTarget.close(); recProxy.close();

  // 23. probeRequest never hangs: an oversized body resolves with what was
  // collected (destroying the stream used to leave the promise pending
  // forever — that wedged a real run for 323s), and a slow drip that keeps
  // resetting the per-step timeout is cut off by the overall cap.
  const bigTarget = http.createServer((_rq, rs) => { rs.writeHead(200, { 'Content-Type': 'text/html' }); rs.end('<html>' + 'x'.repeat(2 * 1024 * 1024) + '</html>'); });
  await new Promise((r) => bigTarget.listen(0, '127.0.0.1', r));
  const bigProxy = http.createServer();
  bigProxy.on('connect', (rq, sock) => {
    const [h, pt] = String(rq.url || '').split(':');
    const up = net.connect(Number(pt), h, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); sock.pipe(up); up.pipe(sock); });
    up.on('error', () => { try { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} });
  });
  await new Promise((r) => bigProxy.listen(0, '127.0.0.1', r));
  const bt0 = Date.now();
  const bigRes = await unlockLib.probeRequest(bigProxy.address().port, 'http://127.0.0.1:' + bigTarget.address().port + '/big', { bodyLimit: 1024 * 1024, timeout: 8000 });
  check('unlock: oversized body resolves instead of hanging', bigRes.status === 200 && bigRes.truncated === true && Date.now() - bt0 < 10000, 'got ' + (Date.now() - bt0) + 'ms status=' + bigRes.status);
  bigTarget.close(); bigProxy.close();
  const dripTarget = http.createServer((_rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'text/html' });
    const iv = setInterval(() => { try { rs.write('x'); } catch (e) { clearInterval(iv); } }, 500);
    rs.on('close', () => clearInterval(iv));
  });
  await new Promise((r) => dripTarget.listen(0, '127.0.0.1', r));
  const dripProxy = http.createServer();
  dripProxy.on('connect', (rq, sock) => {
    const [h, pt] = String(rq.url || '').split(':');
    const up = net.connect(Number(pt), h, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); sock.pipe(up); up.pipe(sock); });
    up.on('error', () => { try { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} });
  });
  await new Promise((r) => dripProxy.listen(0, '127.0.0.1', r));
  const dt0 = Date.now();
  const dripRes = await unlockLib.probeRequest(dripProxy.address().port, 'http://127.0.0.1:' + dripTarget.address().port + '/drip', { bodyLimit: 1024 * 1024, timeout: 1000 });
  check('unlock: slow drip is cut off by the overall cap', dripRes.error === 'probe_timeout' && Date.now() - dt0 < 10000, 'got ' + (Date.now() - dt0) + 'ms error=' + (dripRes.error || 'none'));
  dripTarget.close(); dripProxy.close();

  // 24. unlock tags show the failure reason for error/unknown providers
  // (v1.5.21): an "异常" tag with no reason is unactionable, so the console
  // renders the stored reason next to it; available tags stay clean.
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('unlock: error/unknown tags render the stored reason',
    serverSrc.includes("if((st==='error'||st==='unknown')&&r.reason)h+=' <small>'+esc(r.reason)+'</small>';"),
    'reason rendering missing from unlockTagsHtml');

  // 25. egress IP: checkNodeOnProxy records the IP the node exits from
  // (v1.5.22), so identical results across nodes can be traced to a shared
  // egress. Same mock-CONNECT-proxy shape as section 19, with a fake ipify
  // server as the tunnel target.
  const fakeIpify = http.createServer((_rq, rs) => { rs.writeHead(200, { 'Content-Type': 'text/plain' }); rs.end('203.0.113.7'); });
  await new Promise((r) => fakeIpify.listen(0, '127.0.0.1', r));
  const ipifyProxy = http.createServer();
  ipifyProxy.on('connect', (rq, sock) => {
    const [h, pt] = String(rq.url || '').split(':');
    const up = net.connect(Number(pt), h, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); sock.pipe(up); up.pipe(sock); });
    up.on('error', () => { try { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} });
  });
  await new Promise((r) => ipifyProxy.listen(0, '127.0.0.1', r));
  const egressIp = await unlockLib.checkEgressIp(ipifyProxy.address().port, 'http://127.0.0.1:' + fakeIpify.address().port + '/');
  check('unlock: egress IP is read through the node proxy', egressIp === '203.0.113.7', 'got ' + egressIp);
  const deadIp = await unlockLib.checkEgressIp(1);
  check('unlock: egress IP is null when the probe fails', deadIp === null, 'got ' + deadIp);
  fakeIpify.close(); ipifyProxy.close();

  // 26. mihomo start is patient and retries (v1.5.23): a binary that stays
  // alive without listening no longer kills the run after 9s with a bare
  // "no stderr" — each attempt waits 20s, it retries once on a fresh port,
  // and the error names the ports and whether the process was alive.
  const slowSrc = `#!/usr/bin/env node\n'use strict';\nif (process.argv.includes('-t')) process.exit(0);\nsetInterval(() => {}, 1000);\n`;
  const slowBin = path.join(tmp, 'fake-mihomo-slow');
  fs.writeFileSync(slowBin, slowSrc, { mode: 0o755 });
  const slowProxy = new unlockLib.MihomoProxy(slowBin, [unlockLib.linkToProxy('hy2://u:p@example.com:443?sni=example.com', 's-node')], { startTimeoutMs: 1000, startRetries: 1 });
  const st0 = Date.now();
  let slowErr = '';
  try { await slowProxy.start(); } catch (e) { slowErr = e.message; } finally { try { slowProxy.stop(); } catch (e) {} }
  const st = Date.now() - st0;
  check('unlock: hung start retries then fails with diagnostics',
    /failed to start within 1s/.test(slowErr) && /mixed-port \d+/.test(slowErr) && /still running/.test(slowErr) && st >= 1900 && st < 10000,
    'got ' + st + 'ms: ' + slowErr.slice(0, 140));

  // 27. egress IP is masked and fetched per node (v1.5.24): real runs showed
  // every node with the last node's IP, and the full address must never
  // reach the browser. maskIp keeps the network part (203.0.*.*) so nodes
  // stay distinguishable; unlockPublic applies it, so the API only ever
  // returns the masked form. The IP is also fetched first, alone, right
  // after the node's select — not in parallel with the provider burst.
  check('unlock: egress IP is masked for display (IPv4)',
    unlockLib.maskIp('203.0.113.45') === '203.0.*.*', 'got ' + unlockLib.maskIp('203.0.113.45'));
  check('unlock: egress IP is masked for display (IPv6)',
    unlockLib.maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348') === '2001:db8:*',
    'got ' + unlockLib.maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'));
  check('unlock: maskIp leaves non-IPs alone',
    unlockLib.maskIp(null) === null && unlockLib.maskIp('not-an-ip') === 'not-an-ip');
  const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('unlock: API returns the masked IP, never the full one',
    /unlockLib\.maskIp\(v\.ip\)/.test(srvSrc) && !/out\.ip = v\.ip;/.test(srvSrc));
  const cnpSrc = unlockLib.checkNodeOnProxy.toString();
  check('unlock: egress IP is fetched before the provider probes',
    cnpSrc.indexOf('checkEgressIp(port)') !== -1 &&
    cnpSrc.indexOf('checkEgressIp(port)') < cnpSrc.indexOf('Promise.all(PROVIDERS.map'));

  // 28. per-node mihomo (v1.5.25): the shared select group let every node
  // come back with the same egress IP on real runs (all 10 showed the
  // server's own 209.205.228.* instead of each node's own address). Each
  // node now gets its own mihomo holding only that node's proxy, so its
  // traffic cannot go through any other node. A recording fake mihomo logs
  // the proxy names in each config it is started with.
  const rucSrc = unlockLib.runUnlockCheck.toString();
  check('unlock: each node gets its own mihomo, no shared select',
    /new MihomoProxy\(binary, \[proxy\]/.test(rucSrc) && !/\.select\(/.test(rucSrc));
  const recLog = path.join(tmp, 'mihomo-configs.log');
  try { fs.unlinkSync(recLog); } catch (e) {}
  const recSrc = `#!/usr/bin/env node\n'use strict';\nconst fs=require('fs'),net=require('net');\nconst args=process.argv.slice(2);\nlet cfg=null,test=false;\nfor(let i=0;i<args.length;i++){ if(args[i]==='-f')cfg=args[++i]; else if(args[i]==='-t')test=true; }\nif(!cfg)process.exit(2);\nlet text='';try{text=fs.readFileSync(cfg,'utf8');}catch(e){process.exit(2);}\nif(test)process.exit(0);\nconst head=text.split('proxy-groups:')[0];\nconst names=[...head.matchAll(/- name: (.+)/g)].map((m)=>m[1].trim());\nfs.appendFileSync(process.env.REC_LOG, names.join(',')+'\\n');\nconst mixed=Number((/mixed-port:\\s*(\\d+)/.exec(text)||[])[1]);\nconst srv=net.createServer((sock)=>{ sock.once('data',()=>{ sock.write('HTTP/1.1 200 Connection Established'+String.fromCharCode(13,10,13,10)); sock.destroy(); }); sock.on('error',()=>{}); });\nsrv.listen(mixed,'127.0.0.1');\nprocess.on('SIGTERM',()=>{ try{srv.close();}catch(e){} process.exit(0); });\n`;
  const recBin = path.join(tmp, 'rec-fake-mihomo');
  fs.writeFileSync(recBin, recSrc, { mode: 0o755 });
  process.env.REC_LOG = recLog;
  await unlockLib.runUnlockCheck([
    { key: 'r-node-1', link: 'hy2://u:p@example.com:443?sni=example.com', region: 'US' },
    { key: 'r-node-2', link: 'hy2://u:p@example.com:443?sni=example.com', region: 'US' },
  ], recBin, {});
  delete process.env.REC_LOG;
  const recLines = fs.readFileSync(recLog, 'utf8').trim().split('\n');
  check('unlock: per-node mihomo config holds only that node',
    recLines.length === 2 && recLines[0] === '"r-node-1"' && recLines[1] === '"r-node-2"',
    'got ' + JSON.stringify(recLines));

  // 29. direct-IP baseline (v1.5.26): fetchDirectIp reads the server's own
  // egress IP with no proxy, so a node whose IP equals it can be flagged as
  // going direct. Tested against a local server (no real ipify call).
  const directSrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('203.0.113.99'); });
  await new Promise((r) => directSrv.listen(0, '127.0.0.1', r));
  const directIp = await unlockLib.fetchDirectIp('http://127.0.0.1:' + directSrv.address().port + '/');
  check('unlock: fetchDirectIp returns the server direct IP', directIp === '203.0.113.99', 'got ' + directIp);
  const garbageSrv = http.createServer((req, res) => { res.writeHead(200); res.end('not an ip'); });
  await new Promise((r) => garbageSrv.listen(0, '127.0.0.1', r));
  const garbageIp = await unlockLib.fetchDirectIp('http://127.0.0.1:' + garbageSrv.address().port + '/');
  check('unlock: fetchDirectIp rejects a non-IP body', garbageIp === null, 'got ' + garbageIp);
  const closedIp = await unlockLib.fetchDirectIp('http://127.0.0.1:1/');
  check('unlock: fetchDirectIp returns null when the target is unreachable', closedIp === null, 'got ' + closedIp);
  directSrv.close(); garbageSrv.close();
  // A node whose egress IP equals the server direct IP is the direct case;
  // the masked forms agree too, so the console can compare masked values.
  check('unlock: direct node IP masks to the same value as the server IP',
    unlockLib.maskIp('203.0.113.99') === unlockLib.maskIp('203.0.113.99') &&
    unlockLib.maskIp('203.0.113.99') === '203.0.*.*');

  lib.server.close(); mockEmos.close(); mockProbe.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log('\ncheck-fixes: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL check-fixes:', e); process.exit(1); });
