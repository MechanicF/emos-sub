// Regression test: the / and /admin pages are JS template literals in server.js.
// A single-backslash escape (\n, \', \") inside them is eaten by the template
// literal, so the SERVED page script breaks while server.js still parses.
// This test boots the real server, fetches both pages, extracts <script> and
// runs node --check on exactly what the browser receives.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = 3109;
const srv = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, ADMIN_TOKEN: 'test-token', DEMO_ENABLED: '1', PORT: String(PORT) },
  stdio: 'ignore',
});
function get(p) {
  return new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d));
  }).on('error', rej));
}
function postJson(p, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d)));
    });
    req.on('error', rej); req.end(data);
  });
}
function getUA(p, ua) {
  return new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p, headers: { 'User-Agent': ua } }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d));
  }).on('error', rej));
}
(async () => {
  let code = 0;
  try {
    for (let i = 0; i < 50; i++) {
      try { await get('/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 200)); }
    }
    for (const p of ['/', '/admin']) {
      const html = await get(p);
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
    const auth = await postJson('/api/auth', { carrot: 600 });
    if (!auth.ok) throw new Error('/api/auth demo login failed: ' + JSON.stringify(auth));
    const clash = await get('/c/?token=' + encodeURIComponent(auth.sub_token) + '&client=clash');
    for (const needle of ['proxies:', 'proxy-groups:', 'rule-providers:', 'RULE-SET,BanAD', 'RULE-SET,ChinaDomain', 'GEOIP,CN', 'MATCH,', '🚀 节点选择', '🆎 AdBlock']) {
      if (!clash.includes(needle)) { console.error('FAIL clash output missing: ' + needle); code = 1; }
    }
    if (!code) console.log('OK   /c/?client=clash carries proxies + ACL4SSR providers/rules (' + clash.length + ' bytes)');
    const sb = JSON.parse(await get('/c/?token=' + encodeURIComponent(auth.sub_token) + '&client=sing-box'));
    if (!Array.isArray(sb.outbounds) || !sb.outbounds.length) { console.error('FAIL sing-box output has no outbounds'); code = 1; }
    else console.log('OK   /c/?client=sing-box parses, ' + sb.outbounds.length + ' outbounds');
    // One auto-adaptive link: /c/?token= with no client param sniffs UA.
    const auto = '/c/?token=' + encodeURIComponent(auth.sub_token);
    const asFlclash = await getUA(auto, 'FlClash/0.8.0 (Android)');
    if (!asFlclash.includes('proxy-groups:')) { console.error('FAIL /c/ with FlClash UA did not return Clash YAML'); code = 1; }
    else console.log('OK   /c/ + FlClash UA -> Clash YAML');
    const asSingbox = await getUA(auto, 'sing-box/1.12.0');
    try {
      const j = JSON.parse(asSingbox);
      if (!Array.isArray(j.outbounds) || !j.outbounds.length) throw new Error('no outbounds');
      console.log('OK   /c/ + sing-box UA -> JSON, ' + j.outbounds.length + ' outbounds');
    } catch (e) { console.error('FAIL /c/ with sing-box UA did not return JSON: ' + e.message); code = 1; }
    const asBrowser = await getUA(auto, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
    if (!asBrowser.includes('按客户端自动识别')) { console.error('FAIL /c/ with browser UA did not return chooser page'); code = 1; }
    else console.log('OK   /c/ + browser UA -> chooser page with single link');
    // Console shows one subscription link, not four per-client rows.
    const consoleHtml = await get('/');
    if (!consoleHtml.includes('id="subAuto"') || consoleHtml.includes('id="subSingbox"') || consoleHtml.includes('id="subClash"')) {
      console.error('FAIL console subscription section is not the single auto link'); code = 1;
    } else console.log('OK   console shows one auto-adaptive subscription link');
  } catch (e) { console.error('FAIL', e.message); code = 1; }
  srv.kill();
  process.exit(code);
})();
