// Drives the real page in a headless browser over the DevTools protocol (no dependencies: Node 22+ has a global
// WebSocket). Starts two servers of its own: one with a throwaway config that points at public GitHub repositories
// (for the Settings flow) and one in fixture mode (for deterministic cards). Your own config.json is never read or
// changed. Needs a GitHub token and Edge or Chrome (or set REPO_PULSE_BROWSER to the browser executable).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'repo-pulse-ui-'));
const PORT = Number(process.env.TEST_PORT || 4399);
const FIX_PORT = PORT + 1;
const DBG = Number(process.env.TEST_DEBUG_PORT || 9333);
const APP = `http://127.0.0.1:${PORT}`;
const FIX = `http://127.0.0.1:${FIX_PORT}`;
const BROWSERS = [
  process.env.REPO_PULSE_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter((p) => p && existsSync(p));
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!BROWSERS.length) { console.log('No Edge or Chrome found. Set REPO_PULSE_BROWSER to the browser executable.'); process.exit(2); }
const browserPath = BROWSERS[0];
// Chrome's new headless mode fails on some Windows setups; its old mode works there, and Edge's new mode works everywhere.
const headlessFlag = process.platform === 'win32' && /chrome/i.test(path.basename(browserPath)) ? '--headless' : '--headless=new';

// Public repositories any token can see, with the maximum number picked so the limit behaviour is exercised.
const LIVE = { org: 'github', repos: ['gitignore', 'docs', 'choosealicense.com'], pollSeconds: 60, includeArchived: false };
const FIXTURE_CFG = { org: 'example', repos: ['alpha', 'beta', 'gamma', 'other/delta@release/2.x'], pollSeconds: 60, includeArchived: false, issueLabels: ['bug'] };
const liveCfg = path.join(TMP, 'config.json');
const fixCfg = path.join(TMP, 'fixture-config.json');
writeFileSync(liveCfg, JSON.stringify(LIVE));
writeFileSync(fixCfg, JSON.stringify(FIXTURE_CFG));
const serverEnv = { ...process.env, HOST: '127.0.0.1', ADMIN_TOKEN: '', WEBHOOK_SECRET: '', ALLOWED_HOSTS: '', TRUST_PROXY: '', MAX_REPOS: '' };
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...serverEnv, PORT: String(PORT), REPO_PULSE_CONFIG: liveCfg, REPO_PULSE_CACHE: path.join(TMP, 'live-cache.json'), REPO_PULSE_FIXTURE: '' }, stdio: 'ignore' });
const fixServer = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...serverEnv, PORT: String(FIX_PORT), REPO_PULSE_CONFIG: fixCfg, REPO_PULSE_CACHE: path.join(TMP, 'fix-cache.json'), REPO_PULSE_FIXTURE: path.join(ROOT, 'test', 'fixture.json'), MAX_REPOS: '4' }, stdio: 'ignore' });
// --disable-dev-shm-usage keeps Chromium alive in containers with a tiny /dev/shm; --remote-allow-origins lets a
// non-browser client open the DevTools socket. The browser's own output is kept so a failure to start explains itself.
const browser = spawn(browserPath, [headlessFlag, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-allow-origins=*', `--remote-debugging-port=${DBG}`, `--user-data-dir=${path.join(TMP, 'profile')}`, '--window-size=1280,1000', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browserLog = '';
browser.stdout.on('data', (d) => (browserLog += d));
browser.stderr.on('data', (d) => (browserLog += d));
let ws = null;

try {
  for (const base of [APP, FIX]) for (let i = 0; i < 80; i++) { try { await fetch(`${base}/api/config`); break; } catch { await sleep(150); } }
  const initial = await (await fetch(`${APP}/api/config`)).json();
  const N = initial.repos.length;

  let target, lastProblem = '';
  for (let i = 0; i < 300; i++) { // up to a minute: a cold CI runner starts the browser slowly
    try {
      const list = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
      lastProblem = `no page target among ${list.map((t) => t.type).join(',') || 'none'}`;
      if (i % 25 === 0) await fetch(`http://127.0.0.1:${DBG}/json/new?about:blank`, { method: 'PUT' }).catch(() => {});
    } catch (err) { lastProblem = err.message; }
    if (browser.exitCode !== null) break;
    await sleep(200);
  }
  if (!target) throw new Error(`could not attach to ${browserPath} on port ${DBG} (${lastProblem}; exit code ${browser.exitCode}). Browser output:\n${browserLog.split('\n').slice(-20).join('\n')}`);

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0; const waiting = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } };
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  // Snippets run in the page's global scope, so use `var` (or expressions) rather than top-level `const`/`let`.
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };
  const until = async (expression, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evalJs(expression)) return true; await sleep(200); } return false; };
  const text = (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? null`);
  const hidden = (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)})?.hidden ?? null`);
  const chips = () => evalJs(`document.querySelectorAll('#selected button').length`);
  const nav = async (url) => { await send('Page.navigate', { url }); await sleep(400); };

  await send('Page.enable');

  console.log('== Fixture dashboard ==');
  await nav(`${FIX}/`);
  ok('cards render from the fixture', await until(`document.querySelectorAll('.card').length === 4`));
  ok('a repository under another owner shows its owner', (await evalJs(`[...document.querySelectorAll('.card .repo-link')].map(a => a.textContent.replace(/\\s*\\(opens.*$/, '')).join('|')`)) === 'alpha|beta|gamma|other/delta', await evalJs(`[...document.querySelectorAll('.card .repo-link')].map(a => a.textContent).join('|')`));
  ok('a watched branch shows in the checks chip', (await evalJs(`document.querySelectorAll('.card')[3].querySelector('.chip')?.textContent`)) === 'release/2.x ● passing');
  ok('the week shape renders as seven bars', (await evalJs(`document.querySelector('.card.ci-failing .spark')?.querySelectorAll('rect').length`)) === 7);
  ok('label counts appear in the counts line', /7 bug/.test(await evalJs(`document.querySelectorAll('.card.ci-failing .meta')[1].textContent`)));
  ok('failing checks mark the card and chip', await evalJs(`document.querySelector('.card.ci-failing .chip.bad')?.textContent`) === 'main ● failing');
  ok('needs-review tile shows the count and the oldest age', /^2/.test(await text('.card.ci-failing .stat b')) && /oldest 12d/.test(await text('.card.ci-failing .stat .sub')), await text('.card.ci-failing .stat .sub'));
  ok('release appears in the meta line', /release v2\.3\.0/.test(await text('.card.ci-failing .meta')), await text('.card.ci-failing .meta'));
  ok('counts line lists approved, changes, drafts and untriaged', /1 approved · 1 changes requested · 1 draft · 42 issues open · 3 untriaged/.test(await evalJs(`document.querySelectorAll('.card.ci-failing .meta')[1].textContent`)));
  ok('oldest-open list has three PRs with state chips', (await evalJs(`document.querySelectorAll('.card.ci-failing .waiting li:not(.caption)').length`)) === 3 && (await evalJs(`[...document.querySelectorAll('.card.ci-failing .waiting .chip')].map(c => c.textContent).join('|')`)) === 'Needs review|Approved|Changes requested');
  ok('first-time contributor is marked', /first PR here/.test(await evalJs(`document.querySelectorAll('.card.ci-failing .waiting .who')[1].textContent`)));
  ok('a quiet repo gets the Quiet chip and no Active chip', (await evalJs(`[...document.querySelectorAll('.card')[1].querySelectorAll('.chip')].map(c => c.textContent).join('|')`)) === 'main ● passing|Quiet');
  ok('an unavailable repo is labelled', (await evalJs(`document.querySelectorAll('.card')[2].querySelector('.chip')?.textContent`)) === 'Unavailable');
  ok('bot commits are hidden by default', !/dependabot/.test(await text('#feed-body')));
  ok('status strip shows relative and absolute update time plus API budget', /^Updated \d+s ago \(.*\d{4}.*\d:\d\d:\d\d/.test(await text('#updated')) && /API 4,321 left/.test(await text('#budget')), await text('#updated'));
  ok('document title names the owner', (await evalJs('document.title')) === 'Repo Pulse · example', await evalJs('document.title'));
  ok('each card is a heading for screen readers', (await evalJs(`document.querySelectorAll('.card h2').length`)) === 4);

  // auto-reload: a snapshot with a different build id reloads the page (stubbed here) unless Settings has edits
  await evalJs(`window.__reloaded = 0; reloadPage = () => { window.__reloaded++; }; sessionStorage.removeItem('repo-pulse:reloaded-for'); handleSnapshot({ ...snap, build: 'test.newer' });`);
  ok('a newer build id from the server reloads the page', (await evalJs(`window.__reloaded`)) === 1);
  ok('the same newer build is not reloaded for twice (no loop)', (await evalJs(`handleSnapshot({ ...snap, build: 'test.newer' }); window.__reloaded`)) === 1 && !(await hidden('#update-note')));
  await evalJs(`sessionStorage.removeItem('repo-pulse:reloaded-for'); document.getElementById('update-note').hidden = true; newerBuild = null;`);
  ok('the page has a main landmark and a live announcer', (await evalJs(`Boolean(document.querySelector('main') && document.getElementById('announce').getAttribute('aria-live'))`)));

  // stale state: age the stamp and run the ticker
  await evalJs(`snap.fetchedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); drawNotice(); tickAges();`);
  ok('stale data shows an amber notice and dims the cards', !(await hidden('#notice')) && /Data is 20m old/.test(await text('#notice')) && (await evalJs(`document.body.classList.contains('stale') && document.getElementById('updated').classList.contains('stale')`)), await text('#notice'));

  // pause and resume
  await evalJs(`document.getElementById('pause').click()`);
  ok('pause toggles aria-pressed and label', (await evalJs(`document.getElementById('pause').getAttribute('aria-pressed')`)) === 'true' && /Resume/.test(await text('#pause')));
  await evalJs(`document.getElementById('pause').click()`);
  ok('resume restores the button', (await evalJs(`document.getElementById('pause').getAttribute('aria-pressed')`)) === 'false');

  // keyboard shortcut and theme preference
  await evalJs(`document.body.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }))`);
  ok('"s" opens Settings', !(await hidden('#view-settings')));
  await evalJs(`var t = document.getElementById('pref-theme'); t.value = 'dark'; t.dispatchEvent(new Event('change'));`);
  ok('theme preference applies and persists', (await evalJs(`document.documentElement.dataset.theme`)) === 'dark' && /"theme":"dark"/.test(await evalJs(`localStorage.getItem('repo-pulse:prefs')`)));
  await evalJs(`var b = document.getElementById('pref-bots'); b.checked = false; b.dispatchEvent(new Event('change'));`);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))`);
  ok('turning off the bot filter shows bot commits', await until(`/dependabot/.test(document.getElementById('feed-body').textContent)`, 3000));
  await evalJs(`var b = document.getElementById('pref-bots'); b.checked = true; b.dispatchEvent(new Event('change'));`);

  console.log('== TV mode ==');
  await nav(`${FIX}/?tv=1`);
  ok('TV mode flag is set and the chrome is hidden', await until(`document.body.classList.contains('tv') && document.querySelector('nav').offsetParent === null && document.getElementById('feed').offsetParent === null`));
  ok('TV mode shows commits inside the cards', await until(`document.querySelectorAll('.card .mini li').length > 0`));

  console.log('== First-run panel ==');
  await fetch(`${FIX}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ org: '', repos: [], pollSeconds: 60 }) });
  await nav(`${FIX}/`);
  ok('an unconfigured server shows the three setup steps with the token state', await until(`/Set up Repo Pulse/.test(document.getElementById('repos').textContent) && /Token: test fixture/.test(document.getElementById('repos').textContent)`), await text('#repos'));
  await fetch(`${FIX}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(FIXTURE_CFG) });

  console.log('== Settings flow (live GitHub) ==');
  await nav(`${APP}/#settings`);
  ok('settings tab opens from the hash', await until(`document.getElementById('view-settings') && !document.getElementById('view-settings').hidden`));
  ok('token line says which account is in use', await until(`/as @/.test(document.getElementById('token-line').textContent)`), await text('#token-line'));
  ok('repository list loads for the saved owner', await until(`document.querySelectorAll('#picklist input[type=checkbox]').length > ${N}`, 30000));
  ok('poll dropdown has nine options', (await evalJs(`document.getElementById('poll').options.length`)) === 9);
  ok('poll dropdown shows the saved value', (await evalJs(`Number(document.getElementById('poll').value)`)) === initial.pollSeconds);
  ok('no unsaved-changes flag at start', await hidden('#dirty'));
  ok('limit note shown at the limit', !(await hidden('#limit-note')));
  ok('non-picked checkboxes disabled at the limit', await evalJs(`[...document.querySelectorAll('#picklist input')].filter(i => !i.checked).every(i => i.disabled)`));

  await evalJs(`[...document.querySelectorAll('#picklist input')].find(i => i.checked).click()`);
  ok('unsaved-changes flag appears after an edit', !(await hidden('#dirty')));
  ok('limit note hides below the limit', await hidden('#limit-note'));
  ok('one chip fewer', (await chips()) === N - 1);

  await evalJs(`document.getElementById('tab-dashboard').click()`);
  ok('dashboard shown', !(await hidden('#view-dashboard')));
  await evalJs(`document.getElementById('tab-settings').click()`);
  await sleep(600);
  ok('draft kept across a tab switch', (await chips()) === N - 1, String(await chips()));
  ok('unsaved flag still shown after the switch', !(await hidden('#dirty')));

  await evalJs(`var a = document.getElementById('add-repo'); a.value = 'torvalds/linux@master'; document.getElementById('add-btn').click();`);
  ok('add by name accepts owner/name@branch', (await chips()) === N && /torvalds\/linux@master/.test(await text('#selected')), await text('#selected'));
  ok('limit note returns at the limit', !(await hidden('#limit-note')));
  await evalJs(`var a = document.getElementById('add-repo'); a.value = 'one-too-many'; document.getElementById('add-btn').click();`);
  ok('adding past the limit is refused with a message', (await chips()) === N && /Limit of/.test(await text('#add-note')), await text('#add-note'));
  await evalJs(`[...document.querySelectorAll('#selected button')].find(b => /torvalds/.test(b.textContent)).click()`);
  ok('the added repository can be removed again', (await chips()) === N - 1);
  await evalJs(`var a = document.getElementById('add-repo'); a.value = 'not a repo!'; document.getElementById('add-btn').click();`);
  ok('a malformed name is refused with guidance', (await chips()) === N - 1 && /owner\/name/.test(await text('#add-note')), await text('#add-note'));
  await evalJs(`var l = document.getElementById('labels'); l.value = 'bug, help wanted'; l.dispatchEvent(new Event('input'));`);
  ok('typing labels marks the settings dirty', !(await hidden('#dirty')));

  await evalJs(`var o = document.getElementById('org'); o.value = 'other-org'; o.dispatchEvent(new Event('input'));`);
  ok('changing the owner field qualifies the existing picks instead of dropping them', (await chips()) === N - 1 && new RegExp('^' + initial.org + '/').test(await evalJs(`document.querySelector('#selected button').textContent`)), await text('#selected'));
  await evalJs(`var o = document.getElementById('org'); o.value = ${JSON.stringify(initial.org)}; o.dispatchEvent(new Event('input'));`);
  ok('restoring the owner shows bare names again', !/\//.test(await evalJs(`document.querySelector('#selected button').textContent`)));

  await evalJs(`var o = document.getElementById('org'); o.value = 'bad org!'; o.dispatchEvent(new Event('input'));`);
  await evalJs(`window.confirm = () => true; document.getElementById('save').click()`);
  ok('server rejects a bad owner name with a message', await until(`/^Not saved: Organization/.test(document.getElementById('save-note').textContent)`), await text('#save-note'));
  await evalJs(`var o = document.getElementById('org'); o.value = ${JSON.stringify(initial.org)}; o.dispatchEvent(new Event('input'));`);

  await evalJs(`var p = document.getElementById('poll'); p.value = '300'; p.dispatchEvent(new Event('change'));`);
  await evalJs(`document.getElementById('save').click()`);
  ok('save confirmation names the interval', await until(`document.getElementById('save-note').textContent.startsWith('Saved. Polling every 5 minutes')`), await text('#save-note'));
  ok('unsaved flag clears after save', await hidden('#dirty'));
  const savedCfg = await (await fetch(`${APP}/api/config`)).json();
  ok('saved config has one repo fewer, 300 s and the labels', savedCfg.repos.length === N - 1 && savedCfg.pollSeconds === 300 && JSON.stringify(savedCfg.issueLabels) === '["bug","help wanted"]', JSON.stringify([savedCfg.repos, savedCfg.issueLabels]));

  // switching owner through the Load button previews the new owner's repositories without saving or losing picks
  await evalJs(`var o = document.getElementById('org'); o.value = 'torvalds'; o.dispatchEvent(new Event('input')); document.getElementById('load-owner').click();`);
  ok('loading another owner lists that owner\'s repositories and keeps the picks', await until(`document.querySelectorAll('#picklist input[type=checkbox]').length > 0 && document.querySelectorAll('#selected button').length === ${N - 1}`, 30000));
  ok('the saved owner is unchanged until Save', (await (await fetch(`${APP}/api/config`)).json()).org === initial.org);
  await evalJs(`var o = document.getElementById('org'); o.value = ${JSON.stringify(initial.org)}; o.dispatchEvent(new Event('input')); document.getElementById('load-owner').click();`);
  await until(`document.querySelectorAll('#picklist input[type=checkbox]').length > ${N}`, 30000);

  await evalJs(`document.getElementById('tab-dashboard').click()`);
  ok('dashboard status shows the new interval', await until(`document.getElementById('mode').textContent.startsWith('Polling every 5 minutes')`), await text('#mode'));
  ok('dashboard shows one card fewer', await until(`document.querySelectorAll('.card').length === ${N - 1}`, 30000), String(await evalJs(`document.querySelectorAll('.card').length`)));
  ok('Live with a successful fetch', await until(`document.getElementById('conn-text').textContent === 'Live'`), await text('#conn-text'));
  await evalJs(`document.getElementById('refresh-now').click()`);
  ok('refresh button gives feedback while in flight', await until(`/Refreshing…|Refreshed a moment ago/.test(document.getElementById('refresh-now').textContent)`, 2000));
  ok('refresh button returns to normal', await until(`document.getElementById('refresh-now').textContent === 'Refresh now' && !document.getElementById('refresh-now').disabled`, 20000));
  await evalJs(`document.getElementById('tab-dashboard').focus(); document.querySelector('nav').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  ok('ArrowRight moves to the Settings tab', !(await hidden('#view-settings')) && (await evalJs(`document.activeElement.id`)) === 'tab-settings');
  await evalJs(`location.hash = '#dashboard'`);
  ok('hash change switches the view', await until(`!document.getElementById('view-dashboard').hidden`, 2000));
  ok('inactive tab is out of the Tab order', (await evalJs(`document.getElementById('tab-settings').tabIndex`)) === -1);
  ok('focus survives a redraw', await evalJs(`(() => { var a = document.querySelector('.card .repo-link'); a.focus(); draw(); return document.activeElement === document.querySelector('.card .repo-link'); })()`));
} catch (err) {
  console.log('ERROR ' + err.message); fail++;
} finally {
  ws?.close();
  // The launcher process we spawned is not the browser that ends up running (Edge re-executes itself), so killing it
  // leaves the real browser behind holding the profile. Ask the browser to close itself over DevTools instead.
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json();
    const bws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((r) => (bws.onopen = r));
    bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    for (let i = 0; i < 25; i++) { await sleep(200); try { await fetch(`http://127.0.0.1:${DBG}/json/version`); } catch { break; } }
  } catch {}
  browser.kill();
  for (const s of [server, fixServer]) await new Promise((r) => { s.on('exit', r); setTimeout(r, 5000); s.kill(); });
  // The browser's helper processes release the profile files a little after the main process is gone.
  await sleep(1500);
  try { rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); } catch { console.log(`note: could not remove ${TMP}; it is safe to delete`); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
