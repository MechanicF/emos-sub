// emos-sub unlock subsystem — mihomo-backed streaming/AI availability probes.
// Ported from ZeroDeng01/sublinkPro services/unlock/*.go to zero-dependency
// Node.js. Requires an external mihomo binary (managed by manage.sh).
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROVIDERS = ['netflix', 'disney', 'youtube_premium', 'openai', 'gemini', 'claude', 'bahamut'];
const DEFAULT_TIMEOUT_MS = 8000;

// ---------- pure helpers (exported for tests) ----------
function yamlQuote(v) { return JSON.stringify(String(v == null ? '' : v)); }

// hy2:// / hysteria2:// and vless:// -> Clash proxy map for mihomo.
// Reuses the same field semantics as server.js parseHy2/parseVless.
function linkToProxy(link, name) {
  if (typeof link !== 'string') return null;
  const l = link.trim();
  try {
    if (l.startsWith('hy2://') || l.startsWith('hysteria2://')) {
      const u = new URL(l);
      const password = decodeURIComponentSafe(u.username + (u.password ? ':' + u.password : ''));
      if (!password || !u.hostname) return null;
      const port = parseInt(u.port || '443', 10);
      if (!(port >= 1 && port <= 65535)) return null;
      const p = u.searchParams;
      const proxy = {
        name, type: 'hysteria2', server: u.hostname, port,
        password, 'skip-cert-verify': true,
        sni: p.get('sni') || u.hostname,
      };
      const obfs = p.get('obfs');
      if (obfs && obfs !== 'none') { proxy.obfs = obfs; if (p.get('obfs-password')) proxy['obfs-password'] = p.get('obfs-password'); }
      if (p.get('ports')) proxy.ports = p.get('ports');
      return proxy;
    }
    if (l.startsWith('vless://')) {
      const u = new URL(l);
      const uuid = decodeURIComponentSafe(u.username);
      if (!uuid || !u.hostname) return null;
      const port = parseInt(u.port || '443', 10);
      if (!(port >= 1 && port <= 65535)) return null;
      const p = u.searchParams;
      const security = (p.get('security') || 'none').toLowerCase();
      const proxy = {
        name, type: 'vless', server: u.hostname, port, uuid,
        'skip-cert-verify': true, network: (p.get('type') || 'tcp').toLowerCase(),
      };
      if (p.get('flow')) proxy.flow = p.get('flow');
      if (p.get('encryption')) proxy.encryption = p.get('encryption');
      if (security === 'reality') {
        if (!p.get('pbk')) return null;
        proxy.tls = true;
        proxy.servername = p.get('sni') || '';
        proxy['reality-opts'] = { 'public-key': p.get('pbk'), 'short-id': p.get('sid') || '' };
        if (p.get('fp')) proxy['client-fingerprint'] = p.get('fp');
      } else if (security === 'tls') {
        proxy.tls = true;
        proxy.servername = p.get('sni') || u.hostname;
        if (p.get('fp')) proxy['client-fingerprint'] = p.get('fp');
        if (p.get('alpn')) proxy.alpn = p.get('alpn').split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (proxy.network === 'ws') {
        proxy['ws-opts'] = { path: p.get('path') || '/', headers: { Host: p.get('host') || p.get('sni') || u.hostname } };
      } else if (proxy.network === 'grpc') {
        proxy['grpc-opts'] = { 'grpc-service-name': p.get('serviceName') || '' };
      }
      return proxy;
    }
  } catch (e) { /* fall through */ }
  return null;
}
function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

function yamlProxyEntry(p) {
  const lines = ['  - name: ' + yamlQuote(p.name), '    type: ' + yamlQuote(p.type),
    '    server: ' + yamlQuote(p.server), '    port: ' + Number(p.port),
    '    skip-cert-verify: true'];
  const scalar = (k, v) => { if (v !== undefined && v !== null && v !== '') lines.push('    ' + k + ': ' + yamlQuote(v)); };
  scalar('password', p.password); scalar('uuid', p.uuid); scalar('sni', p.sni); scalar('servername', p.servername);
  scalar('obfs', p.obfs); scalar('obfs-password', p['obfs-password']); scalar('ports', p.ports);
  scalar('flow', p.flow); scalar('network', p.network); scalar('encryption', p.encryption);
  scalar('client-fingerprint', p['client-fingerprint']);
  if (p.tls) lines.push('    tls: true');
  if (p.alpn && p.alpn.length) lines.push('    alpn: [' + p.alpn.map(yamlQuote).join(', ') + ']');
  if (p['reality-opts']) {
    lines.push('    reality-opts:');
    lines.push('      public-key: ' + yamlQuote(p['reality-opts']['public-key'] || ''));
    // An empty short-id is rejected by some mihomo versions; omit it.
    if (p['reality-opts']['short-id']) lines.push('      short-id: ' + yamlQuote(p['reality-opts']['short-id']));
  }
  if (p['ws-opts']) {
    lines.push('    ws-opts:');
    lines.push('      path: ' + yamlQuote(p['ws-opts'].path || '/'));
    lines.push('      headers:');
    for (const [k, v] of Object.entries(p['ws-opts'].headers || {})) lines.push('        ' + yamlQuote(k) + ': ' + yamlQuote(v));
  }
  if (p['grpc-opts']) {
    lines.push('    grpc-opts:');
    lines.push('      grpc-service-name: ' + yamlQuote(p['grpc-opts']['grpc-service-name'] || ''));
  }
  return lines.join('\n');
}

function buildMihomoConfig(proxies, mixedPort, controllerPort) {
  const names = proxies.map((p) => p.name);
  return [
    'mixed-port: ' + mixedPort,
    'allow-lan: false',
    'mode: rule',
    'external-controller: 127.0.0.1:' + controllerPort,
    'proxies:',
    proxies.map(yamlProxyEntry).join('\n'),
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies:',
    ...names.map((n) => '      - ' + yamlQuote(n)),
    'rules:',
    '  - MATCH,PROXY',
    '',
  ].join('\n');
}

// ---------- HTTP through an HTTP proxy via CONNECT tunnel (zero dependency) ----------
function probeRequest(proxyPort, targetUrl, opts) {
  opts = opts || {};
  const url = new URL(targetUrl);
  const method = opts.method || 'GET';
  const headers = Object.assign({
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  }, opts.headers || {});
  const body = opts.body ? Buffer.from(opts.body) : null;
  if (body) headers['Content-Length'] = body.length;
  const timeoutMs = opts.timeout || DEFAULT_TIMEOUT_MS;
  const maxRedirects = 5;
  // Hard cap for the whole call (CONNECT + inner request + redirects). The
  // per-step timeouts above do not cover every path: when the body passed
  // the limit, destroying the response stream used to leave the promise
  // pending forever (no 'end'/'error' fires), so one oversized page wedged
  // the checker, the node, and the whole run. Nothing here may hang past
  // this cap.
  const overallMs = timeoutMs * 3;

  return new Promise((resolve) => {
    let redirects = 0;
    let socket;
    let settled = false;
    const agent = new http.Agent({ keepAlive: false });
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      try { if (socket) socket.destroy(); } catch (e) {}
      agent.destroy();
      resolve(result);
    };
    const overallTimer = setTimeout(() => {
      done({ status: 0, url: targetUrl, body: '', error: 'probe_timeout' });
    }, overallMs);

    function run(currentUrl) {
      const u = new URL(currentUrl);
      const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
      const req = http.request({
        host: '127.0.0.1', port: proxyPort, method: 'CONNECT',
        path: u.hostname + ':' + port,
        agent, timeout: timeoutMs,
      });
      req.on('connect', (res, tunnelSocket) => {
        socket = tunnelSocket;
        if (res.statusCode !== 200) return done({ status: 0, url: currentUrl, body: '', error: 'proxy_connect_' + res.statusCode });
        const target = u.protocol === 'https:' ? https : http;
        const treq = target.request({
          host: u.hostname, port, path: u.pathname + u.search, method,
          headers, createConnection: () => tunnelSocket, agent: false,
        });
        treq.setTimeout(timeoutMs, () => { treq.destroy(new Error('timeout')); });
        treq.on('response', (tres) => {
          let size = 0;
          const limit = opts.bodyLimit || 1024 * 1024;
          const chunks = [];
          tres.on('data', (c) => {
            size += c.length;
            if (size <= limit) { chunks.push(c); return; }
            // Body past the cap: resolve with what was collected. Merely
            // destroying the stream never settles this promise (see the
            // overall cap above) — that was the 323s wedge.
            const raw = Buffer.concat(chunks).toString('utf8');
            done({ status: tres.statusCode, url: currentUrl, finalUrl: currentUrl, body: raw.toLowerCase(), rawBody: raw, headers: tres.headers, truncated: true });
          });
          tres.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const loc = tres.headers.location;
            if (loc && [301, 302, 303, 307, 308].includes(tres.statusCode) && redirects < maxRedirects) {
              redirects += 1;
              return run(new URL(loc, currentUrl).toString());
            }
            done({ status: tres.statusCode, url: currentUrl, finalUrl: currentUrl, body: raw.toLowerCase(), rawBody: raw, headers: tres.headers });
          });
          tres.on('error', (e) => done({ status: 0, url: currentUrl, body: '', error: e.message }));
        });
        treq.on('error', (e) => done({ status: 0, url: currentUrl, body: '', error: e.message }));
        if (body) treq.write(body);
        treq.end();
      });
      req.on('timeout', () => { req.destroy(new Error('connect_timeout')); });
      req.on('error', (e) => done({ status: 0, url: currentUrl, body: '', error: e.message }));
      req.end();
    }
    run(targetUrl);
  });
}

// ---------- 7 providers (ported from sublinkPro) ----------
function res(provider, status, extra) { return Object.assign({ provider, status }, extra || {}); }
function extract(pattern, text) { const m = pattern.exec(text || ''); return m ? m[1] : ''; }

async function checkNetflix(p) {
  const H = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
  const a = await probeRequest(p.port, 'https://www.netflix.com/title/81280792', { headers: H, bodyLimit: 512 * 1024 });
  if (a.error) return res('netflix', 'error', { reason: a.error });
  const b = await probeRequest(p.port, 'https://www.netflix.com/title/70143836', { headers: H, bodyLimit: 512 * 1024 });
  if (b.error) return res('netflix', 'error', { reason: b.error });
  if ([a, b].some((x) => /nsez-403/.test(x.body + ' ' + x.url))) return res('netflix', 'restricted', { reason: 'nsez_403' });
  if ([a, b].some((x) => x.status >= 400)) return res('netflix', 'restricted', { reason: 'status_' + a.status + '_' + b.status });
  const blockedA = /oh no!/.test(a.body), blockedB = /oh no!/.test(b.body);
  const region = extract(/"id":"([A-Za-z]{2})".*"countryName":"[^"]*"/s, a.rawBody || '').toUpperCase();
  if (blockedA && blockedB) return res('netflix', 'partial', { region, detail: 'originals_only' });
  if (!blockedA || !blockedB) return res('netflix', 'available', { region });
  return res('netflix', 'unknown', { region, reason: 'page_marker_missing' });
}

async function checkDisney(p) {
  const bearer = 'Bearer ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84';
  const dev = await probeRequest(p.port, 'https://disney.api.edge.bamgrid.com/devices', {
    method: 'POST', headers: { Authorization: bearer, 'Content-Type': 'application/json; charset=UTF-8' },
    body: '{"deviceFamily":"browser","applicationRuntime":"chrome","deviceProfile":"windows","attributes":{}}',
  });
  if (dev.error) return res('disney', 'error', { reason: dev.error });
  if (/403 error/.test(dev.body)) return res('disney', 'restricted', { reason: 'ip_banned' });
  const assertion = extract(/"assertion"\s*:\s*"([^"]+)"/i, dev.rawBody || '');
  if (!assertion) return res('disney', 'unknown', { reason: 'assertion_missing' });
  const tok = await probeRequest(p.port, 'https://disney.api.edge.bamgrid.com/token', {
    method: 'POST', headers: { Authorization: bearer, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&latitude=0&longitude=0&platform=browser&subject_token=' + assertion + '&subject_token_type=urn%3Abamtech%3Aparams%3Aoauth%3Atoken-type%3Adevice',
  });
  if (tok.error) return res('disney', 'error', { reason: tok.error });
  if (/forbidden-location|403 error/.test(tok.body)) return res('disney', 'restricted', { reason: 'ip_banned' });
  const refresh = extract(/"refresh_token"\s*:\s*"([^"]+)"/i, tok.rawBody || '');
  if (!refresh) return res('disney', 'unknown', { reason: 'refresh_token_missing' });
  const graph = await probeRequest(p.port, 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql', {
    method: 'POST', headers: { Authorization: bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'mutation refreshToken($input: RefreshTokenInput!) { refreshToken(refreshToken: $input) { activeSession { sessionId } } }', variables: { input: { refreshToken: refresh } } }),
  });
  if (graph.error) return res('disney', 'error', { reason: graph.error });
  const region = extract(/"countryCode"\s*:\s*"([^"]+)"/i, graph.rawBody || '').toUpperCase();
  const supported = extract(/"inSupportedLocation"\s*:\s*(false|true)/i, graph.rawBody || '').toLowerCase();
  if (!region) return res('disney', 'restricted', { reason: 'region_missing' });
  if (region === 'JP') return res('disney', 'available', { region });
  if (supported === 'false') return res('disney', 'partial', { region, detail: 'available_soon' });
  if (supported === 'true') return res('disney', 'available', { region });
  return res('disney', 'unknown', { region, reason: 'supported_location_' + supported });
}

async function checkYoutube(p) {
  const cookie = 'YSC=FSCWhKo2Zgw; VISITOR_PRIVACY_METADATA=CgJERRIEEgAgYQ%3D%3D; PREF=f7=4000; __Secure-YEC=CgtRWTBGTFExeV9Iayjele2yBjIKCgJERRIEEgAgYQ%3D%3D; SOCS=CAISOAgDEitib3FfaWRlbnRpZnlmcm9udGVuZHVpc2VydmVyXzIwMjQwNTI2LjAxX3AwGgV6aC1DTiACGgYIgMnpsgY; VISITOR_INFO1_LIVE=Di84mAIbgKY; __Secure-BUCKET=CGQ';
  const r = await probeRequest(p.port, 'https://www.youtube.com/premium', { headers: { Cookie: cookie }, bodyLimit: 1024 * 1024 });
  if (r.error) return res('youtube_premium', 'error', { reason: r.error });
  if (r.status >= 200 && r.status < 400) {
    if (/www\.google\.cn/.test(r.body)) return res('youtube_premium', 'restricted', { region: 'CN', reason: 'google_cn' });
    if (/premium is not available in your country/.test(r.body)) return res('youtube_premium', 'unsupported', { reason: 'unsupported_country' });
    const region = extract(/"INNERTUBE_CONTEXT_GL"\s*:\s*"([^"]+)"/i, r.rawBody || '').toUpperCase();
    if (/ad-free/.test(r.body)) return res('youtube_premium', 'available', { region });
    return res('youtube_premium', 'unknown', { region, reason: 'page_marker_missing' });
  }
  return res('youtube_premium', 'unknown', { reason: 'status_' + r.status });
}

async function checkOpenai(p) {
  const a = await probeRequest(p.port, 'https://api.openai.com/compliance/cookie_requirements', {
    headers: { Accept: '*/*', Authorization: 'Bearer null', 'Content-Type': 'application/json', Origin: 'https://platform.openai.com', Referer: 'https://platform.openai.com/' },
  });
  if (a.error) return res('openai', 'error', { reason: a.error });
  const b = await probeRequest(p.port, 'https://ios.chat.openai.com/', { headers: { Accept: '*/*;q=0.8,application/signed-exchange;v=b3;q=0.7' } });
  if (b.error) return res('openai', 'error', { reason: b.error });
  const aBlocked = /unsupported_country/.test(a.body), bBlocked = /vpn/.test(b.body);
  if (!aBlocked && !bBlocked) return res('openai', 'available');
  if (aBlocked && bBlocked) return res('openai', 'restricted', { reason: 'unsupported_country' });
  return res('openai', 'partial', { detail: !aBlocked && bBlocked ? 'web_only' : 'mobile_app_only' });
}

async function checkGemini(p) {
  if (p.landingCountry === 'CN') return res('gemini', 'restricted', { region: 'CN', reason: 'workspace_only_region' });
  const r = await probeRequest(p.port, 'https://gemini.google.com/', { bodyLimit: 1024 * 1024 });
  if (r.error) return res('gemini', 'error', { reason: r.error });
  if (r.status >= 200 && r.status < 400) {
    if (/\\?"45631641\\?":true/.test(r.rawBody || '')) return res('gemini', 'available');
    const restricted = /gemini (isn't|is not) available in your (country|region)|not available in your (country|region)/i.test(r.body);
    return res('gemini', 'restricted', { reason: restricted ? 'region_blocked' : 'gemini_marker_missing' });
  }
  if (r.status === 403) return res('gemini', 'restricted', { reason: 'status_403' });
  return res('gemini', 'unknown', { reason: 'status_' + r.status });
}

async function checkClaude(p) {
  const r = await probeRequest(p.port, 'https://claude.ai/');
  if (r.error) return res('claude', 'error', { reason: r.error });
  const finalUrl = String(r.url || '').trim().toLowerCase().replace(/\/+$/, '');
  if (finalUrl === 'https://claude.ai') return res('claude', 'available');
  if (finalUrl === 'https://www.anthropic.com/app-unavailable-in-region') return res('claude', 'restricted', { reason: 'app_unavailable_in_region' });
  if (r.status === 403) return res('claude', 'restricted', { reason: 'status_403' });
  return res('claude', 'unknown', { reason: r.status >= 200 && r.status < 400 ? 'unexpected_final_url' : 'status_' + r.status });
}

async function checkBahamut(p) {
  const H = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  };
  let cookies = '';
  const fetchB = async (url) => {
    const r = await probeRequest(p.port, url, { headers: Object.assign({}, H, cookies ? { Cookie: cookies } : {}) });
    if (r.headers && r.headers['set-cookie']) cookies = [].concat(r.headers['set-cookie']).map((c) => String(c).split(';')[0]).join('; ');
    return r;
  };
  const dev = await fetchB('https://ani.gamer.com.tw/ajax/getdeviceid.php');
  if (dev.error) return res('bahamut', 'error', { reason: dev.error });
  let deviceId = '';
  try { deviceId = JSON.parse(dev.rawBody || '').deviceid || ''; } catch (e) {}
  if (/^\s*</.test(dev.rawBody || '')) return res('bahamut', 'unsupported', { reason: 'not_available' });
  const tokenUrl = (sn) => 'https://ani.gamer.com.tw/ajax/token.php?adID=89422&sn=' + sn + '&device=' + encodeURIComponent(deviceId);
  const lenient = await fetchB(tokenUrl('37783'));
  if (lenient.error) return res('bahamut', 'error', { reason: lenient.error });
  let ok = false; try { ok = !!JSON.parse(lenient.rawBody || '').animeSn; } catch (e) {}
  if (!ok) return res('bahamut', 'unsupported', { reason: 'region_unavailable' });
  const strict = await fetchB(tokenUrl('38832'));
  if (strict.error) return res('bahamut', 'error', { reason: strict.error });
  let tw = false; try { tw = !!JSON.parse(strict.rawBody || '').animeSn; } catch (e) {}
  if (tw) return res('bahamut', 'available', { region: 'TW' });
  const trace = await fetchB('https://ani.gamer.com.tw/cdn-cgi/trace');
  const m = /loc=([A-Za-z]{2})/.exec(trace.rawBody || '');
  if (m) return res('bahamut', 'available', { region: m[1].toUpperCase() });
  return res('bahamut', 'partial', { detail: 'primary_token_only' });
}

const CHECKERS = {
  netflix: checkNetflix, disney: checkDisney, youtube_premium: checkYoutube,
  openai: checkOpenai, gemini: checkGemini, claude: checkClaude, bahamut: checkBahamut,
};

// ---------- mihomo process manager (one process, all nodes) ----------
function controllerRequest(port, method, pathname, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: Object.assign({ Host: '127.0.0.1' }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      timeout: 3000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('controller timeout')));
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

// Live mihomo instances, so a server shutdown mid-check can kill the child
// instead of orphaning it (its temp dir goes with stop()).
const activeProxies = new Set();
function stopAllMihomo() { for (const m of [...activeProxies]) { try { m.stop(); } catch (e) {} } }

class MihomoProxy {
  constructor(binary, proxies, opts) {
    this.binary = binary;
    this.proxies = proxies;
    this.opts = opts || {};
    this.proc = null;
    this.dir = null;
    this.port = null;
    this.controller = null;
  }
  async start() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emos-unlock-'));
    this.port = 20000 + Math.floor(Math.random() * 15000);
    this.controller = this.port + 1;
    const cfg = buildMihomoConfig(this.proxies, this.port, this.controller);
    const cfgPath = path.join(this.dir, 'config.yaml');
    fs.writeFileSync(cfgPath, cfg, { mode: 0o600 });

    // Validate first: mihomo exits with code 2 on an invalid config, and a
    // bare "exited with 2" tells the operator nothing. `-t` prints the exact
    // yaml/field error to stderr; surface it instead of swallowing it.
    // Bound it: a binary that hangs on -t used to wedge the whole run
    // forever (no timeout), leaving the UI stuck on "检测中…" with no way
    // to tell. Kill it after 10s and fail loudly instead.
    const test = spawn(this.binary, ['-d', this.dir, '-t', '-f', cfgPath], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let testErr = '';
    if (test.stderr) test.stderr.on('data', (c) => { testErr += c.toString(); if (testErr.length > 4000) testErr = testErr.slice(-4000); });
    if (test.stdout) test.stdout.on('data', (c) => { testErr += c.toString(); if (testErr.length > 4000) testErr = testErr.slice(-4000); });
    let testTimedOut = false;
    const testTimer = setTimeout(() => {
      testTimedOut = true;
      try { test.kill('SIGKILL'); } catch (e) {}
    }, 10000);
    const testCode = await new Promise((resolve) => {
      test.on('error', (e) => { clearTimeout(testTimer); testErr += e.message; resolve(-1); });
      test.on('close', (code) => { clearTimeout(testTimer); resolve(code); });
    });
    if (testTimedOut) {
      throw new Error('mihomo config test timed out after 10s — the binary did not exit on -t (hung or incompatible)');
    }
    if (testCode !== 0) {
      throw new Error('mihomo config invalid (exit ' + testCode + '): ' + (testErr.trim().slice(0, 600) || 'no details'));
    }

    this.proc = spawn(this.binary, ['-d', this.dir, '-f', cfgPath], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    activeProxies.add(this);
    // Keep stderr so a startup failure reports the real reason (port clash,
    // bad field, missing geo data) rather than just an exit code.
    let stderr = '';
    this.proc.stderr.on('data', (c) => { stderr += c.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    for (let i = 0; i < 60; i++) {
      if (this.proc.exitCode !== null) throw new Error('mihomo exited with ' + this.proc.exitCode + ': ' + (stderr.trim() || 'no stderr'));
      const ok = await new Promise((resolve) => {
        const s = net.connect(this.port, '127.0.0.1');
        s.setTimeout(300);
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('error', () => { s.destroy(); resolve(false); });
        s.on('timeout', () => { s.destroy(); resolve(false); });
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('mihomo failed to start within 9s: ' + (stderr.trim() || 'no stderr'));
  }
  // Select which proxy the PROXY group routes through.
  async select(name) {
    const r = await controllerRequest(this.controller, 'PUT', '/proxies/PROXY', { name });
    return r.status === 200 || r.status === 204;
  }
  stop() {
    activeProxies.delete(this);
    if (this.proc && this.proc.exitCode === null) { try { this.proc.kill('SIGTERM'); } catch (e) {} }
    this.proc = null;
    if (this.dir) { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (e) {} }
    this.dir = null;
  }
}

// The egress IP this node exits from, as seen by an IP-echo service
// through the same proxy. Different nodes in different places should show
// different IPs; if they don't, the nodes share an egress (or a link).
// `url` is only overridden in tests (a local plain-HTTP echo server).
async function checkEgressIp(port, url) {
  try {
    const r = await probeRequest(port, url || 'https://api.ipify.org/', { timeout: 5000, bodyLimit: 64 });
    if (r.error) return null;
    const ip = String(r.body || '').trim();
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || /^[0-9a-fA-F:]{3,45}$/.test(ip)) return ip;
    return null;
  } catch (e) { return null; }
}

// Probe every provider for a single node. Caller must have selected the node
// in the shared mihomo instance (see runUnlockCheck). The 7 providers are
// independent (different services, read-only shared state), so they run in
// parallel — a full node finishes in ~one checker instead of the sum of all.
async function checkNodeOnProxy(port, node, opts) {
  const p = { port, landingCountry: String(node.region || node.country || '').toUpperCase().slice(0, 2) };
  const [entries, ip] = await Promise.all([
    Promise.all(PROVIDERS.map(async (provider) => {
      try { return [provider, await CHECKERS[provider](p)]; }
      catch (e) { return [provider, res(provider, 'error', { reason: e.message })]; }
    })),
    checkEgressIp(port),
  ]);
  return { providers: Object.fromEntries(entries), ip: ip || null, updatedAt: new Date().toISOString() };
}

// Full check: one mihomo process, iterate nodes by selecting each in turn.
// onProgress(key, status, result) is optional for live UI updates.
async function runUnlockCheck(nodes, binary, opts) {
  opts = opts || {};
  const out = {};
  const usable = [];
  for (const n of nodes) {
    const proxy = n.link ? linkToProxy(n.link, n.key) : null;
    if (!proxy) {
      out[n.key] = { error: n.link ? 'unsupported_link' : 'no_link', updatedAt: new Date().toISOString() };
      if (opts.onProgress) opts.onProgress(n.key, 'error', out[n.key]);
      continue;
    }
    usable.push({ node: n, proxy });
  }
  if (!usable.length) return out;
  const mihomo = new MihomoProxy(binary, usable.map((x) => x.proxy), opts);
  try {
    // Startup phase: -t validation + process spawn can take seconds and used
    // to be invisible (the UI just said "检测中…"). Report it so a stall
    // here is distinguishable from a stall on a node.
    if (opts.onProgress) opts.onProgress(null, 'starting');
    await mihomo.start();
    if (opts.onProgress) opts.onProgress(null, 'started');
    for (const { node } of usable) {
      if (opts.onProgress) opts.onProgress(node.key, 'checking');
      const selected = await mihomo.select(node.key);
      if (!selected) {
        out[node.key] = { error: 'proxy_select_failed', updatedAt: new Date().toISOString() };
        if (opts.onProgress) opts.onProgress(node.key, 'error', out[node.key]);
        continue;
      }
      out[node.key] = await checkNodeOnProxy(mihomo.port, node, opts);
      if (opts.onProgress) opts.onProgress(node.key, 'done', out[node.key]);
    }
  } catch (e) {
    for (const { node } of usable) {
      if (!out[node.key]) out[node.key] = { error: e.message, updatedAt: new Date().toISOString() };
    }
  } finally {
    mihomo.stop();
  }
  return out;
}

module.exports = {
  PROVIDERS, linkToProxy, yamlProxyEntry, buildMihomoConfig, probeRequest, checkNodeOnProxy, checkEgressIp, runUnlockCheck, MihomoProxy, stopAllMihomo,
  checkNetflix, checkDisney, checkYoutubePremium: checkYoutube, checkOpenai, checkGemini, checkClaude, checkBahamut,
};
