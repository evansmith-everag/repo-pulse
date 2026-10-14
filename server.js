// Repo Pulse: a zero-dependency local dashboard for GitHub repo activity.
// Polls the GitHub GraphQL API, optionally accepts webhooks for instant refresh,
// and pushes snapshots to browsers over server-sent events.
import http from 'node:http';
import { readFile, writeFile, rename, stat, mkdir, copyFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_PATH = fileURLToPath(import.meta.url);
const ROOT = path.dirname(SERVER_PATH);
const PAGE_PATH = path.join(ROOT, 'public', 'index.html');

// Self-update: the project's GitHub releases are checked at startup and about monthly; "Update now" downloads the
// release zip, verifies it against SHA256SUMS, swaps the files in place (keeping the old ones in .previous) and exits
// with code 75, which the launchers, systemd and Docker treat as "restart me".
let PKG = {};
try { PKG = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')); } catch {}
const VERSION = PKG.version || '0.0.0';
const semver = (s) => { const m = String(s).match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/) || []; return [1, 2, 3].map((i) => Number(m[i]) || 0); };
const newer = (a, b) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
// package.json's engines field is the one place the Node floor is defined; only a lower bound such as ">=22" or
// ">=22.12" is understood. Below it the server warns and carries on, because an install that updated itself from an
// older release must still start; the updater refuses a release whose floor this Node does not meet.
const nodeFloor = (pkg) => (String(pkg.engines?.node || '').match(/^\s*(?:>=)?\s*v?(\d+(?:\.\d+){0,2})/) || [])[1] || '0';
const belowNodeFloor = (pkg) => newer(nodeFloor(pkg), process.versions.node);
if (belowNodeFloor(PKG)) console.error(`Repo Pulse v${VERSION} supports Node.js ${PKG.engines.node}; this is ${process.versions.node}. It may still run, but install a current Node.js from https://nodejs.org`);
const UPDATE_REPO = process.env.UPDATE_REPO || String(PKG.repository?.url || PKG.repository || '').replace(/^github:/, '').replace(/^(git\+)?https?:\/\/github\.com\//, '').replace(/\.git$/, '');
const UPDATE_CHECK = process.env.UPDATE_CHECK !== '0' && Boolean(UPDATE_REPO);
const UPDATE_API = process.env.UPDATE_API || `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const UPDATE_INTERVAL_MS = 30 * 864e5;
const UPDATE_STARTUP_DELAY_MS = Number(process.env.UPDATE_CHECK_DELAY_MS || 10_000);
const UPDATE_MAX_ZIP = 30_000_000;
const IN_CONTAINER = process.env.REPO_PULSE_CONTAINER === '1';
const RESTART_EXIT_CODE = 75;
// Files a release may replace, by their path inside the zip. The launchers are left alone on purpose: cmd.exe reads a
// running batch file incrementally, so rewriting start.cmd underneath it would misbehave.
const UPDATABLE = { 'repo-pulse/server.js': 'server.js', 'repo-pulse/public/index.html': 'public/index.html', 'repo-pulse/package.json': 'package.json', 'repo-pulse/README.md': 'README.md', 'repo-pulse/LICENSE': 'LICENSE' };
const REQUIRED_IN_RELEASE = ['server.js', 'public/index.html', 'package.json'];
const CONFIG_PATH = process.env.REPO_PULSE_CONFIG || path.join(ROOT, 'config.json');
// The last good snapshot is kept on disk so a restart shows data immediately instead of "Loading…".
const CACHE_PATH = process.env.REPO_PULSE_CACHE || path.join(path.dirname(CONFIG_PATH), 'snapshot.json');
// A JSON file of canned rows replaces GitHub entirely; used by the tests to get deterministic data.
const FIXTURE_PATH = process.env.REPO_PULSE_FIXTURE || '';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4317);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
// Behind a reverse proxy the public host name arrives in Host (Caddy) or X-Forwarded-Host (nginx); list it here.
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_REPOS = Math.min(9, Math.max(1, Number(process.env.MAX_REPOS) || 3));
const MAX_LABELS = 5;
const COMMITS_PER_REPO = 10;
const WEEK_SAMPLE = 100; // commit dates fetched for the 7-day sparkline; busier repos get a sampled shape
// The oldest open PRs. GitHub answers a 3-repo query in about 4 s at 10, 6 s at 20 and times out (502) near 30
// with per-PR check status, so this stays modest and per-PR checks are not requested at all.
const PRS_PER_REPO = 15;
const STALE_PR_DAYS = 14; // an open, non-draft PR older than this counts as stale
const MERGED_SAMPLE = 30; // merged PRs sampled per repo for cycle-time and first-review medians
const CI_RUNS_PAGE = 50; // workflow runs fetched per repo per poll (REST, one call per repo)
const ORG_LIST_TTL_MS = 60 * 60 * 1000;
const ORG_LIST_MAX_PAGES = 10; // 1,000 repositories; the picker caps at 300 rows and has an add-by-name box anyway
const FETCH_TIMEOUT_MS = 20_000;
const MIN_REFRESH_GAP_MS = 5_000; // manual and webhook refreshes closer than this are coalesced
const MAX_BACKOFF_S = 1800;
// The Settings dropdown offers exactly these poll intervals (seconds). Any other value snaps to the nearest one.
const POLL_OPTIONS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const ORG_RE = /^[A-Za-z0-9-]{1,39}$/;
// A repository entry is "name", "owner/name", or either with "@branch" to watch a branch other than the default.
const SPEC_RE = /^(?:([A-Za-z0-9-]{1,39})\/)?([A-Za-z0-9._-]{1,100})(?:@([^\s@/][^\s@]{0,254}))?$/;
const LABEL_RE = /^[^,\s][^,]{0,48}[^,\s]$|^[^,\s]$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// When bound to loopback, only answer requests addressed to loopback (or ALLOWED_HOSTS). This stops DNS-rebinding
// pages from reading data.
const CHECK_HOST = LOOPBACK_HOSTS.has(HOST) || HOST === '::1';
const WEBHOOK_EVENTS = ['push', 'issues', 'pull_request', 'pull_request_review', 'check_suite', 'workflow_run', 'status', 'release'];

// A fresh install has no owner set; the Settings tab asks for one. "org" is the default owner for bare repository
// names and the owner the picker browses; entries written as owner/name can live under any owner.
const DEFAULT_CONFIG = { org: '', repos: [], pollSeconds: 60, includeArchived: false, issueLabels: [] };

let config = { ...DEFAULT_CONFIG };
let configProblem = null; // set when config.json could not be read, so the Settings tab can say so
let token = '';
let tokenSource = 'none'; // 'env' | 'gh' | 'fixture' | 'none'
let tokenProblem = null; // message when there is no token or GitHub rejected it; polling stops until restart
let viewer = null; // login of the account the token belongs to, so the UI can say whose credentials it uses
let snapshot = { org: '', repos: [], fetchedAt: null, error: null, rateLimit: null };
let orgRepos = { org: null, list: [], fetchedAt: 0, truncated: false, total: 0 };
let pollTimer = null;
let nextPollAt = null;
let failures = 0;
let pausedUntil = 0; // epoch ms while GitHub asks us to back off
let lastFetchStart = 0;
let refreshing = null;
let pendingReason = null;
let gapTimer = null;
const clients = new Set();
const seenDeliveries = []; // recent webhook delivery ids, so a captured delivery cannot be replayed
let update = { enabled: UPDATE_CHECK, repo: UPDATE_REPO, current: VERSION, latest: null, available: false, url: null, publishedAt: null, notes: null, checkedAt: null, error: null, installing: false, installError: null, installed: null, zipUrl: null, sumsUrl: null, zipName: null };
let updateTimer = null;

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const warn = (msg) => console.warn(`${new Date().toISOString()} ${msg}`);

// ---------- page version ----------
// Every snapshot carries a build id made of this file's hash and the page's hash. The page embeds the id it was
// served with and reloads itself when the server starts sending a different one (after an upgrade or an edit).

const SERVER_HASH = createHash('sha256').update(await readFile(SERVER_PATH)).digest('hex').slice(0, 10);
let page = { html: '', mtimeMs: -1, hash: '', csp: cspFor('') };

// The page's inline script and stylesheet are allowed by hash, so the policy needs no 'unsafe-inline' and any
// script injected into the page would be refused; Trusted Types enforcement refuses string-to-DOM sinks outright.
function cspFor(html) {
  const sha = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
  const hashes = (tag) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => sha(m[1])).join(' ') || "'none'";
  return `default-src 'none'; script-src ${hashes('script')}; style-src ${hashes('style')}; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; require-trusted-types-for 'script'`;
}

async function loadPage() {
  try {
    const st = await stat(PAGE_PATH);
    if (st.mtimeMs !== page.mtimeMs) {
      // Browsers hash inline code after newline normalisation, so a CRLF checkout is served (and hashed) as LF text.
      const raw = (await readFile(PAGE_PATH, 'utf8')).replace(/\r\n?/g, '\n');
      const hash = createHash('sha256').update(raw).digest('hex').slice(0, 10);
      // The build id is stamped here, so the policy is computed from exactly the text that is served.
      const html = raw.replace('__BUILD__', buildId(hash));
      page = { html, mtimeMs: st.mtimeMs, hash, csp: cspFor(html) };
    }
  } catch (err) {
    warn(`could not read ${PAGE_PATH}: ${err.message}`);
  }
  return page;
}
const buildId = (hash = page.hash) => `${SERVER_HASH}.${hash}`;

// ---------- config ----------

async function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch (err) {
    config = { ...DEFAULT_CONFIG };
    if (err.code === 'ENOENT') { await saveConfig(config); return; }
    configProblem = `${CONFIG_PATH} could not be read (${err.message}). Using defaults in memory; the file was left alone.`;
    warn(configProblem);
    return;
  }
  config = normalizeConfig(raw);
  const filePoll = raw && typeof raw === 'object' ? raw.pollSeconds : undefined;
  if (filePoll !== undefined && Number(filePoll) !== config.pollSeconds) {
    warn(`pollSeconds ${JSON.stringify(filePoll)} in ${CONFIG_PATH} is not a dropdown choice; using ${config.pollSeconds}`);
  }
}

function parseSpec(str, defaultOwner) {
  const m = typeof str === 'string' ? SPEC_RE.exec(str.trim()) : null;
  if (!m) return null;
  const owner = m[1] || defaultOwner || '';
  const name = m[2], branch = m[3] || null;
  return { spec: str.trim(), owner, name, branch, fullName: `${owner}/${name}`, key: `${owner}/${name}${branch ? '@' + branch : ''}` };
}

// Lenient: used for the file on disk, where hand edits and older formats should degrade gracefully.
function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const org = typeof raw.org === 'string' && (raw.org === '' || ORG_RE.test(raw.org)) ? raw.org : '';
  const seen = new Set();
  const repos = [];
  for (const r of Array.isArray(raw.repos) ? raw.repos : []) {
    const p = parseSpec(r, org);
    if (!p || !p.owner || seen.has(p.key.toLowerCase())) continue;
    seen.add(p.key.toLowerCase());
    repos.push(p.spec);
    if (repos.length === MAX_REPOS) break;
  }
  const issueLabels = [...new Set((Array.isArray(raw.issueLabels) ? raw.issueLabels : []).filter((l) => typeof l === 'string' && LABEL_RE.test(l)))].slice(0, MAX_LABELS);
  return { org, repos, pollSeconds: snapPoll(raw.pollSeconds), includeArchived: Boolean(raw.includeArchived), issueLabels };
}

// Strict: used for settings saved through the API, where a mistake should be reported rather than silently replaced.
function validateSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Settings must be a JSON object.';
  if (typeof raw.org !== 'string' || (raw.org !== '' && !ORG_RE.test(raw.org))) return 'Organization or user must be 1-39 letters, digits or hyphens.';
  if (!Array.isArray(raw.repos)) return 'Repositories must be a list.';
  for (const r of raw.repos) {
    const p = parseSpec(r, raw.org);
    if (!p) return `"${String(r).slice(0, 60)}" is not a repository: use name, owner/name, or owner/name@branch.`;
    if (!p.owner) return `"${p.name}" needs an owner: set the organization or user, or write it as owner/${p.name}.`;
  }
  if (new Set(raw.repos.map((r) => parseSpec(r, raw.org).key.toLowerCase())).size > MAX_REPOS) return `Pick at most ${MAX_REPOS} repositories.`;
  if (!POLL_OPTIONS.includes(raw.pollSeconds)) return `Poll interval must be one of ${POLL_OPTIONS.join(', ')} seconds.`;
  if (raw.includeArchived !== undefined && typeof raw.includeArchived !== 'boolean') return 'includeArchived must be true or false.';
  if (raw.issueLabels !== undefined) {
    if (!Array.isArray(raw.issueLabels) || raw.issueLabels.some((l) => typeof l !== 'string' || !LABEL_RE.test(l))) return 'Issue labels must be short names without commas.';
    if (new Set(raw.issueLabels).size > MAX_LABELS) return `Count at most ${MAX_LABELS} issue labels.`;
  }
  return null;
}

// Hand-edited or legacy config values may not match a dropdown choice; pick the closest one.
function snapPoll(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONFIG.pollSeconds;
  const clamped = Math.min(POLL_OPTIONS.at(-1), Math.max(POLL_OPTIONS[0], n));
  return POLL_OPTIONS.reduce((best, opt) => (Math.abs(opt - clamped) < Math.abs(best - clamped) ? opt : best));
}

async function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  await writeFile(tmp, data);
  await rename(tmp, file);
}

const saveConfig = (next) => writeAtomic(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');

async function saveCache() {
  try {
    const { org, repos, fetchedAt, rateLimit } = snapshot;
    await writeAtomic(CACHE_PATH, JSON.stringify({ org, specs: config.repos, issueLabels: config.issueLabels, repos, fetchedAt, rateLimit }));
  } catch (err) {
    warn(`could not write ${CACHE_PATH}: ${err.message}`);
  }
}

async function loadCache() {
  try {
    const c = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    const same = c.org === config.org && JSON.stringify(c.specs) === JSON.stringify(config.repos) && JSON.stringify(c.issueLabels || []) === JSON.stringify(config.issueLabels);
    if (same && c.fetchedAt) {
      snapshot = { org: c.org, repos: c.repos, fetchedAt: c.fetchedAt, rateLimit: c.rateLimit || null, error: null, fromCache: true };
      log(`showing cached data from ${c.fetchedAt} until the first refresh completes`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') warn(`ignoring ${CACHE_PATH}: ${err.message}`);
  }
}

// ---------- GitHub ----------

class GitHubError extends Error {
  constructor(message, status = 0, retryAfterMs = 0) { super(message); this.status = status; this.retryAfterMs = retryAfterMs; }
}

async function resolveToken() {
  if (FIXTURE_PATH) return ['fixture', 'fixture'];
  if (process.env.GITHUB_TOKEN) return ['env', process.env.GITHUB_TOKEN];
  if (process.env.GH_TOKEN) return ['env', process.env.GH_TOKEN];
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { windowsHide: true }, (err, stdout) => resolve(err || !stdout.trim() ? ['none', ''] : ['gh', stdout.trim()]));
  });
}

async function graphql(query, variables = {}) {
  if (!token) throw new GitHubError('No GitHub token found. Set GITHUB_TOKEN or run `gh auth login`, then restart Repo Pulse.', 0);
  let res;
  try {
    res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'repo-pulse' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? `no answer within ${FETCH_TIMEOUT_MS / 1000} seconds` : (err.cause?.code || err.message);
    throw new GitHubError(`Could not reach GitHub (${why}).`, 0);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch {}
    if (res.status === 401) {
      throw new GitHubError(`GitHub rejected the token${detail ? ` (${detail})` : ''}. Set GITHUB_TOKEN or run \`gh auth login\`, then restart Repo Pulse.`, 401);
    }
    const limited = res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(detail)));
    if (limited) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const wait = retryAfter ? retryAfter * 1000 : reset ? Math.max(5000, reset * 1000 - Date.now()) : 60_000;
      throw new GitHubError(`GitHub rate limit reached${detail ? ` (${detail})` : ''}.`, res.status, wait);
    }
    throw new GitHubError(`GitHub returned ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}.`, res.status);
  }
  const body = await res.json();
  if (body.errors?.length && !body.data) throw new GitHubError(body.errors.map((e) => e.message).join('; '), 200);
  return body;
}

async function whoAmI() {
  if (FIXTURE_PATH) { viewer = 'fixture-user'; return; }
  if (!token) { tokenProblem = 'No GitHub token found. Set GITHUB_TOKEN or run `gh auth login`, then restart Repo Pulse.'; return; }
  try {
    const { data } = await graphql('query { viewer { login } }');
    viewer = data?.viewer?.login || null;
  } catch (err) {
    if (err.status === 401) tokenProblem = err.message;
    warn(`could not identify the token's account: ${err.message}`);
  }
}

// Each poll makes two GraphQL requests in parallel plus one REST call per repository:
//  - the core query: counts, the branch head's CI state, the latest release, the oldest open PRs with their review
//    state, recent commits, commit dates and authors for the week's shape, last week's commit count, per-label issue
//    counts, open security alerts (when the token may see them), merged-in-7-days and untriaged searches;
//  - the velocity query: searches for last week's merges, PRs opened, issues opened and closed, stale PRs, and a
//    sample of this week's merged PRs with their review timing;
//  - GitHub Actions runs on the watched branch, for CI failures.
// Keeping them separate keeps each inside GitHub's ~10 s GraphQL budget; a failing velocity or CI call only blanks
// those cells.
async function fetchRepoData(org, specs, labels) {
  if (!specs.length) return { repos: [], rateLimit: snapshot.rateLimit || null };
  const parsed = specs.map((s) => parseSpec(s, org));
  if (FIXTURE_PATH) return fetchFixture(parsed);
  const now = Date.now();
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const since = new Date(now - 7 * 864e5).toISOString();
  const since14 = new Date(now - 14 * 864e5).toISOString();
  const d7 = day(now - 7 * 864e5), d8 = day(now - 8 * 864e5), d14 = day(now - 14 * 864e5), dStale = day(now - STALE_PR_DAYS * 864e5);
  const labelFields = labels.map((_, j) => `lab${j}: issues(states: OPEN, labels: $lab${j}) { totalCount }`).join(' ');
  const fields = parsed.map((p, i) => `
    r${i}: repository(owner: $o${i}, name: $n${i}) {
      name nameWithOwner url isArchived
      issues(states: OPEN) { totalCount }
      ${labelFields}
      vulnerabilityAlerts(states: OPEN) { totalCount }
      latestRelease { tagName name publishedAt url isPrerelease }
      pullRequests(states: OPEN, first: ${PRS_PER_REPO}, orderBy: { field: CREATED_AT, direction: ASC }) {
        totalCount
        nodes { ...PR }
      }
      newest: pullRequests(states: OPEN, last: 3, orderBy: { field: CREATED_AT, direction: ASC }) { nodes { ...PR } }
      branch: ${p.branch ? `ref(qualifiedName: $b${i})` : 'defaultBranchRef'} { name target { ... on Commit {
        statusCheckRollup { state }
        week: history(since: $since, first: ${WEEK_SAMPLE}) { totalCount nodes { committedDate author { name user { login } } } }
        prevWeek: history(since: $since14, until: $since) { totalCount }
        recent: history(first: ${COMMITS_PER_REPO}) { nodes {
          oid committedDate messageHeadline url
          author { name user { login } }
        } }
      } } }
    }
    m${i}: search(query: $m${i}, type: ISSUE, first: 1) { issueCount }
    u${i}: search(query: $u${i}, type: ISSUE, first: 1) { issueCount }`).join('\n');
  const vars = [
    ...parsed.map((p, i) => `$o${i}: String!, $n${i}: String!, $m${i}: String!, $u${i}: String!${p.branch ? `, $b${i}: String!` : ''}`),
    ...labels.map((_, j) => `$lab${j}: [String!]!`),
  ].join(', ');
  const query = `query($since: GitTimestamp!, $since14: GitTimestamp!, ${vars}) { ${fields} rateLimit { cost remaining limit resetAt } }
    fragment PR on PullRequest {
      number title url createdAt isDraft reviewDecision authorAssociation
      author { login }
    }`;
  const variables = { since, since14 };
  parsed.forEach((p, i) => {
    variables[`o${i}`] = p.owner;
    variables[`n${i}`] = p.name;
    if (p.branch) variables[`b${i}`] = `refs/heads/${p.branch}`;
    variables[`m${i}`] = `repo:${p.fullName} is:pr is:merged merged:>=${d7}`;
    variables[`u${i}`] = `repo:${p.fullName} is:issue is:open no:label comments:0`;
  });
  labels.forEach((l, j) => { variables[`lab${j}`] = [l]; });

  const vFields = parsed.map((_, i) => `
    mn${i}: search(query: $mn${i}, type: ISSUE, first: ${MERGED_SAMPLE}) { nodes { ... on PullRequest { createdAt mergedAt author { login } reviews(first: 1) { nodes { submittedAt } } } } }
    mp${i}: search(query: $mp${i}, type: ISSUE, first: 1) { issueCount }
    po${i}: search(query: $po${i}, type: ISSUE, first: 1) { issueCount }
    io${i}: search(query: $io${i}, type: ISSUE, first: 1) { issueCount }
    ic${i}: search(query: $ic${i}, type: ISSUE, first: 1) { issueCount }
    sp${i}: search(query: $sp${i}, type: ISSUE, first: 1) { issueCount }`).join('\n');
  const vVars = parsed.map((_, i) => ['mn', 'mp', 'po', 'io', 'ic', 'sp'].map((k) => `$${k}${i}: String!`).join(', ')).join(', ');
  const vQuery = `query(${vVars}) { ${vFields} }`;
  const vVariables = {};
  parsed.forEach((p, i) => {
    vVariables[`mn${i}`] = `repo:${p.fullName} is:pr is:merged merged:>=${d7}`;
    vVariables[`mp${i}`] = `repo:${p.fullName} is:pr is:merged merged:${d14}..${d8}`;
    vVariables[`po${i}`] = `repo:${p.fullName} is:pr created:>=${d7}`;
    vVariables[`io${i}`] = `repo:${p.fullName} is:issue created:>=${d7}`;
    vVariables[`ic${i}`] = `repo:${p.fullName} is:issue is:closed closed:>=${d7}`;
    vVariables[`sp${i}`] = `repo:${p.fullName} is:pr is:open draft:false created:<${dStale}`;
  });

  // CI runs need the branch name; start right away where it is known (explicit, or from the last snapshot) and
  // after the core query otherwise.
  const hints = parsed.map((p) => p.branch || snapshot.repos?.find((r) => r.key === p.key)?.branch || null);
  const ciEarly = parsed.map((p, i) => (hints[i] ? fetchCiRuns(p, hints[i], since) : null));
  const velocity = graphql(vQuery, vVariables).then((res) => res.data, (err) => { warn(`velocity query failed: ${err.message}`); return null; });
  const { data, errors } = await graphql(query, variables);
  const rows = parsed.map((p, i) => buildRow(p, i, data, errors, labels));
  const ciAll = parsed.map((p, i) => (rows[i].error ? null : ciEarly[i] || fetchCiRuns(p, rows[i].branch, since)));
  const [vdata, ...cis] = await Promise.all([velocity, ...ciAll]);
  rows.forEach((row, i) => { if (!row.error) { row.metrics = buildMetrics(i, vdata); row.ciRuns = cis[i]; } });
  return { repos: rows, rateLimit: data?.rateLimit || null };
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 36e5;

function buildMetrics(i, vdata) {
  const g = (k) => vdata?.[`${k}${i}`];
  const merged = (g('mn')?.nodes || []).filter((n) => n && n.createdAt && !BOT_RE.test(n.author?.login || ''));
  const cycle = merged.filter((n) => n.mergedAt).map((n) => hoursBetween(n.createdAt, n.mergedAt));
  const firstReview = merged.filter((n) => n.reviews?.nodes?.[0]?.submittedAt).map((n) => hoursBetween(n.createdAt, n.reviews.nodes[0].submittedAt));
  return {
    available: Boolean(vdata),
    mergedPrev7d: g('mp')?.issueCount ?? null,
    prsOpened7d: g('po')?.issueCount ?? null,
    issuesOpened7d: g('io')?.issueCount ?? null,
    issuesClosed7d: g('ic')?.issueCount ?? null,
    stalePrs: g('sp')?.issueCount ?? null,
    staleDays: STALE_PR_DAYS,
    cycleHours: median(cycle),
    firstReviewHours: median(firstReview),
    mergedSample: merged.length,
    reviewedSample: firstReview.length,
  };
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const IGNORED_CONCLUSIONS = new Set(['cancelled', 'skipped', 'neutral', 'stale']);

// GitHub Actions runs on one branch (REST; GraphQL has no equivalent). Null when Actions is off, the token may not
// read it, or GitHub is slow: a missing CI column must never fail the poll.
async function fetchCiRuns(p, branch, since) {
  if (!branch || !token) return null;
  try {
    const url = `https://api.github.com/repos/${p.fullName}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${CI_RUNS_PAGE}&exclude_pull_requests=true`;
    const res = await fetch(url, {
      headers: { Authorization: `bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'repo-pulse' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const runs = ((await res.json()).workflow_runs || []).filter((r) => r.status === 'completed' && r.conclusion && !IGNORED_CONCLUSIONS.has(r.conclusion));
    const recent = runs.filter((r) => r.created_at >= since);
    const failed = recent.filter((r) => FAILED_CONCLUSIONS.has(r.conclusion));
    const latest = new Map(); // newest completed run per workflow; "failing" means its latest run failed
    for (const r of runs) if (!latest.has(r.name)) latest.set(r.name, r);
    const failing = [...latest.values()].filter((r) => FAILED_CONCLUSIONS.has(r.conclusion)).map((r) => r.name);
    const last = failed[0] || [...latest.values()].find((r) => FAILED_CONCLUSIONS.has(r.conclusion)) || null;
    return {
      branch,
      runs7d: recent.length,
      failed7d: failed.length,
      failing,
      lastFailure: last ? { name: last.name, url: last.html_url, at: last.created_at } : null,
      truncated: runs.length >= CI_RUNS_PAGE && runs.at(-1)?.created_at >= since,
    };
  } catch (err) {
    warn(`actions runs for ${p.fullName}@${branch} skipped: ${err.message}`);
    return null;
  }
}

async function fetchFixture(parsed) {
  const f = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
  if (f.error) throw new GitHubError(f.error, f.status || 500, f.retryAfterMs || 0);
  const rows = parsed.map((p) => {
    const row = f.repos?.find((r) => r.name === p.name && (!r.owner || r.owner === p.owner));
    return row ? { ...row, owner: p.owner, fullName: p.fullName, key: p.key } : { name: p.name, owner: p.owner, fullName: p.fullName, key: p.key, error: 'Not in the fixture file' };
  });
  return { repos: rows, rateLimit: f.rateLimit || { cost: 1, remaining: 4999, limit: 5000, resetAt: new Date(Date.now() + 3600e3).toISOString() } };
}

// Bots skew people-metrics (a dependency bot can be the "top contributor", an auto-merge bot has a one-minute
// cycle time), so they are left out of contributor concentration and the review-timing medians.
const BOT_RE = /\[bot\]$|(^|[-_])bot$|^(dependabot|renovate|github-actions|greenkeeper)/i;
const CI_STATE = { SUCCESS: 'passing', FAILURE: 'failing', ERROR: 'failing', PENDING: 'pending', EXPECTED: 'pending' };
const ciOf = (rollup) => (rollup?.state ? CI_STATE[rollup.state] || null : null);
const INSIDERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Seven buckets, oldest to newest, of commits per UTC day from the sampled commit dates.
function weekShape(nodes) {
  const days = [0, 0, 0, 0, 0, 0, 0];
  const now = Date.now();
  for (const n of nodes || []) {
    const age = Math.floor((now - new Date(n.committedDate)) / 864e5);
    if (age >= 0 && age < 7) days[6 - age]++;
  }
  return days;
}

// Who wrote the week's commits: how many people, and how much of it the busiest one did.
function contributorsOf(nodes) {
  const counts = new Map();
  let bots = 0;
  for (const n of nodes || []) {
    const who = n.author?.user?.login || n.author?.name || 'unknown';
    if (BOT_RE.test(who)) { bots++; continue; }
    counts.set(who, (counts.get(who) || 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { count: counts.size, botCommits: bots, top: top && total ? { name: top[0], share: top[1] / total } : null };
}

function buildRow(p, i, data, errors, labels) {
  const identity = { key: p.key, owner: p.owner, name: p.name, fullName: p.fullName, spec: p.spec };
  const r = data?.[`r${i}`];
  if (!r) {
    const msg = errors?.find((e) => e.path?.[0] === `r${i}`)?.message || 'Not found or no access';
    return { ...identity, error: msg };
  }
  if (p.branch && !r.branch) return { ...identity, url: r.url, error: `Branch "${p.branch}" was not found.` };
  const target = r.branch?.target;
  const commits = (target?.recent.nodes || []).map((c) => ({
    sha: c.oid.slice(0, 7),
    message: c.messageHeadline,
    author: c.author?.user?.login || c.author?.name || 'unknown',
    committedAt: c.committedDate,
    url: c.url,
  }));
  const toPr = (q) => ({
    number: q.number,
    title: q.title,
    url: q.url,
    createdAt: q.createdAt,
    author: q.author?.login || 'unknown',
    draft: q.isDraft,
    // "review" means nobody has approved or asked for changes yet, whether or not branch protection demands a review.
    decision: q.reviewDecision === 'APPROVED' ? 'approved' : q.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'review',
    outside: !INSIDERS.has(q.authorAssociation),
    firstTime: q.authorAssociation === 'FIRST_TIME_CONTRIBUTOR' || q.authorAssociation === 'FIRST_TIMER',
  });
  const prNodes = r.pullRequests?.nodes || [];
  const prs = prNodes.map(toPr);
  const open = prs.filter((q) => !q.draft);
  const awaiting = open.filter((q) => q.decision === 'review');
  const rel = r.latestRelease;
  const labelCounts = {};
  labels.forEach((l, j) => { labelCounts[l] = r[`lab${j}`]?.totalCount ?? null; });
  return {
    ...identity,
    name: r.name,
    fullName: r.nameWithOwner || p.fullName,
    url: r.url,
    archived: r.isArchived,
    branch: r.branch?.name || null,
    ci: ciOf(target?.statusCheckRollup),
    release: rel ? { tag: rel.tagName, name: rel.name, publishedAt: rel.publishedAt, url: rel.url, prerelease: rel.isPrerelease } : null,
    openIssues: r.issues.totalCount,
    untriaged: data?.[`u${i}`]?.issueCount ?? null,
    labels: labelCounts,
    openPrs: r.pullRequests?.totalCount ?? 0,
    merged7d: data?.[`m${i}`]?.issueCount ?? null,
    prs: {
      total: r.pullRequests?.totalCount ?? 0,
      sampled: (r.pullRequests?.totalCount ?? 0) > prNodes.length, // counts below cover only the oldest PRS_PER_REPO
      awaiting: awaiting.length,
      approved: open.filter((q) => q.decision === 'approved').length,
      changes: open.filter((q) => q.decision === 'changes').length,
      drafts: prs.length - open.length,
      oldestAwaitingAt: awaiting[0]?.createdAt || null,
      waiting: open.slice(0, 3),
      newest: (r.newest?.nodes || []).map(toPr).reverse(), // newest first; the page uses these to notice arrivals
    },
    commits7d: target?.week.totalCount ?? 0,
    commitsPrev7d: target?.prevWeek?.totalCount ?? null,
    week: { total: target?.week.totalCount ?? 0, days: weekShape(target?.week.nodes), sampled: (target?.week.totalCount ?? 0) > WEEK_SAMPLE },
    contributors: contributorsOf(target?.week.nodes),
    alerts: r.vulnerabilityAlerts?.totalCount ?? null, // null unless the token may read Dependabot alerts
    lastCommitAt: commits[0]?.committedAt || null,
    commits,
  };
}

async function fetchOrgRepos(org, force = false) {
  if (!force && orgRepos.org === org && Date.now() - orgRepos.fetchedAt < ORG_LIST_TTL_MS) return orgRepos;
  const list = [];
  let cursor = null, pages = 0, total = 0;
  do {
    // repositoryOwner covers both organizations and user accounts.
    const { data } = await graphql(
      `query($org: String!, $after: String) { repositoryOwner(login: $org) {
        repositories(first: 100, after: $after, orderBy: { field: PUSHED_AT, direction: DESC }) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { name isArchived isPrivate pushedAt description }
        } } }`,
      { org, after: cursor },
    );
    const pageData = data?.repositoryOwner?.repositories;
    if (!pageData) throw new GitHubError(`"${org}" is not an organization or user this token can see.`, 404);
    total = pageData.totalCount;
    list.push(...pageData.nodes);
    cursor = pageData.pageInfo.hasNextPage ? pageData.pageInfo.endCursor : null;
    pages++;
  } while (cursor && pages < ORG_LIST_MAX_PAGES);
  orgRepos = { org, list, fetchedAt: Date.now(), truncated: Boolean(cursor), total };
  return orgRepos;
}

// ---------- self-update ----------


async function checkForUpdate(reason) {
  if (!UPDATE_CHECK) return update;
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'repo-pulse' };
    if (token && !FIXTURE_PATH) headers.Authorization = `bearer ${token}`; // optional; raises the unauthenticated limit
    const res = await fetch(UPDATE_API, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} ${res.statusText}`);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const zip = (rel.assets || []).find((a) => /^repo-pulse-v[\d.]+\.zip$/.test(a.name));
    const sums = (rel.assets || []).find((a) => a.name === 'SHA256SUMS');
    update = {
      ...update, latest, available: newer(latest, VERSION) && Boolean(zip && sums), url: rel.html_url || null, publishedAt: rel.published_at || null,
      notes: String(rel.body || '').slice(0, 4000), zipUrl: zip?.browser_download_url || null, sumsUrl: sums?.browser_download_url || null, zipName: zip?.name || null,
      checkedAt: new Date().toISOString(), error: null,
    };
    log(update.available ? `update available: v${latest} (running v${VERSION}); install from Settings or POST /api/update` : `up to date at v${VERSION} (checked ${reason})`);
  } catch (err) {
    update = { ...update, checkedAt: new Date().toISOString(), error: err.message };
    warn(`update check failed (${reason}): ${err.message}`);
  }
  broadcast('snapshot', publicSnapshot());
  return update;
}

function scheduleUpdateChecks() {
  if (!UPDATE_CHECK) return;
  setTimeout(() => checkForUpdate('at startup'), UPDATE_STARTUP_DELAY_MS).unref();
  // setTimeout cannot wait a month in one go, so a six-hourly tick checks whether a month has passed.
  updateTimer = setInterval(() => {
    const last = update.checkedAt ? new Date(update.checkedAt).getTime() : 0;
    if (Date.now() - last >= UPDATE_INTERVAL_MS) checkForUpdate('monthly');
  }, 6 * 3600e3).unref();
}

function publicUpdate() {
  const { enabled, repo, current, latest, available, url, publishedAt, checkedAt, error, installing, installError, installed } = update;
  return { enabled, repo, current, latest, available, url, publishedAt, checkedAt, error, installing, installError, installed, container: IN_CONTAINER };
}

// Installing an update rewrites the server's own code, so it is for administrators: the admin token when one is set,
// otherwise only clients on this machine.
const canAdminister = (req) => (ADMIN_TOKEN ? authorized(req) : isLoopbackClient(req));

async function download(url, maxBytes) {
  const res = await fetch(url, { headers: { 'User-Agent': 'repo-pulse' }, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`download of ${url} failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`download of ${url} is larger than expected (${buf.length} bytes)`);
  return buf;
}

// A minimal reader for the release zip: stored and deflated entries, sizes from the central directory, CRC checked.
const CRC_TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('the download is not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip central directory is damaged');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`zip entry ${name} is damaged`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`zip entry ${name} uses unsupported compression ${method}`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`zip entry ${name} failed its integrity check`);
    files.push({ name, data });
  }
  return files;
}

async function installUpdate() {
  const refuse = (msg) => Object.assign(new Error(msg), { status: 409 });
  if (!UPDATE_CHECK) throw refuse('Update checks are off (UPDATE_CHECK=0).');
  if (update.installing) throw refuse('An update is already being installed.');
  if (!update.checkedAt) await checkForUpdate('before install');
  if (!update.available) throw refuse(update.latest ? `Already up to date (v${VERSION}).` : 'No release found to install.');
  if (IN_CONTAINER) throw refuse(`Running in a container: pull the image for v${update.latest} instead.`);
  if (await stat(path.join(ROOT, '.git')).then(() => true, () => false)) throw refuse('This is a git checkout: run git pull (or check out the release tag) instead.');
  try { await writeFile(path.join(ROOT, '.write-test'), ''); await unlink(path.join(ROOT, '.write-test')); }
  catch { throw refuse(`The install folder ${ROOT} is not writable by this process; download the release zip instead.`); }
  update = { ...update, installing: true, installError: null };
  broadcast('snapshot', publicSnapshot());
  try {
    log(`downloading ${update.zipName} for v${update.latest}`);
    const [zip, sums] = await Promise.all([download(update.zipUrl, UPDATE_MAX_ZIP), download(update.sumsUrl, 10_000)]);
    const expected = sums.toString('utf8').split('\n').map((l) => l.trim().split(/\s+/)).find((parts) => parts[1]?.replace(/^\*/, '') === update.zipName)?.[0];
    const actual = createHash('sha256').update(zip).digest('hex');
    if (!expected) throw new Error(`SHA256SUMS has no entry for ${update.zipName}`);
    if (expected.toLowerCase() !== actual) throw new Error('the downloaded zip does not match SHA256SUMS');
    const files = unzip(zip).filter((f) => UPDATABLE[f.name]).map((f) => ({ target: UPDATABLE[f.name], data: f.data }));
    for (const need of REQUIRED_IN_RELEASE) if (!files.some((f) => f.target === need)) throw new Error(`the release zip has no ${need}`);
    const newPkg = JSON.parse(files.find((f) => f.target === 'package.json').data.toString('utf8'));
    if (!newer(newPkg.version, VERSION)) throw new Error(`the zip contains v${newPkg.version}, not newer than v${VERSION}`);
    if (belowNodeFloor(newPkg)) throw new Error(`v${newPkg.version} needs Node.js ${newPkg.engines.node}; this is ${process.versions.node}. Install a current Node.js first.`);
    const backup = path.join(ROOT, '.previous');
    await mkdir(path.join(backup, 'public'), { recursive: true });
    for (const f of files) {
      const target = path.join(ROOT, f.target);
      await copyFile(target, path.join(backup, f.target)).catch(() => {});
      await mkdir(path.dirname(target), { recursive: true });
      await writeAtomic(target, f.data);
    }
    update = { ...update, installing: false, installed: newPkg.version, available: false };
    log(`installed v${newPkg.version} (previous files kept in ${backup}); exiting with code ${RESTART_EXIT_CODE} so the launcher restarts`);
    broadcast('snapshot', publicSnapshot());
    setTimeout(() => {
      clearTimeout(pollTimer);
      for (const res of clients) res.end();
      server.close();
      process.exit(RESTART_EXIT_CODE);
    }, 400).unref();
    return { ok: true, version: newPkg.version, restarting: true };
  } catch (err) {
    update = { ...update, installing: false, installError: err.message }; // kept apart from a failed check's error
    warn(`update failed: ${err.message}`);
    broadcast('snapshot', publicSnapshot());
    throw Object.assign(new Error(err.message), { status: 502 }); // the page adds its own "Update failed:"
  }
}

// ---------- refresh loop ----------

// One refresh runs at a time. A request that arrives mid-flight is queued and runs right after, so a settings save or
// a webhook is never lost. If settings change while a fetch is in flight, that fetch's result is discarded.
function refresh(reason) {
  if (refreshing) { pendingReason = reason; return refreshing; }
  const { org, repos: specs, issueLabels } = config;
  lastFetchStart = Date.now();
  refreshing = (async () => {
    let stale = false;
    try {
      const { repos, rateLimit } = await fetchRepoData(org, specs, issueLabels);
      stale = config.org !== org || config.repos !== specs || config.issueLabels !== issueLabels;
      if (!stale) {
        if (failures || snapshot.error) log(`refresh ok (${reason})`);
        failures = 0; pausedUntil = 0; tokenProblem = null;
        snapshot = { org, repos, rateLimit, fetchedAt: new Date().toISOString(), error: null, reason };
        if (specs.length) saveCache();
      }
    } catch (err) {
      failures++;
      if (err.status === 401 || (!token && !FIXTURE_PATH)) tokenProblem = err.message;
      if (err.retryAfterMs) pausedUntil = Date.now() + err.retryAfterMs;
      snapshot = { ...snapshot, org: config.org, error: err.message, failedAt: new Date().toISOString() };
      warn(`refresh failed (${reason}, attempt ${failures}): ${err.message}`);
    } finally {
      refreshing = null;
      schedulePolling();
      await loadPage(); // pick up an edited page so the build id in the snapshot is current
      if (!stale) broadcast('snapshot', publicSnapshot());
      if (pendingReason) { const next = pendingReason; pendingReason = null; refresh(next); }
    }
  })();
  return refreshing;
}

// Manual and webhook refreshes closer together than MIN_REFRESH_GAP_MS collapse into one, a little later.
function requestRefresh(reason) {
  const wait = MIN_REFRESH_GAP_MS - (Date.now() - lastFetchStart);
  if (refreshing || wait <= 0) return refresh(reason);
  if (!gapTimer) gapTimer = setTimeout(() => { gapTimer = null; refresh(reason); }, wait);
  return null;
}

// Fixed interval while things work; exponential backoff with jitter after failures; GitHub's own retry window when
// rate limited; nothing at all once the token is known to be bad (a manual refresh still retries).
function schedulePolling() {
  clearTimeout(pollTimer);
  pollTimer = null; nextPollAt = null;
  if (tokenProblem) return;
  let delay = config.pollSeconds * 1000;
  if (pausedUntil > Date.now()) delay = Math.max(delay, pausedUntil - Date.now());
  else if (failures) delay = Math.min(MAX_BACKOFF_S * 1000, delay * 2 ** Math.min(failures, 6));
  delay = Math.round(delay * (0.9 + Math.random() * 0.2));
  nextPollAt = new Date(Date.now() + delay).toISOString();
  pollTimer = setTimeout(() => refresh('poll'), delay);
}

function publicSnapshot() {
  return {
    ...snapshot,
    pollSeconds: config.pollSeconds,
    maxRepos: MAX_REPOS,
    configuredRepos: config.repos.length, // lets the page tell "nothing picked" from "not fetched yet"
    issueLabels: config.issueLabels,
    webhooks: Boolean(WEBHOOK_SECRET),
    nextPollAt,
    pausedUntil: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null,
    failures,
    tokenProblem,
    tokenSource,
    viewer,
    build: buildId(),
    version: VERSION,
    update: publicUpdate(),
  };
}

function publicConfig(req) {
  return {
    ...config,
    version: VERSION,
    maxRepos: MAX_REPOS,
    maxLabels: MAX_LABELS,
    pollOptions: POLL_OPTIONS,
    adminRequired: Boolean(ADMIN_TOKEN),
    // The file path is useful on your own machine and nobody else's business on a shared deployment.
    configPath: !req || isLoopbackClient(req) || authorized(req) ? CONFIG_PATH : null,
    configProblem,
    tokenSource,
    tokenProblem,
    viewer,
  };
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- HTTP ----------

const MIME = { '.html': 'text/html; charset=utf-8' };
const baseHeaders = () => ({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': page.csp,
});

function send(res, status, body, type = 'application/json', extra = {}) {
  res.writeHead(status, { ...baseHeaders(), 'Content-Type': type, ...extra });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseUrl(req) {
  try { return new URL(req.url, 'http://localhost'); }
  catch { throw Object.assign(new Error('Malformed request URL'), { status: 400 }); }
}

function parseJson(buf) {
  try { return JSON.parse(buf.toString() || 'null'); }
  catch { throw Object.assign(new Error('Body is not valid JSON.'), { status: 400 }); }
}

function isJson(req) {
  return (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json';
}

// The host name the browser used, taking the proxy's word for it only when TRUST_PROXY is set.
function requestHost(req) {
  const forwarded = TRUST_PROXY ? (req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  return forwarded || req.headers.host || '';
}

function hostAllowed(req) {
  if (!CHECK_HOST) return true;
  try {
    const { hostname } = new URL('http://' + requestHost(req));
    return LOOPBACK_HOSTS.has(hostname) || ALLOWED_HOSTS.includes(hostname.toLowerCase());
  } catch { return false; }
}

function isLoopbackClient(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Browsers mark cross-site requests; a page on another origin must not be able to change settings or trigger fetches.
// Webhooks and curl send neither header and pass through (the webhook has its own signature check).
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === requestHost(req); } catch { return false; }
}

function authorized(req) {
  if (!ADMIN_TOKEN) return true;
  const given = Buffer.from(req.headers['x-admin-token'] || '');
  const want = Buffer.from(ADMIN_TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

function validSignature(raw, header) {
  if (!header?.startsWith('sha256=')) return false;
  const want = Buffer.from('sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'));
  const given = Buffer.from(header);
  return given.length === want.length && timingSafeEqual(given, want);
}

function seenDelivery(id) {
  if (!id) return false;
  if (seenDeliveries.includes(id)) return true;
  seenDeliveries.push(id);
  if (seenDeliveries.length > 200) seenDeliveries.shift();
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) return send(res, 403, { error: 'Requests must be addressed to localhost (or a host listed in ALLOWED_HOSTS).' });
    if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-site requests are not allowed.' });
    const url = parseUrl(req);
    if (req.method === 'GET' && url.pathname === '/api/events') {
      await loadPage();
      // X-Accel-Buffering tells nginx to stream instead of buffering the event stream.
      res.writeHead(200, { ...baseHeaders(), 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 5000\nevent: snapshot\ndata: ${JSON.stringify(publicSnapshot())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      // The same document the page receives, for scripts and status pages. ETag lets pollers skip unchanged data.
      const etag = `"${snapshot.fetchedAt || 'none'}-${snapshot.failedAt || ''}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ...baseHeaders(), ETag: etag }); return res.end(); }
      return send(res, 200, publicSnapshot(), 'application/json', { ETag: etag });
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const ok = !tokenProblem && (Boolean(snapshot.fetchedAt) || !config.repos.length);
      return send(res, ok ? 200 : 503, { ok, fetchedAt: snapshot.fetchedAt, error: snapshot.error, tokenSource, rateLimit: snapshot.rateLimit, build: buildId() });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, publicConfig(req));
    }
    if (req.method === 'GET' && url.pathname === '/api/update') {
      return send(res, 200, { ...publicUpdate(), notes: update.notes, canAdminister: canAdminister(req) });
    }
    if (req.method === 'POST' && url.pathname === '/api/update/check') {
      if (!canAdminister(req)) return send(res, ADMIN_TOKEN ? 401 : 403, { error: ADMIN_TOKEN ? 'Admin token missing or wrong.' : 'Only this machine may check for updates.' });
      if (!UPDATE_CHECK) return send(res, 409, { error: 'Update checks are off (UPDATE_CHECK=0).' });
      await checkForUpdate('on request');
      return send(res, 200, { ...publicUpdate(), notes: update.notes, canAdminister: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/update') {
      if (!canAdminister(req)) return send(res, ADMIN_TOKEN ? 401 : 403, { error: ADMIN_TOKEN ? 'Admin token missing or wrong.' : 'Only this machine may install updates.' });
      return send(res, 200, await installUpdate());
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      if (!authorized(req)) return send(res, 401, { error: 'Admin token missing or wrong.' });
      if (!isJson(req)) return send(res, 415, { error: 'Send settings as application/json.' });
      const raw = parseJson(await readBody(req));
      const problem = validateSettings(raw);
      if (problem) return send(res, 400, { error: problem });
      const next = normalizeConfig(raw);
      const orgChanged = next.org !== config.org;
      config = next;
      await saveConfig(config);
      configProblem = null;
      if (orgChanged) orgRepos = { org: null, list: [], fetchedAt: 0, truncated: false, total: 0 };
      failures = 0;
      schedulePolling();
      broadcast('config', publicConfig());
      refresh('settings');
      return send(res, 200, publicConfig(req));
    }
    if (req.method === 'GET' && url.pathname === '/api/org-repos') {
      // ?owner= lets the Settings tab browse any owner's repositories before saving.
      const owner = url.searchParams.get('owner') || config.org;
      if (!owner) return send(res, 400, { error: 'Set an organization or user in Settings first.' });
      if (!ORG_RE.test(owner)) return send(res, 400, { error: 'Organization or user must be 1-39 letters, digits or hyphens.' });
      // The full repository inventory is more sensitive than the chosen repos, so it needs the admin token when one is set.
      if (!authorized(req)) return send(res, 401, { error: 'Enter the admin token to load the repository list.' });
      const { list, truncated, total } = await fetchOrgRepos(owner, url.searchParams.get('refresh') === '1');
      const includeArchived = url.searchParams.has('archived') ? url.searchParams.get('archived') === '1' : config.includeArchived;
      return send(res, 200, { org: owner, repos: includeArchived ? list : list.filter((r) => !r.isArchived), truncated, total });
    }
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      const sinceLast = Date.now() - lastFetchStart;
      if (!refreshing && sinceLast < MIN_REFRESH_GAP_MS) {
        const wait = Math.ceil((MIN_REFRESH_GAP_MS - sinceLast) / 1000);
        return send(res, 429, { error: `Refreshed a moment ago. Try again in ${wait} s.`, retryAfter: wait }, 'application/json', { 'Retry-After': String(wait) });
      }
      await refresh('manual');
      return send(res, 200, { ok: !snapshot.error, error: snapshot.error });
    }
    if (req.method === 'POST' && url.pathname === '/webhook') {
      if (!WEBHOOK_SECRET) return send(res, 404, { error: 'Webhooks are off. Set WEBHOOK_SECRET to enable.' });
      const raw = await readBody(req, 25_000_000);
      if (!validSignature(raw, req.headers['x-hub-signature-256'])) return send(res, 401, { error: 'Bad signature' });
      if (!isJson(req)) return send(res, 400, { error: 'Set the webhook content type to application/json.' });
      if (seenDelivery(req.headers['x-github-delivery'])) return send(res, 202, { ok: true, duplicate: true });
      const event = req.headers['x-github-event'];
      const repoObj = parseJson(raw)?.repository;
      const full = (repoObj?.full_name || (repoObj?.name ? `${config.org}/${repoObj.name}` : '')).toLowerCase();
      const watched = config.repos.some((s) => parseSpec(s, config.org).fullName.toLowerCase() === full);
      if (full && watched && WEBHOOK_EVENTS.includes(event)) requestRefresh(`webhook:${event}`);
      return send(res, 202, { ok: true });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (req.method === 'HEAD') { await loadPage(); res.writeHead(200, { ...baseHeaders(), 'Content-Type': MIME['.html'] }); return res.end(); }
      return send(res, 200, (await loadPage()).html, MIME['.html']);
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, err.status || 500, { error: err.message });
  }
});

process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set PORT to pick another.` : err.message);
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    clearTimeout(pollTimer);
    for (const res of clients) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

await loadConfig();
await loadCache();
await loadPage();
[tokenSource, token] = await resolveToken();
await whoAmI();
if (tokenProblem) warn(tokenProblem);
else log(`token: ${tokenSource === 'env' ? 'GITHUB_TOKEN environment variable' : tokenSource === 'gh' ? 'GitHub CLI login (gh auth token)' : tokenSource}${viewer ? ` as @${viewer}` : ''}`);
schedulePolling();
scheduleUpdateChecks();
refresh('startup');
server.listen(PORT, HOST, () => {
  log(`Repo Pulse v${VERSION} (${buildId()}) on http://${HOST}:${PORT}  (config: ${CONFIG_PATH})`);
  if (WEBHOOK_SECRET) log('Webhooks enabled at POST /webhook');
  if (!UPDATE_CHECK) log('Update checks are off');
});
