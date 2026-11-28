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

  lib.server.close(); mockEmos.close(); mockProbe.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log('\ncheck-fixes: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL check-fixes:', e); process.exit(1); });
