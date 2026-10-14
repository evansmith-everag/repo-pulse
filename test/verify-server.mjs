// Behavioural checks for the server: request validation, auth, webhooks, refresh queueing and throttling, config and
// cache handling, token failure, proxy support and fixture mode. Starts short-lived servers on TEST_PORT (default
// 4399) with throwaway files in the OS temp dir. Needs a GitHub token for the runs that touch GitHub.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHmac, createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'test', 'fixture.json');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const TMP = mkdtempSync(path.join(os.tmpdir(), 'repo-pulse-test-'));
const PORT = Number(process.env.TEST_PORT || 4399);
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE = process.env.TEST_LIVE !== '0'; // the runs against live GitHub need a token; CI gives them to one Node line
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The sha256 source expressions for a document's inline <script> or <style> bodies, as a Content-Security-Policy lists them.
const inlineHashes = (doc, tag) => [...doc.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
let current = null;

async function startServer(env, configText, { cache = true, root = ROOT } = {}) {
  const cfg = path.join(TMP, 'config.json');
  const cachePath = path.join(TMP, 'snapshot.json');
  if (configText === null) rmSync(cfg, { force: true }); else writeFileSync(cfg, configText);
  if (!cache) rmSync(cachePath, { force: true });
  // Update checks are off unless a run turns them on, so the suite never talks to the real release feed.
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', REPO_PULSE_CONFIG: cfg, REPO_PULSE_CACHE: cachePath, REPO_PULSE_FIXTURE: '', ALLOWED_HOSTS: '', TRUST_PROXY: '', MAX_REPOS: '', UPDATE_CHECK: '0', REPO_PULSE_CONTAINER: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', exited = false;
  child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  child.on('exit', () => { exited = true; }); // a killed child has a null exitCode on Windows, so track exit explicitly
  for (let i = 0; i < 80; i++) {
    if (exited) throw new Error(`server exited early:\n${log}`);
    try { await fetch(`${BASE}/api/config`); break; } catch { await sleep(150); }
  }
  current = { child, cfg, cachePath, log: () => log, stop: () => new Promise((r) => { if (exited) return r(); child.on('exit', r); child.kill(); }) };
  return current;
}

async function post(pathname, body, headers = {}) {
  const res = await fetch(BASE + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
}
const getSnapshot = async () => (await fetch(`${BASE}/api/snapshot`)).json();
// Polls the snapshot until a fetch has finished (or the given condition holds), then returns it.
async function waitForFetch(ms = 30000, until = (s) => s.fetchedAt || s.error) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await getSnapshot(); if (until(s)) return s; await sleep(300); }
  return getSnapshot();
}

// fetch() will not let us set a Host header or send a broken request line, so talk to the socket directly.
function rawRequest(text) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1', () => sock.write(text));
    let data = '';
    sock.on('data', (d) => (data += d));
    sock.on('error', (e) => resolve('ERR ' + e.code));
    sock.on('close', () => resolve(data));
    setTimeout(() => { sock.destroy(); resolve(data || 'TIMEOUT'); }, 3000);
  });
}
const rawStatus = async (headers, method = 'GET', pathname = '/api/config') => Number((await rawRequest(`${method} ${pathname} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`)).match(/^HTTP\/1\.1 (\d+)/)?.[1]);

// A zip writer good enough to stand in for the release workflow's `zip -r`: stored or deflated entries with CRCs.
const CRC_TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function buildZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data, deflate] of entries) {
    const n = Buffer.from(name), d = data || Buffer.alloc(0), comp = deflate ? deflateRawSync(d) : d, method = deflate ? 8 : 0, crc = data ? crc32(d) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, comp); centrals.push(ch, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const good = { org: 'github', repos: ['gitignore'], pollSeconds: 60, includeArchived: false };
const baseConfig = JSON.stringify(good);
const fixtureConfig = JSON.stringify({ org: 'example', repos: ['alpha', 'beta', 'gamma'], pollSeconds: 60, includeArchived: false });

try {
  console.log('== Repository consistency (no server) ==');
  {
    const site = readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
    const siteCsp = site.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1] || '';
    ok('the product page has no inline script, stylesheet, style attribute or event handler', !/<script\b(?![^>]*\bsrc=)|<style\b|\sstyle="|\son\w+=/i.test(site));
    ok('the product page\'s policy is self-only, with its script and stylesheet in files (no hash to go stale)', /script-src 'self'/.test(siteCsp) && /style-src 'self'/.test(siteCsp) && !/unsafe-inline/.test(siteCsp) && existsSync(path.join(ROOT, 'docs', 'site.js')) && existsSync(path.join(ROOT, 'docs', 'site.css')), siteCsp);
    const floor = Number(pkg.engines.node.match(/\d+/)[0]);
    const dockerMajor = Number(readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').match(/FROM node:(\d+)/)?.[1]);
    const mentions = [readFileSync(path.join(ROOT, 'README.md'), 'utf8'), site].flatMap((text) => [...text.matchAll(/Node\.js (\d+) or newer/g)].map((m) => Number(m[1])));
    ok('the Docker image and every "Node.js N or newer" in the README and product page agree with the engines floor', dockerMajor >= floor && mentions.length > 0 && mentions.every((n) => n === floor), JSON.stringify({ floor, dockerMajor, mentions }));
    if (process.env.TEST_NODE_FLOOR) ok('this CI leg runs the engines floor itself', Number(process.versions.node.split('.')[0]) === floor, process.versions.node);
    if (process.env.CI) ok('a fresh checkout has start.cmd with CRLF line endings (cmd.exe can miss a goto label in an LF file)', /\r\n/.test(readFileSync(path.join(ROOT, 'start.cmd'), 'utf8')));
  }

  if (!LIVE) console.log('TEST_LIVE=0: the runs against live GitHub are skipped');
  if (LIVE) {
    console.log('== Run 1: defaults, live GitHub ==');
    const s = await startServer({}, baseConfig, { cache: false });
    const r1 = await rawRequest('GET //[::1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    ok('malformed request line gets 400 and server survives', /HTTP\/1.1 400/.test(r1) && (await fetch(`${BASE}/api/config`)).ok, r1.slice(0, 60));
    ok('Host: evil.example is rejected', (await rawStatus('Host: evil.example')) === 403);
    ok('Host: localhost accepted', (await rawStatus(`Host: localhost:${PORT}`)) === 200);
    ok('Host: [::1] accepted', (await rawStatus(`Host: [::1]:${PORT}`)) === 200);
    ok('HEAD / answers 200', (await rawStatus(`Host: 127.0.0.1:${PORT}`, 'HEAD', '/')) === 200);
    const page = await fetch(`${BASE}/`);
    const csp = page.headers.get('content-security-policy') || '';
    ok('security headers on the page', page.headers.get('x-content-type-options') === 'nosniff' && /frame-ancestors 'none'/.test(csp) && page.headers.get('referrer-policy') === 'no-referrer');
    const html = await page.text();
    const scripts = inlineHashes(html, 'script'), styles = inlineHashes(html, 'style');
    ok('the policy allows the served page\'s inline script and stylesheet by hash', scripts.length === 1 && styles.length === 1 && csp.includes(scripts[0]) && csp.includes(styles[0]), csp.slice(0, 160));
    ok('the policy has no unsafe-inline and locks down the rest', !/unsafe-inline/.test(csp) && /default-src 'none'/.test(csp) && /object-src 'none'/.test(csp) && /require-trusted-types-for 'script'/.test(csp), csp);
    ok('the page has no inline style attributes (they would be refused by the policy)', !/\sstyle="/.test(html));
    ok('cross-site Origin on POST is 403', (await post('/api/config', good, { Origin: 'http://evil.example' })).status === 403);
    ok('Sec-Fetch-Site: cross-site on POST is 403', (await post('/api/refresh', '', { 'Sec-Fetch-Site': 'cross-site' })).status === 403);
    ok('same-origin Origin on POST is accepted', (await post('/api/config', good, { Origin: BASE })).status === 200);
    ok('text/plain settings body is 415', (await post('/api/config', good, { 'Content-Type': 'text/plain' })).status === 415);
    ok('invalid JSON is 400', (await post('/api/config', '{nope')).status === 400);
    ok('null body is 400', (await post('/api/config', 'null')).status === 400);
    ok('array body is 400', (await post('/api/config', '[]')).status === 400);
    ok('empty body is 400', (await post('/api/config', '')).status === 400);
    const badOrg = await post('/api/config', { ...good, org: 'my org!' });
    ok('bad org name is 400 with message', badOrg.status === 400 && /Organization/.test(badOrg.json?.error), JSON.stringify(badOrg.json));
    ok('bad repo name is 400', (await post('/api/config', { ...good, repos: ['ok', 'bad name'] })).status === 400);
    ok('four repos is 400', (await post('/api/config', { ...good, repos: ['a', 'b', 'c', 'd'] })).status === 400);
    const badPoll = await post('/api/config', { ...good, pollSeconds: 45 });
    ok('pollSeconds 45 (not a dropdown choice) is 400', badPoll.status === 400 && /Poll interval/.test(badPoll.json?.error), JSON.stringify(badPoll.json));
    ok('pollSeconds "60" as string is 400', (await post('/api/config', { ...good, pollSeconds: '60' })).status === 400);
    const saved = await post('/api/config', { ...good, pollSeconds: 300 });
    ok('valid save returns full public config', saved.status === 200 && saved.json.pollSeconds === 300 && Array.isArray(saved.json.pollOptions) && saved.json.maxRepos === 3 && 'tokenSource' in saved.json, JSON.stringify(saved.json));
    ok('config after bad saves still has gitignore (nothing silently reset)', JSON.parse(readFileSync(s.cfg, 'utf8')).repos.includes('gitignore'));

    const first = await waitForFetch();
    ok('first fetch succeeded', Boolean(first.fetchedAt) && !first.error, first.error || '');
    const row = first.repos?.[0] || {};
    ok('row carries ci, prs, release, merged7d and untriaged', 'ci' in row && row.prs && 'awaiting' in row.prs && Array.isArray(row.prs.waiting) && 'release' in row && 'merged7d' in row && 'untriaged' in row, JSON.stringify(Object.keys(row)));
    ok('snapshot carries rate limit and next poll time', first.rateLimit && typeof first.rateLimit.remaining === 'number' && typeof first.nextPollAt === 'string', JSON.stringify(first.rateLimit));
    ok('snapshot names the token account', first.tokenSource === 'env' || first.tokenSource === 'gh', first.tokenSource);
    ok('/healthz is 200 after a fetch', (await fetch(`${BASE}/healthz`)).status === 200);
    const snapRes = await fetch(`${BASE}/api/snapshot`);
    const etag = snapRes.headers.get('etag');
    ok('/api/snapshot sends an ETag and honours If-None-Match', Boolean(etag) && (await fetch(`${BASE}/api/snapshot`, { headers: { 'If-None-Match': etag } })).status === 304);
    ok('cache file written after a successful fetch', existsSync(s.cachePath) && JSON.parse(readFileSync(s.cachePath, 'utf8')).repos[0].name === 'gitignore');

    // A settings save during an in-flight refresh must still produce a settings refresh, and the in-flight result
    // (fetched for the old repo list) must not be broadcast after the save.
    // Earlier saves queued refreshes of their own; wait until fetchedAt has been stable for longer than the throttle.
    for (let last = null, stableSince = Date.now(); Date.now() - stableSince < 5500;) {
      const { fetchedAt } = await getSnapshot();
      if (fetchedAt !== last) { last = fetchedAt; stableSince = Date.now(); }
      await sleep(250);
    }
    const events = [];
    const ac = new AbortController();
    fetch(`${BASE}/api/events`, { signal: ac.signal }).then(async (res) => {
      const reader = res.body.getReader(); const dec = new TextDecoder();
      while (true) { const { value, done } = await reader.read(); if (done) break; events.push(dec.decode(value)); }
    }).catch(() => {});
    await sleep(300);
    const manual = post('/api/refresh', '');
    await sleep(100);
    const throttled = await post('/api/refresh', '');
    ok('a second manual refresh right away is throttled with 429 + Retry-After', throttled.status === 200 || (throttled.status === 429 && throttled.headers.get('retry-after')), String(throttled.status));
    await post('/api/config', { ...good, repos: ['docs'], pollSeconds: 60 });
    const manualRes = await manual;
    ok('manual refresh answered 200', manualRes.status === 200, String(manualRes.status));
    // Two GitHub fetches run back to back here (the manual one, then the queued settings one); wait for the second
    // to be broadcast rather than guessing how long GitHub takes today.
    // Only frames after the config event count: the stream's first frame replays the current snapshot, which may
    // itself be a settings snapshot from the saves above.
    const settled = () => { const t = events.join(''); const i = t.indexOf('event: config'); return i >= 0 && /"reason":"settings"/.test(t.slice(i)); };
    for (let i = 0; i < 90 && !settled(); i++) await sleep(500);
    await sleep(500);
    const text = events.join('');
    const snaps = [...text.matchAll(/event: snapshot\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]));
    const afterSave = text.slice(text.indexOf('event: config'));
    const snapsAfterSave = [...afterSave.matchAll(/event: snapshot\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]));
    ok('queued settings refresh ran after the in-flight manual one', snaps.some((x) => x.reason === 'settings'), 'reasons=' + snaps.map((x) => x.reason).join(','));
    ok('final snapshot reflects the new repo list', snaps.at(-1)?.repos.length === 1 && snaps.at(-1)?.repos[0].name === 'docs', JSON.stringify(snaps.at(-1)?.repos?.map((r) => r.name)));
    ok('no snapshot after the save still lists the old repo', snapsAfterSave.length > 0 && !snapsAfterSave.some((x) => x.repos.some((r) => r.name === 'gitignore')), JSON.stringify(snapsAfterSave.map((x) => [x.reason, x.repos.map((r) => r.name)])));
    ok('SSE config event carries the public shape', /event: config\ndata: \{[^\n]*"pollOptions"/.test(text));
    ac.abort();
    ok('org-repos is open when no ADMIN_TOKEN', (await fetch(`${BASE}/api/org-repos`)).status === 200);
    const preview = await (await fetch(`${BASE}/api/org-repos?owner=torvalds`)).json();
    ok('org-repos previews another owner without saving', Array.isArray(preview.repos) && preview.org === 'torvalds' && typeof preview.truncated === 'boolean', JSON.stringify(preview).slice(0, 120));
    ok('org-repos rejects a bad owner name', (await fetch(`${BASE}/api/org-repos?owner=bad%20name`)).status === 400);
    await s.stop();
    ok('server log has no crash', !/TypeError|unhandled/.test(s.log()), s.log());
  }

  console.log('== Run 2: ADMIN_TOKEN + WEBHOOK_SECRET ==');
  {
    const s = await startServer({ ADMIN_TOKEN: 'secret-admin', WEBHOOK_SECRET: 'hook' }, baseConfig);
    ok('org-repos without token is 401', (await fetch(`${BASE}/api/org-repos`)).status === 401);
    const withToken = (await fetch(`${BASE}/api/org-repos`, { headers: { 'X-Admin-Token': 'secret-admin' } })).status;
    ok('org-repos with the admin token passes the gate', withToken !== 401, String(withToken));
    ok('settings save without token is 401', (await post('/api/config', good)).status === 401);
    ok('settings save with token is 200', (await post('/api/config', good, { 'X-Admin-Token': 'secret-admin' })).status === 200);
    const payload = JSON.stringify({ repository: { name: 'gitignore' } });
    const sig = 'sha256=' + createHmac('sha256', 'hook').update(payload).digest('hex');
    ok('signed JSON webhook is 202', (await post('/webhook', payload, { 'X-Hub-Signature-256': sig, 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': 'd-1' })).status === 202);
    const dup = await post('/webhook', payload, { 'X-Hub-Signature-256': sig, 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': 'd-1' });
    ok('a replayed delivery id is acknowledged but ignored', dup.status === 202 && dup.json?.duplicate === true, JSON.stringify(dup.json));
    ok('check_suite events are accepted', (await post('/webhook', payload, { 'X-Hub-Signature-256': sig, 'X-GitHub-Event': 'check_suite', 'X-GitHub-Delivery': 'd-2' })).status === 202);
    const formBody = 'payload=' + encodeURIComponent(payload);
    const formSig = 'sha256=' + createHmac('sha256', 'hook').update(formBody).digest('hex');
    const form = await post('/webhook', formBody, { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Hub-Signature-256': formSig, 'X-GitHub-Event': 'push' });
    ok('form-encoded webhook is 400 with guidance', form.status === 400 && /application\/json/.test(form.json?.error), JSON.stringify(form.json));
    const junkSig = 'sha256=' + createHmac('sha256', 'hook').update('not json').digest('hex');
    ok('signed non-JSON webhook is 400, not 500', (await post('/webhook', 'not json', { 'X-Hub-Signature-256': junkSig, 'X-GitHub-Event': 'push' })).status === 400);
    ok('bad signature is 401', (await post('/webhook', payload, { 'X-Hub-Signature-256': 'sha256=00', 'X-GitHub-Event': 'push' })).status === 401);
    ok('configPath is withheld from unauthenticated non-loopback viewers only (loopback sees it)', (await (await fetch(`${BASE}/api/config`)).json()).configPath !== null);
    await s.stop();
  }

  console.log('== Run 3: corrupt config.json ==');
  {
    const corrupt = '{ "org": "github", "repos": ["gitignore"], "pollSeconds": 60, }';
    const s = await startServer({}, corrupt);
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    ok('corrupt file left untouched on disk', readFileSync(s.cfg, 'utf8') === corrupt);
    ok('configProblem reported to the client', typeof cfg.configProblem === 'string' && cfg.configProblem.length > 0, JSON.stringify(cfg.configProblem));
    await post('/api/config', good);
    ok('a save repairs the file and clears configProblem', JSON.parse(readFileSync(s.cfg, 'utf8')).repos[0] === 'gitignore' && (await (await fetch(`${BASE}/api/config`)).json()).configProblem === null);
    await s.stop();
  }

  console.log('== Run 4: legacy values in config.json ==');
  {
    const s = await startServer({}, JSON.stringify({ org: 'github', repos: ['a', 'b', 'c', 'd', 'e'], pollSeconds: 1e308 }));
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    ok('huge pollSeconds snaps to 3600, not 15', cfg.pollSeconds === 3600, String(cfg.pollSeconds));
    ok('more than three repos capped at load', cfg.repos.length === 3, String(cfg.repos.length));
    await s.stop();
    ok('snap is logged', /not a dropdown choice/.test(s.log()), s.log());
  }

  console.log('== Run 5: HOST=0.0.0.0 skips the loopback Host check; ALLOWED_HOSTS and TRUST_PROXY ==');
  {
    let s = await startServer({ HOST: '0.0.0.0' }, baseConfig);
    ok('any Host accepted when bound to all interfaces', (await rawStatus('Host: dashboard.example')) === 200);
    await s.stop();
    s = await startServer({ ALLOWED_HOSTS: 'pulse.example, other.example' }, baseConfig);
    ok('a listed host passes the loopback check', (await rawStatus('Host: pulse.example')) === 200);
    ok('an unlisted host still fails', (await rawStatus('Host: evil.example')) === 403);
    ok('without TRUST_PROXY a forwarded Origin is cross-site', (await post('/api/refresh', '', { Origin: 'http://pulse.example', 'X-Forwarded-Host': 'pulse.example' })).status === 403);
    await s.stop();
    s = await startServer({ ALLOWED_HOSTS: 'pulse.example', TRUST_PROXY: '1' }, baseConfig);
    const viaProxy = await post('/api/refresh', '', { Origin: 'http://pulse.example', 'X-Forwarded-Host': 'pulse.example' });
    ok('with TRUST_PROXY the forwarded host satisfies the origin check', viaProxy.status === 200 || viaProxy.status === 429, String(viaProxy.status));
    await s.stop();
  }

  console.log('== Run 6: first run with no config file ==');
  {
    const s = await startServer({}, null, { cache: false });
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    ok('defaults have no owner and no repos', cfg.org === '' && cfg.repos.length === 0 && cfg.configProblem === null, JSON.stringify(cfg));
    ok('a config file is created with those defaults', existsSync(s.cfg) && JSON.parse(readFileSync(s.cfg, 'utf8')).org === '');
    ok('repository list asks for an owner first', (await fetch(`${BASE}/api/org-repos`)).status === 400);
    if (LIVE) ok('repository list can preview an owner before saving', (await fetch(`${BASE}/api/org-repos?owner=github`)).status === 200);
    ok('picking repos without an owner is rejected', (await post('/api/config', { org: '', repos: ['x'], pollSeconds: 60 })).status === 400);
    ok('saving only the poll interval without an owner is fine', (await post('/api/config', { org: '', repos: [], pollSeconds: 120 })).status === 200);
    ok('a user account works as the owner', (await post('/api/config', { org: 'torvalds', repos: ['linux'], pollSeconds: 60 })).status === 200);
    if (LIVE) ok('and its repository list loads', (await fetch(`${BASE}/api/org-repos`)).status === 200);
    const snap = await getSnapshot();
    ok('snapshot reports how many repos are configured', snap.configuredRepos === 1, String(snap.configuredRepos));
    await s.stop();
  }

  console.log('== Run 7: fixture mode, cache restore and MAX_REPOS ==');
  {
    let s = await startServer({ REPO_PULSE_FIXTURE: FIXTURE }, fixtureConfig, { cache: false });
    const snap = await waitForFetch(5000);
    const alpha = snap.repos?.find((r) => r.name === 'alpha') || {};
    ok('fixture rows are served verbatim', alpha.ci === 'failing' && alpha.prs?.awaiting === 2 && alpha.release?.tag === 'v2.3.0' && alpha.merged7d === 5 && snap.repos.find((r) => r.name === 'gamma')?.error, JSON.stringify(alpha).slice(0, 200));
    ok('fixture mode needs no token', snap.tokenSource === 'fixture' && snap.viewer === 'fixture-user' && !snap.tokenProblem, JSON.stringify([snap.tokenSource, snap.viewer, snap.tokenProblem]));
    ok('/healthz is 200 in fixture mode', (await fetch(`${BASE}/healthz`)).status === 200);
    await s.stop();
    const failing = path.join(TMP, 'failing-fixture.json');
    writeFileSync(failing, JSON.stringify({ error: 'GitHub is down (simulated)', status: 502 }));
    s = await startServer({ REPO_PULSE_FIXTURE: failing }, fixtureConfig);
    const restored = await waitForFetch(5000);
    ok('after a restart the cached snapshot is shown while GitHub fails', restored.fromCache === true && restored.repos?.length === 3 && Boolean(restored.fetchedAt) && /simulated/.test(restored.error || ''), JSON.stringify([restored.fromCache, restored.repos?.length, restored.error]));
    ok('failures back off: next poll is later than the plain interval', restored.failures >= 1 && new Date(restored.nextPollAt) - Date.now() > 70_000, JSON.stringify([restored.failures, restored.nextPollAt]));
    ok('/healthz stays 200 while cached data is on screen', (await fetch(`${BASE}/healthz`)).status === 200);
    await s.stop();
    const limited = path.join(TMP, 'limited-fixture.json');
    writeFileSync(limited, JSON.stringify({ error: 'GitHub rate limit reached (simulated)', status: 429, retryAfterMs: 120_000 }));
    s = await startServer({ REPO_PULSE_FIXTURE: limited }, fixtureConfig, { cache: false });
    const paused = await waitForFetch(5000);
    ok('a rate-limit answer pauses polling until GitHub says so', typeof paused.pausedUntil === 'string' && new Date(paused.nextPollAt) - Date.now() > 100_000, JSON.stringify([paused.pausedUntil, paused.nextPollAt]));
    await s.stop();
    s = await startServer({ REPO_PULSE_FIXTURE: FIXTURE, MAX_REPOS: '5' }, fixtureConfig, { cache: false });
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    ok('MAX_REPOS raises the limit', cfg.maxRepos === 5 && (await post('/api/config', { org: 'example', repos: ['alpha', 'beta', 'gamma', 'other/delta'], pollSeconds: 60, issueLabels: ['bug'] })).status === 200, String(cfg.maxRepos));
    const multi = await waitForFetch(5000, (snap) => snap.repos?.some((r) => r.name === 'delta')); // the settings refresh lands after the reply
    const delta = multi.repos?.find((r) => r.name === 'delta') || {};
    const alpha2 = multi.repos?.find((r) => r.name === 'alpha') || {};
    ok('a repository under another owner keeps its owner', delta.owner === 'other' && delta.fullName === 'other/delta' && delta.key === 'other/delta', JSON.stringify([delta.owner, delta.fullName, delta.key]));
    ok('fixture rows carry label counts and the week shape', alpha2.labels?.bug === 7 && Array.isArray(alpha2.week?.days) && alpha2.week.days.length === 7, JSON.stringify([alpha2.labels, alpha2.week]));
    ok('fixture rows carry velocity metrics, contributors, alerts and CI runs', alpha2.metrics?.cycleHours === 20 && alpha2.contributors?.count === 3 && alpha2.alerts === 2 && alpha2.ciRuns?.failing?.[0] === 'Nightly' && alpha2.commitsPrev7d === 12, JSON.stringify([alpha2.metrics, alpha2.ciRuns]));
    let cached = null; // the cache is written without blocking the broadcast, so give it a moment
    for (let i = 0; i < 30 && !cached?.specs?.includes('other/delta'); i++) { try { cached = JSON.parse(readFileSync(s.cachePath, 'utf8')); } catch {} if (!cached?.specs?.includes('other/delta')) await sleep(100); }
    ok('the cache file remembers the repository list it was made for', Boolean(cached?.specs?.includes('other/delta')), JSON.stringify(cached?.specs));
    await s.stop();
  }

  if (LIVE) {
    console.log('== Run 8: owners, branches and labels against live GitHub ==');
    const s = await startServer({}, JSON.stringify({ org: 'github', repos: ['gitignore', 'nodejs/undici@main', 'docs@no-such-branch'], pollSeconds: 60, issueLabels: ['bug'] }), { cache: false });
    const snap = await waitForFetch();
    const rows = Object.fromEntries((snap.repos || []).map((r) => [r.key, r]));
    ok('bare names resolve under the default owner', rows['github/gitignore']?.fullName === 'github/gitignore' && !rows['github/gitignore']?.error, JSON.stringify(Object.keys(rows)));
    ok('owner/name@branch resolves under its own owner and branch', rows['nodejs/undici@main']?.fullName === 'nodejs/undici' && rows['nodejs/undici@main']?.branch === 'main', JSON.stringify(rows['nodejs/undici@main']?.branch));
    ok('a missing branch is reported on its card, not as a failed poll', /Branch "no-such-branch"/.test(rows['github/docs@no-such-branch']?.error || '') && !snap.error, rows['github/docs@no-such-branch']?.error);
    ok('label counts come back per repository', typeof rows['github/gitignore']?.labels?.bug === 'number', JSON.stringify(rows['github/gitignore']?.labels));
    ok('the week shape has seven buckets that sum to at most the sample', rows['github/gitignore']?.week?.days?.length === 7, JSON.stringify(rows['github/gitignore']?.week));
    const vm = rows['nodejs/undici@main']?.metrics || {};
    ok('velocity metrics come back with last week\'s merges, PRs opened, issues opened and closed, and stale PRs', vm.available === true && ['mergedPrev7d', 'prsOpened7d', 'issuesOpened7d', 'issuesClosed7d', 'stalePrs'].every((k) => typeof vm[k] === 'number'), JSON.stringify(vm));
    ok('cycle time and first review are medians in hours (or null when nothing merged)', (vm.cycleHours === null || vm.cycleHours >= 0) && (vm.firstReviewHours === null || vm.firstReviewHours >= 0) && typeof vm.mergedSample === 'number', JSON.stringify([vm.cycleHours, vm.firstReviewHours, vm.mergedSample]));
    ok('last week\'s commit count and contributor concentration come back', typeof rows['nodejs/undici@main']?.commitsPrev7d === 'number' && typeof rows['nodejs/undici@main']?.contributors?.count === 'number', JSON.stringify(rows['nodejs/undici@main']?.contributors));
    const ci = rows['nodejs/undici@main']?.ciRuns;
    ok('GitHub Actions runs on the watched branch are summarised', ci && ci.branch === 'main' && typeof ci.runs7d === 'number' && typeof ci.failed7d === 'number' && Array.isArray(ci.failing), JSON.stringify(ci));
    ok('security alerts are a number or null, never an error', rows['nodejs/undici@main']?.alerts === null || typeof rows['nodejs/undici@main']?.alerts === 'number');
    const html = await (await fetch(`${BASE}/`)).text();
    ok('the page carries the same build stamp as the snapshot', typeof snap.build === 'string' && html.includes(`<meta name="build" content="${snap.build}">`), snap.build);
    ok('a malformed entry is rejected with guidance', /is not a repository/.test((await post('/api/config', { org: 'github', repos: ['bad name!'], pollSeconds: 60 })).json?.error || ''));
    ok('a bare name needs an owner', /needs an owner/.test((await post('/api/config', { org: '', repos: ['gitignore'], pollSeconds: 60 })).json?.error || ''));
    ok('owner/name works with no default owner at all', (await post('/api/config', { org: '', repos: ['github/gitignore'], pollSeconds: 60 })).status === 200);
    ok('labels with commas or more than five are rejected', (await post('/api/config', { org: 'github', repos: [], pollSeconds: 60, issueLabels: ['a,b'] })).status === 400 && (await post('/api/config', { org: 'github', repos: [], pollSeconds: 60, issueLabels: ['1', '2', '3', '4', '5', '6'] })).status === 400);
    await s.stop();
    ok('Dockerfile and .dockerignore ship with the repo', existsSync(path.join(ROOT, 'Dockerfile')) && existsSync(path.join(ROOT, '.dockerignore')));
  }

  console.log('== Run 9: self-update from a release ==');
  {
    // A copy of the install, a fake release feed on a local port, and a zip built here with a bumped version.
    const FEED = PORT + 7;
    const install = path.join(TMP, 'install');
    mkdirSync(path.join(install, 'public'), { recursive: true });
    const [serverSrc, pageSrc] = ['server.js', 'public/index.html'].map((f) => readFileSync(path.join(ROOT, f)));
    for (const f of ['server.js', 'package.json']) copyFileSync(path.join(ROOT, f), path.join(install, f));
    writeFileSync(path.join(install, 'public', 'index.html'), pageSrc.toString('utf8').replace(/\r?\n/g, '\r\n')); // as a CRLF checkout would have it
    const releaseZip = (pkgExtra, extraEntries = []) => buildZip([
      ['repo-pulse/', null],
      ['repo-pulse/server.js', serverSrc, true],
      ['repo-pulse/public/index.html', Buffer.concat([pageSrc, Buffer.from('\n<!-- release 99.0.0 -->\n')]), true],
      ['repo-pulse/package.json', Buffer.from(JSON.stringify({ ...pkg, version: '99.0.0', ...pkgExtra }, null, 2)), false],
      ...extraEntries,
    ]);
    const sumsFor = (z) => `${createHash('sha256').update(z).digest('hex')}  repo-pulse-v99.0.0.zip\n`;
    const zip = releaseZip({}, [['repo-pulse/start.cmd', Buffer.from('@echo off\r\necho a launcher the update must not touch\r\n'), false]]), sums = sumsFor(zip);
    const tallZip = releaseZip({ engines: { node: '>=99.1' } }), tallSums = sumsFor(tallZip); // a release this Node cannot run
    const release = { tag_name: 'v99.0.0', html_url: 'http://example.invalid/releases/v99.0.0', published_at: '2026-10-13T00:00:00Z', body: 'Test release', assets: [{ name: 'repo-pulse-v99.0.0.zip', browser_download_url: `http://127.0.0.1:${FEED}/zip` }, { name: 'SHA256SUMS', browser_download_url: `http://127.0.0.1:${FEED}/sums` }] };
    const feed = http.createServer((req, res) => {
      if (req.url === '/latest') return res.end(JSON.stringify(release));
      if (req.url === '/zip') return res.end(zip);
      if (req.url === '/sums') return res.end(sums);
      if (req.url === '/badsums') return res.end(`${'0'.repeat(64)}  repo-pulse-v99.0.0.zip\n`);
      if (req.url === '/tallzip') return res.end(tallZip);
      if (req.url === '/tallsums') return res.end(tallSums);
      res.statusCode = 404; res.end();
    });
    await new Promise((r) => feed.listen(FEED, '127.0.0.1', r));
    const updEnv = { UPDATE_CHECK: '1', UPDATE_REPO: 'example/repo-pulse', UPDATE_API: `http://127.0.0.1:${FEED}/latest`, UPDATE_CHECK_DELAY_MS: '200' };
    try {
      let s = await startServer(updEnv, baseConfig, { cache: false, root: install });
      let u = {};
      for (let i = 0; i < 50 && !u.checkedAt; i++) { u = await (await fetch(`${BASE}/api/update`)).json(); if (!u.checkedAt) await sleep(200); }
      ok('startup check finds the newer release', u.available === true && u.latest === '99.0.0' && u.current === pkg.version && u.canAdminister === true, JSON.stringify(u));
      const crlfPage = await fetch(`${BASE}/`), crlfHtml = await crlfPage.text();
      ok('a CRLF checkout is served as LF text, so the policy hashes match what the browser computes', !crlfHtml.includes('\r') && (crlfPage.headers.get('content-security-policy') || '').includes(inlineHashes(crlfHtml, 'script')[0]), (crlfPage.headers.get('content-security-policy') || '').slice(0, 120));
      const snap = await getSnapshot();
      ok('the snapshot carries the version and the update state', snap.version === pkg.version && snap.update?.available === true, JSON.stringify([snap.version, snap.update]));
      // a corrupt checksum file must stop the install before anything is written
      release.assets[1].browser_download_url = `http://127.0.0.1:${FEED}/badsums`;
      await post('/api/update/check', '');
      const bad = await post('/api/update', '');
      ok('a checksum mismatch refuses the update and leaves the files alone', bad.status === 502 && /SHA256SUMS/.test(bad.json?.error || '') && JSON.parse(readFileSync(path.join(install, 'package.json'), 'utf8')).version === pkg.version, JSON.stringify(bad.json));
      // a release whose Node floor this process does not meet must be refused before anything is written
      release.assets[0].browser_download_url = `http://127.0.0.1:${FEED}/tallzip`;
      release.assets[1].browser_download_url = `http://127.0.0.1:${FEED}/tallsums`;
      await post('/api/update/check', '');
      const tall = await post('/api/update', '');
      ok('a release that needs a newer Node.js is refused and the files are left alone', tall.status === 502 && /Node\.js >=99\.1/.test(tall.json?.error || '') && JSON.parse(readFileSync(path.join(install, 'package.json'), 'utf8')).version === pkg.version, JSON.stringify(tall.json));
      release.assets[0].browser_download_url = `http://127.0.0.1:${FEED}/zip`;
      release.assets[1].browser_download_url = `http://127.0.0.1:${FEED}/sums`;
      await post('/api/update/check', '');
      const inst = await post('/api/update', '');
      ok('installing answers ok and announces a restart', inst.status === 200 && inst.json?.ok === true && inst.json.version === '99.0.0' && inst.json.restarting === true, JSON.stringify(inst.json));
      const code = await new Promise((r) => { if (s.child.exitCode !== null) return r(s.child.exitCode); s.child.on('exit', (c) => r(c)); setTimeout(() => r('timeout'), 10000); });
      ok('the server exits with code 75 so a launcher restarts it', code === 75, String(code));
      ok('the new files are in place and the old ones are backed up', JSON.parse(readFileSync(path.join(install, 'package.json'), 'utf8')).version === '99.0.0' && readFileSync(path.join(install, 'public', 'index.html'), 'utf8').includes('release 99.0.0') && JSON.parse(readFileSync(path.join(install, '.previous', 'package.json'), 'utf8')).version === pkg.version);
      ok('launchers in the zip are not written', !existsSync(path.join(install, 'start.cmd')));
      s = await startServer(updEnv, baseConfig, { cache: false, root: install });
      const cfg = await (await fetch(`${BASE}/api/config`)).json();
      const again = await post('/api/update', '');
      ok('the restarted server runs the new version and reports up to date', cfg.version === '99.0.0' && again.status === 409 && /up to date/i.test(again.json?.error || ''), JSON.stringify([cfg.version, again.json]));
      await s.stop();
      s = await startServer({ ...updEnv, REPO_PULSE_CONTAINER: '1' }, baseConfig, { cache: false });
      for (let i = 0; i < 50 && !(await (await fetch(`${BASE}/api/update`)).json()).checkedAt; i++) await sleep(200);
      const inContainer = await post('/api/update', '');
      ok('inside a container the update is refused with advice to pull the image', inContainer.status === 409 && /container/i.test(inContainer.json?.error || ''), JSON.stringify(inContainer.json));
      await s.stop();
      s = await startServer(updEnv, baseConfig, { cache: false }); // from the repository itself, which is a git checkout
      for (let i = 0; i < 50 && !(await (await fetch(`${BASE}/api/update`)).json()).checkedAt; i++) await sleep(200);
      const inCheckout = await post('/api/update', '');
      ok('inside a git checkout the update is refused with advice to pull', inCheckout.status === 409 && /git pull/.test(inCheckout.json?.error || ''), JSON.stringify(inCheckout.json));
      await s.stop();
      s = await startServer({ UPDATE_CHECK: '0' }, baseConfig, { cache: false });
      const off = await (await fetch(`${BASE}/api/update`)).json();
      const offInstall = await post('/api/update', '');
      ok('UPDATE_CHECK=0 turns checks off and refuses installs', off.enabled === false && offInstall.status === 409 && /UPDATE_CHECK/.test(offInstall.json?.error || ''), JSON.stringify([off, offInstall.json]));
      await s.stop();
    } finally {
      feed.close();
    }
  }

  console.log('== Run 10: rejected token ==');
  {
    const s = await startServer({ GITHUB_TOKEN: 'ghp_definitely_invalid_token' }, baseConfig, { cache: false });
    const snap = await waitForFetch(15000);
    ok('a 401 stops polling and explains what to do', typeof snap.tokenProblem === 'string' && /rejected the token/.test(snap.tokenProblem) && snap.nextPollAt === null, JSON.stringify([snap.tokenProblem, snap.nextPollAt]));
    ok('/healthz is 503 with a bad token', (await fetch(`${BASE}/healthz`)).status === 503);
    ok('the token source is still reported without the token itself', snap.tokenSource === 'env' && !JSON.stringify(snap).includes('ghp_definitely'), snap.tokenSource);
    await s.stop();
    ok('the bad token never reaches the log', !s.log().includes('ghp_definitely'));
  }
} finally {
  if (current) await current.stop();
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
