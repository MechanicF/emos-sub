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
  env: { ...process.env, ADMIN_TOKEN: 'test-token', PORT: String(PORT) },
  stdio: 'ignore',
});
function get(p) {
  return new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
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
      const m = html.match(/<script>([\s\S]*?)<\/script>/);
      if (!m) throw new Error(p + ': no <script> found');
      const f = path.join(os.tmpdir(), 'emos-page-' + p.replace(/\//g, '_') + '.js');
      fs.writeFileSync(f, m[1]);
      try {
        execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
        console.log('OK   ' + p + ' served script parses (' + m[1].length + ' bytes)');
      } catch (e) {
        console.error('FAIL ' + p + ' served script does not parse:');
        console.error(e.stderr.toString());
        code = 1;
      }
    }
  } catch (e) { console.error('FAIL', e.message); code = 1; }
  srv.kill();
  process.exit(code);
})();
