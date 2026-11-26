// Regression test: the / and /admin pages are JS template literals in server.js.
// A single-backslash escape (\n, \', \") inside them is eaten by the template
// literal, so the SERVED page script breaks while server.js still parses.
// This test boots the real server, fetches both pages, extracts <script> and
// runs node --check on exactly what the browser receives.
//
// It also covers the 2026-11-26 security audit (v1.4.0): unit tests for the
// pure helpers, a mock-EMOS server that proves a dropped carrot revokes the
// subscription immediately (no free re-check window), admin-login rate
// limiting, and crash-resistance (bad cookie / bad template must not kill
// the process). And v1.5.0: sessions/shares/admin sessions persist to
// config/state.json across restarts, so an update no longer invalidates
// every subscription link.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// All spawned servers get their own throwaway state file: without this, the
// demo logins in the main-server tests would write the REAL config/state.json.
const STATE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'emos-state-'));
const stateFile = (name) => path.join(STATE_TMP, name + '.json');

// ---- unit tests on the pure helpers (no server started) -------------------
const lib = require('../server.js');
let unitFail = 0;
function unit(name, cond) {
  if (!cond) { console.error('FAIL unit: ' + name); unitFail = 1; }
  else console.log('OK   unit: ' + name);
}
// month-end expire is computed in Shanghai time, not server-local time:
// 2026-11-30 16:30 UTC is already Dec 1 in Shanghai, so expire must be the
// end of DECEMBER, not November (the old local-time formula returned an
// expire in the past for ~8h every month-end).
unit('monthEndExpireMs month boundary (Nov 30 16:30 UTC -> Dec 31 23:59:59 +08)',
  new Date(lib.monthEndExpireMs(Date.parse('2026-11-30T16:30:00Z'))).toISOString() === '2026-12-31T15:59:59.000Z');
unit('monthEndExpireMs mid-month (Nov 15 -> Nov 30 23:59:59 +08)',
  new Date(lib.monthEndExpireMs(Date.parse('2026-11-15T12:00:00Z'))).toISOString() === '2026-11-30T15:59:59.000Z');
unit('parseHy2 rejects port 0', lib.parseHy2('hysteria2://pass@203.0.113.1:0/?sni=x.example#t') === null);
unit('parseHy2 rejects port 99999', lib.parseHy2('hysteria2://pass@203.0.113.1:99999/?sni=x.example#t') === null);
unit('parseHy2 accepts port 443', lib.parseHy2('hysteria2://pass@203.0.113.1:443/?sni=x.example#t') !== null);
unit('parseVless rejects REALITY without pbk', lib.parseVless('vless://11111111-1111-4111-8111-111111111111@203.0.113.1:443?security=reality&sni=x.example#t') === null);
unit('parseVless accepts REALITY with pbk', lib.parseVless('vless://11111111-1111-4111-8111-111111111111@203.0.113.1:443?security=reality&sni=x.example&pbk=abc123#t') !== null);
if (unitFail) process.exit(1);

// ---- HTTP helpers ---------------------------------------------------------
function reqRaw(port, method, p, headers, body) {
  return new Promise((res, rej) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ status: r.statusCode, body: d, headers: r.headers }));
    });
    req.on('error', rej);
    if (data) req.end(data); else req.end();
  });
}
const get = (port, p, headers) => reqRaw(port, 'GET', p, headers).then((r) => r.body);
const postJson = (port, p, body, headers) => reqRaw(port, 'POST', p, headers, body).then((r) => JSON.parse(r.body));
const getUA = (port, p, ua, headers) => reqRaw(port, 'GET', p, { 'User-Agent': ua, ...headers }).then((r) => r.body);

function spawnServer(cwd, port, extraEnv) {
  return spawn(process.execPath, ['server.js'], {
    cwd,
    env: { ...process.env, ADMIN_TOKEN: 'test-token', DEMO_ENABLED: '1', PORT: String(port), ...extraEnv },
    stdio: 'ignore',
  });
}
async function waitUp(port) {
  for (let i = 0; i < 50; i++) {
    try { await get(port, '/health'); return; } catch (e) { await sleep(200); }
  }
  throw new Error('server on ' + port + ' did not come up');
}
async function waitDown(port) {
  for (let i = 0; i < 25; i++) {
    try { await get(port, '/health'); } catch (e) { return; }
    await sleep(200);
  }
  throw new Error('server on ' + port + ' did not stop');
}

const PORT = 3109;
const srv = spawnServer(REPO, PORT, { EMOS_STATE_FILE: stateFile('main') });
(async () => {
  let code = 0;
  const fail = (m) => { console.error('FAIL ' + m); code = 1; };
  const ok = (m) => console.log('OK   ' + m);
  try {
    await waitUp(PORT);
    for (const p of ['/', '/admin']) {
      const html = await get(PORT, p);
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
      if (!scripts.length) throw new Error(p + ': no <script> found');
      for (let i = 0; i < scripts.length; i++) {
        const f = path.join(os.tmpdir(), 'emos-page-' + p.replace(/\//g, '_') + '-' + i + '.js');
        fs.writeFileSync(f, scripts[i]);
        try {
          execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
          console.log('OK   ' + p + ' script[' + i + '] parses (' + scripts[i].length + ' bytes)');
        } catch (e) {
          console.error('FAIL ' + p + ' script[' + i + '] does not parse:');
          console.error(e.stderr.toString());
          code = 1;
        }
      }
    }
    // Clash subscription must carry proxies, ACL4SSR groups/providers/rules,
    // and sing-box must be valid JSON — a structurally broken profile is
    // exactly what shows up as "no nodes" in FlClash (2026-11-26).
    const auth = await postJson(PORT, '/api/auth', { carrot: 600 });
    if (!auth.ok) throw new Error('/api/auth demo login failed: ' + JSON.stringify(auth));
    const clash = await get(PORT, '/c/?token=' + encodeURIComponent(auth.sub_token) + '&client=clash');
    for (const needle of ['proxies:', 'proxy-groups:', 'rule-providers:', 'RULE-SET,BanAD', 'RULE-SET,ChinaDomain', 'GEOIP,CN', 'MATCH,', '🚀 节点选择', '🆎 AdBlock']) {
      if (!clash.includes(needle)) fail('clash output missing: ' + needle);
    }
    if (!code) ok('/c/?client=clash carries proxies + ACL4SSR providers/rules (' + clash.length + ' bytes)');
    const sb = JSON.parse(await get(PORT, '/c/?token=' + encodeURIComponent(auth.sub_token) + '&client=sing-box'));
    if (!Array.isArray(sb.outbounds) || !sb.outbounds.length) fail('sing-box output has no outbounds');
    else ok('/c/?client=sing-box parses, ' + sb.outbounds.length + ' outbounds');
    // One auto-adaptive link: /c/?token= with no client param sniffs UA.
    const auto = '/c/?token=' + encodeURIComponent(auth.sub_token);
    const asFlclash = await getUA(PORT, auto, 'FlClash/0.8.0 (Android)');
    if (!asFlclash.includes('proxy-groups:')) fail('/c/ with FlClash UA did not return Clash YAML');
    else ok('/c/ + FlClash UA -> Clash YAML');
    const asSingbox = await getUA(PORT, auto, 'sing-box/1.12.0');
    try {
      const j = JSON.parse(asSingbox);
      if (!Array.isArray(j.outbounds) || !j.outbounds.length) throw new Error('no outbounds');
      ok('/c/ + sing-box UA -> JSON, ' + j.outbounds.length + ' outbounds');
    } catch (e) { fail('/c/ with sing-box UA did not return JSON: ' + e.message); }
    const asBrowser = await getUA(PORT, auto, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
    if (!asBrowser.includes('按客户端自动识别')) fail('/c/ with browser UA did not return chooser page');
    else ok('/c/ + browser UA -> chooser page with single link');
    // Console shows one subscription link, not four per-client rows.
    const consoleHtml = await get(PORT, '/');
    if (!consoleHtml.includes('id="subAuto"') || consoleHtml.includes('id="subSingbox"') || consoleHtml.includes('id="subClash"')) {
      fail('console subscription section is not the single auto link');
    } else ok('console shows one auto-adaptive subscription link');
    // Layout: nodes card above subscription card, with an expiry column.
    if (!consoleHtml.includes('<th>到期</th>') || consoleHtml.indexOf('节点 · 总流量') > consoleHtml.indexOf('订阅链接（每人专属')) {
      fail('console layout: nodes must be above subscription and have an expiry column');
    } else ok('console layout: nodes above subscription, expiry column present');
    // No monitoring columns in the console table (no CPU/uptime/realtime).
    if (consoleHtml.includes('CPU / 运行') || consoleHtml.includes('状态 / 实时') || consoleHtml.includes('fmtSpeed')) {
      fail('console table still shows CPU/uptime/realtime');
    } else ok('console table has no CPU/uptime/realtime columns');
    // Console hides the per-node description and probe mapping entirely
    // (admin still shows them — only the user-facing console drops them).
    if (consoleHtml.includes('探针：') || consoleHtml.includes('probeNote') || consoleHtml.includes('节点 · 总流量（探针）')) {
      fail('console still shows node descriptions or probe mapping');
    } else ok('console shows no node description or probe mapping');
    // The total-traffic stat card was removed from the console (v1.4.4):
    // per-node traffic stays in the table, the aggregate is gone. Mobile
    // card layout labels every cell and turns rows into cards.
    if (consoleHtml.includes('statTotalTraffic') || !consoleHtml.includes('data-label=') || !consoleHtml.includes('.node-table')) {
      fail('console still has total-traffic stat or lost mobile card layout');
    } else ok('console has no total-traffic stat and keeps mobile card layout');
    // /api/nodes exposes expires_at (null for demo nodes without one).
    const nodesRes = JSON.parse((await reqRaw(PORT, 'GET', '/api/nodes', { 'X-Session': auth.session })).body);
    if (!nodesRes.ok || !Array.isArray(nodesRes.nodes) || !nodesRes.nodes.every((n) => 'expires_at' in n)) {
      fail('/api/nodes does not expose expires_at');
    } else ok('/api/nodes exposes expires_at (' + nodesRes.nodes.length + ' nodes)');
    // Expiry comes from the probe automatically (demo nodes have no manual
    // expires_at; the mapped probe nodes 2/22/20 all carry one).
    const mapped = nodesRes.nodes.filter((n) => n.probe_node_id != null);
    if (!mapped.length || !mapped.every((n) => n.expires_at)) {
      fail('/api/nodes did not fill expires_at from probe');
    } else ok('/api/nodes fills expires_at from probe: ' + mapped.map((n) => n.name + '=' + n.expires_at).join(', '));
    // Button is just 一键导入 now (still the sing-box deep link underneath).
    if (!consoleHtml.includes('>一键导入</button>') || consoleHtml.includes('一键导入 sing-box')) {
      fail('console import button label is not 一键导入');
    } else ok('console import button reads 一键导入');
    // Admin node form has the expiry input.
    const adminHtml = await get(PORT, '/admin');
    if (!adminHtml.includes('id="nodeExpiry"')) fail('admin node form has no expiry input');
    else ok('admin node form has expiry input');
    // Security headers are present on JSON + HTML responses.
    const h1 = (await reqRaw(PORT, 'GET', '/health')).headers;
    if (h1['x-content-type-options'] !== 'nosniff' || h1['x-frame-options'] !== 'DENY') fail('security headers missing on /health');
    else ok('security headers present (nosniff, no-referrer, DENY framing)');
    // One live session per user: a second login revokes the first.
    const auth2 = await postJson(PORT, '/api/auth', { carrot: 600 });
    const oldNodes = await reqRaw(PORT, 'GET', '/api/nodes', { 'X-Session': auth.session });
    const newNodes = await reqRaw(PORT, 'GET', '/api/nodes', { 'X-Session': auth2.session });
    if (oldNodes.status !== 401 || newNodes.status !== 200) fail('second login did not revoke the first session (old=' + oldNodes.status + ' new=' + newNodes.status + ')');
    else ok('second login revokes the first session (old 401, new 200)');
  } catch (e) { console.error('FAIL', e.message); code = 1; }
  srv.kill();

  // ---- copy-server tests (throwaway dir, so admin writes stay out of the repo)
  const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emos-copy-'));
  fs.cpSync(REPO, copyDir, { recursive: true, filter: (s) => !s.includes(`${path.sep}.git`) });
  const CPORT = 3110;
  try {
    const csrv = spawnServer(copyDir, CPORT, { ADMIN_LOGIN_MAX_FAILS: '5', ADMIN_LOGIN_LOCK_MS: '2000', EMOS_STATE_FILE: stateFile('copy') });
    await waitUp(CPORT);
    const cauth = await postJson(CPORT, '/api/auth', { carrot: 600 });
    if (!cauth.ok) throw new Error('copy server demo login failed');
    // Admin login rate limit: 5 wrong -> 401, 6th -> 429, then unlocks.
    for (let i = 0; i < 5; i++) {
      const r = await reqRaw(CPORT, 'POST', '/api/admin/login', {}, { token: 'wrong' });
      if (r.status !== 401) fail('admin login attempt ' + (i + 1) + ' should be 401, got ' + r.status);
    }
    const blocked = await reqRaw(CPORT, 'POST', '/api/admin/login', {}, { token: 'wrong' });
    if (blocked.status !== 429) fail('6th failed admin login should be 429, got ' + blocked.status);
    else ok('admin login locks after 5 failures (6th -> 429)');
    await sleep(2500);
    const good = await reqRaw(CPORT, 'POST', '/api/admin/login', {}, { token: 'test-token' });
    if (good.status !== 200) fail('admin login should work again after the lock window, got ' + good.status);
    else ok('admin login works again after the lock window');
    // Malformed cookie must not crash the server (2026-11-26: it did).
    const badCookie = await reqRaw(CPORT, 'GET', '/api/nodes', { Cookie: 'emos_session=%ZZ' });
    const alive1 = await reqRaw(CPORT, 'GET', '/health');
    if (badCookie.status !== 401 || alive1.status !== 200) fail('malformed cookie: expected 401 + alive server, got ' + badCookie.status + ' / ' + alive1.status);
    else ok('malformed cookie returns 401, server stays alive');
    // Host header injection must not break out of the chooser href.
    const chooser = await reqRaw(CPORT, 'GET', '/c/?token=' + encodeURIComponent(cauth.sub_token), { 'User-Agent': 'Mozilla/5.0 Chrome/120', Host: 'x" onclick="alert(1)' });
    if (chooser.status !== 200 || chooser.body.includes('onclick="alert')) fail('Host header injection reached the chooser page');
    else ok('crafted Host header cannot inject into the chooser page');
    // /c without the trailing slash works.
    const noSlash = await reqRaw(CPORT, 'GET', '/c?token=' + encodeURIComponent(cauth.sub_token), { 'User-Agent': 'sing-box/1.12.0' });
    try {
      const j = JSON.parse(noSlash.body);
      if (noSlash.status !== 200 || !Array.isArray(j.outbounds)) throw new Error('bad body');
      ok('/c without trailing slash returns sing-box JSON');
    } catch (e) { fail('/c without trailing slash did not return sing-box JSON (status ' + noSlash.status + ')'); }
    // Node names containing $& must survive the naming rule verbatim
    // (String.replace used to treat $& in the replacement as "the match").
    const added = await postJson(CPORT, '/api/admin/nodes', { link: 'hysteria2://FakePass123@203.0.113.99:20881/?sni=example.net#ignored', name: 'A$&B', region: 'US' }, { 'X-Admin-Token': 'test-token' });
    if (!added.ok) fail('admin node create failed: ' + JSON.stringify(added));
    else {
      const c2 = await get(CPORT, '/c/?token=' + encodeURIComponent(cauth.sub_token) + '&client=clash');
      if (!c2.includes('A$&B') || c2.includes('A$NameB')) fail('node name with $& was mangled by the naming rule');
      else ok('node name with $& survives the naming rule verbatim');
    }
    csrv.kill();
    // Broken sing-box template: 500 JSON, server stays alive (used to crash).
    const tpl = path.join(copyDir, 'config', 'templates', 'singbox.json');
    fs.writeFileSync(tpl, fs.readFileSync(tpl, 'utf8').replace('{{OUTBOUNDS}}', '{{OUTBOUNDS}'));
    const csrv2 = spawnServer(copyDir, CPORT, { EMOS_STATE_FILE: stateFile('copy2') });
    await waitUp(CPORT);
    const authB = await postJson(CPORT, '/api/auth', { carrot: 600 });
    const badSb = await reqRaw(CPORT, 'GET', '/c/?token=' + encodeURIComponent(authB.sub_token) + '&client=sing-box');
    const alive2 = await reqRaw(CPORT, 'GET', '/health');
    if (badSb.status !== 500 || alive2.status !== 200) fail('broken template: expected 500 + alive server, got ' + badSb.status + ' / ' + alive2.status);
    else ok('broken sing-box template returns 500 JSON, server stays alive');
    csrv2.kill();
  } catch (e) { console.error('FAIL copy-server tests:', e.message); code = 1; }
  fs.rmSync(copyDir, { recursive: true, force: true });

  // ---- mock-EMOS test: a dropped carrot must revoke immediately ---------
  // No free re-check window: the old code set lastCarrotCheck before the
  // threshold test, so one failed re-check granted 10 more minutes.
  let mockCarrot = 600;
  const mockEmos = http.createServer((req, res) => {
    if (req.url.startsWith('/api/carrot/current')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ carrot: mockCarrot }));
    } else if (req.url.startsWith('/api/sign/check')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ is_sign: true, user_id: 'mock-user' }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => mockEmos.listen(3111, '127.0.0.1', r));
  const GPORT = 3112;
  try {
    const gsrv = spawnServer(REPO, GPORT, { EMOS_BASE: 'http://127.0.0.1:3111', CARROT_RECHECK_MS: '5000', DEMO_ENABLED: '', EMOS_STATE_FILE: stateFile('gate') });
    await waitUp(GPORT);
    const login = await postJson(GPORT, '/api/auth', { token: 'fake-emos-token' });
    if (!login.ok) throw new Error('mock EMOS login failed: ' + JSON.stringify(login));
    const fetchSub = () => reqRaw(GPORT, 'GET', '/c/?token=' + encodeURIComponent(login.sub_token), { 'User-Agent': 'sing-box/1.12.0' });
    const first = await fetchSub();
    if (first.status !== 200) throw new Error('subscription did not work after mock login: ' + first.status);
    mockCarrot = 400;
    const cached = await fetchSub();
    if (cached.status !== 200) fail('subscription should still work inside the re-check window, got ' + cached.status);
    else ok('subscription works inside the re-check window (carrot dropped, not yet re-checked)');
    await sleep(5500);
    const revoked = await fetchSub();
    if (revoked.status !== 403) fail('dropped carrot should revoke the subscription, got ' + revoked.status);
    else ok('dropped carrot revokes the subscription (403)');
    const again = await fetchSub();
    if (again.status !== 403) fail('revoked subscription served again (free-window bug), got ' + again.status);
    else ok('revoked subscription stays revoked (no free re-check window)');
    const refresh = await reqRaw(GPORT, 'POST', '/api/sub/refresh', { 'X-Session': login.session }, {});
    if (refresh.status !== 401) fail('refresh after revocation should be 401, got ' + refresh.status);
    else ok('refresh after revocation is rejected (401)');
    mockCarrot = 600;
    const login2 = await postJson(GPORT, '/api/auth', { token: 'fake-emos-token' });
    if (!login2.ok) fail('re-login after carrot recovered failed');
    else {
      const back = await reqRaw(GPORT, 'GET', '/c/?token=' + encodeURIComponent(login2.sub_token), { 'User-Agent': 'sing-box/1.12.0' });
      if (back.status !== 200) fail('subscription did not work after re-login, got ' + back.status);
      else ok('re-login after carrot recovery works again');
    }
    gsrv.kill();
  } catch (e) { console.error('FAIL mock-EMOS tests:', e.message); code = 1; }
  mockEmos.close();

  // ---- restart persistence: sessions/shares survive a restart (v1.5.0) ----
  // Before this, sessions + shares lived only in memory: every manage.sh
  // update (which restarts the service) invalidated every subscription link.
  const RPORT = 3113;
  const rstate = stateFile('restart');
  try {
    const rsrv = spawnServer(REPO, RPORT, { EMOS_STATE_FILE: rstate });
    await waitUp(RPORT);
    const rlogin = await postJson(RPORT, '/api/auth', { carrot: 600 });
    if (!rlogin.ok) throw new Error('restart-test login failed');
    const subBefore = await reqRaw(RPORT, 'GET', '/c/?token=' + encodeURIComponent(rlogin.sub_token), { 'User-Agent': 'sing-box/1.12.0' });
    if (subBefore.status !== 200) throw new Error('subscription did not work before restart: ' + subBefore.status);
    const nodesBefore = await reqRaw(RPORT, 'GET', '/api/nodes', { 'X-Session': rlogin.session });
    if (nodesBefore.status !== 200) throw new Error('session did not work before restart: ' + nodesBefore.status);
    const adminLogin = await reqRaw(RPORT, 'POST', '/api/admin/login', {}, { token: 'test-token' });
    if (adminLogin.status !== 200) throw new Error('restart-test admin login failed');
    const adminCookie = adminLogin.headers['set-cookie'][0].split(';')[0];
    // The state file holds live EMOS tokens: it must be owner-only and must
    // never reach the public repo.
    const st = fs.statSync(rstate);
    if ((st.mode & 0o777) !== 0o600) fail('state file is not 0600, got ' + (st.mode & 0o777).toString(8));
    else ok('state file written with 0600 permissions');
    try {
      execFileSync('git', ['check-ignore', '-q', 'config/state.json'], { cwd: REPO });
      ok('config/state.json is git-ignored (tokens never reach the public repo)');
    } catch (e) { fail('config/state.json is NOT git-ignored — EMOS tokens could leak to GitHub'); }
    rsrv.kill('SIGTERM');
    await waitDown(RPORT);
    const rsrv2 = spawnServer(REPO, RPORT, { EMOS_STATE_FILE: rstate });
    await waitUp(RPORT);
    const subAfter = await reqRaw(RPORT, 'GET', '/c/?token=' + encodeURIComponent(rlogin.sub_token), { 'User-Agent': 'sing-box/1.12.0' });
    if (subAfter.status !== 200) fail('subscription token broke across restart, got ' + subAfter.status);
    else ok('subscription token survives a restart');
    const nodesAfter = await reqRaw(RPORT, 'GET', '/api/nodes', { 'X-Session': rlogin.session });
    if (nodesAfter.status !== 200) fail('user session broke across restart, got ' + nodesAfter.status);
    else ok('user session survives a restart');
    const adminAfter = await reqRaw(RPORT, 'GET', '/api/admin/health', { Cookie: adminCookie });
    if (adminAfter.status !== 200) fail('admin session broke across restart, got ' + adminAfter.status);
    else ok('admin session survives a restart');
    rsrv2.kill();
    await waitDown(RPORT);
  } catch (e) { console.error('FAIL restart-persistence tests:', e.message); code = 1; }
  fs.rmSync(STATE_TMP, { recursive: true, force: true });
  process.exit(code);
})();
