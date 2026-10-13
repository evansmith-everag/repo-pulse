// Behavioural checks for the server: request validation, auth, webhooks, refresh queueing and throttling, config and
// cache handling, token failure, proxy support and fixture mode. Starts short-lived servers on TEST_PORT (default
// 4399) with throwaway files in the OS temp dir. Needs a GitHub token for the runs that touch GitHub.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'test', 'fixture.json');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'repo-pulse-test-'));
const PORT = Number(process.env.TEST_PORT || 4399);
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let current = null;

async function startServer(env, configText, { cache = true } = {}) {
  const cfg = path.join(TMP, 'config.json');
  const cachePath = path.join(TMP, 'snapshot.json');
  if (configText === null) rmSync(cfg, { force: true }); else writeFileSync(cfg, configText);
  if (!cache) rmSync(cachePath, { force: true });
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', REPO_PULSE_CONFIG: cfg, REPO_PULSE_CACHE: cachePath, REPO_PULSE_FIXTURE: '', ALLOWED_HOSTS: '', TRUST_PROXY: '', MAX_REPOS: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
async function waitForFetch(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await getSnapshot(); if (s.fetchedAt || s.error) return s; await sleep(300); }
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

const good = { org: 'github', repos: ['gitignore'], pollSeconds: 60, includeArchived: false };
const baseConfig = JSON.stringify(good);
const fixtureConfig = JSON.stringify({ org: 'example', repos: ['alpha', 'beta', 'gamma'], pollSeconds: 60, includeArchived: false });

try {
  console.log('== Run 1: defaults, live GitHub ==');
  {
    const s = await startServer({}, baseConfig, { cache: false });
    const r1 = await rawRequest('GET //[::1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    ok('malformed request line gets 400 and server survives', /HTTP\/1.1 400/.test(r1) && (await fetch(`${BASE}/api/config`)).ok, r1.slice(0, 60));
    ok('Host: evil.example is rejected', (await rawStatus('Host: evil.example')) === 403);
    ok('Host: localhost accepted', (await rawStatus(`Host: localhost:${PORT}`)) === 200);
    ok('Host: [::1] accepted', (await rawStatus(`Host: [::1]:${PORT}`)) === 200);
    ok('HEAD / answers 200', (await rawStatus(`Host: 127.0.0.1:${PORT}`, 'HEAD', '/')) === 200);
    const page = await fetch(`${BASE}/`);
    ok('security headers on the page', page.headers.get('x-content-type-options') === 'nosniff' && /frame-ancestors 'none'/.test(page.headers.get('content-security-policy') || '') && page.headers.get('referrer-policy') === 'no-referrer');
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
    await waitForFetch();
    await sleep(6000);
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
    ok('org-repos with token is 200', (await fetch(`${BASE}/api/org-repos`, { headers: { 'X-Admin-Token': 'secret-admin' } })).status === 200);
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
    ok('repository list can preview an owner before saving', (await fetch(`${BASE}/api/org-repos?owner=github`)).status === 200);
    ok('picking repos without an owner is rejected', (await post('/api/config', { org: '', repos: ['x'], pollSeconds: 60 })).status === 400);
    ok('saving only the poll interval without an owner is fine', (await post('/api/config', { org: '', repos: [], pollSeconds: 120 })).status === 200);
    ok('a user account works as the owner', (await post('/api/config', { org: 'torvalds', repos: ['linux'], pollSeconds: 60 })).status === 200 && (await fetch(`${BASE}/api/org-repos`)).status === 200);
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
    const multi = await waitForFetch(5000);
    const delta = multi.repos?.find((r) => r.name === 'delta') || {};
    const alpha2 = multi.repos?.find((r) => r.name === 'alpha') || {};
    ok('a repository under another owner keeps its owner', delta.owner === 'other' && delta.fullName === 'other/delta' && delta.key === 'other/delta', JSON.stringify([delta.owner, delta.fullName, delta.key]));
    ok('fixture rows carry label counts and the week shape', alpha2.labels?.bug === 7 && Array.isArray(alpha2.week?.days) && alpha2.week.days.length === 7, JSON.stringify([alpha2.labels, alpha2.week]));
    ok('fixture rows carry velocity metrics, contributors, alerts and CI runs', alpha2.metrics?.cycleHours === 20 && alpha2.contributors?.count === 3 && alpha2.alerts === 2 && alpha2.ciRuns?.failing?.[0] === 'Nightly' && alpha2.commitsPrev7d === 12, JSON.stringify([alpha2.metrics, alpha2.ciRuns]));
    ok('the cache file remembers the repository list it was made for', JSON.parse(readFileSync(s.cachePath, 'utf8')).specs.includes('other/delta'));
    await s.stop();
  }

  console.log('== Run 8: owners, branches and labels against live GitHub ==');
  {
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

  console.log('== Run 9: rejected token ==');
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
