// v1.5.5 security regression. Boots the real server against mock EMOS/probe
// services, so every fix below is verified end-to-end, not just by reading code.
// Run: node test/check-fixes.js   (no network access required)
const http = require('http');
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

  lib.server.close(); mockEmos.close(); mockProbe.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log('\ncheck-fixes: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL check-fixes:', e); process.exit(1); });
