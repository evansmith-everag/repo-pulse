// Repo Pulse: a zero-dependency local dashboard for GitHub repo activity.
// Polls the GitHub GraphQL API, optionally accepts webhooks for instant refresh,
// and pushes snapshots to browsers over server-sent events.
import http from 'node:http';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_PATH = fileURLToPath(import.meta.url);
const ROOT = path.dirname(SERVER_PATH);
const PAGE_PATH = path.join(ROOT, 'public', 'index.html');
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

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const warn = (msg) => console.warn(`${new Date().toISOString()} ${msg}`);

// ---------- page version ----------
// Every snapshot carries a build id made of this file's hash and the page's hash. The page embeds the id it was
// served with and reloads itself when the server starts sending a different one (after an upgrade or an edit).

const SERVER_HASH = createHash('sha256').update(await readFile(SERVER_PATH)).digest('hex').slice(0, 10);
let page = { html: '', mtimeMs: -1, hash: '' };

async function loadPage() {
  try {
    const st = await stat(PAGE_PATH);
    if (st.mtimeMs !== page.mtimeMs) {
      const html = await readFile(PAGE_PATH, 'utf8');
      page = { html, mtimeMs: st.mtimeMs, hash: createHash('sha256').update(html).digest('hex').slice(0, 10) };
    }
  } catch (err) {
    warn(`could not read ${PAGE_PATH}: ${err.message}`);
  }
  return page;
}
const buildId = () => `${SERVER_HASH}.${page.hash}`;

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
  };
}

function publicConfig(req) {
  return {
    ...config,
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
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': CSP,
};

function send(res, status, body, type = 'application/json', extra = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type, ...extra });
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
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 5000\nevent: snapshot\ndata: ${JSON.stringify(publicSnapshot())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      // The same document the page receives, for scripts and status pages. ETag lets pollers skip unchanged data.
      const etag = `"${snapshot.fetchedAt || 'none'}-${snapshot.failedAt || ''}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ...BASE_HEADERS, ETag: etag }); return res.end(); }
      return send(res, 200, publicSnapshot(), 'application/json', { ETag: etag });
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const ok = !tokenProblem && (Boolean(snapshot.fetchedAt) || !config.repos.length);
      return send(res, ok ? 200 : 503, { ok, fetchedAt: snapshot.fetchedAt, error: snapshot.error, tokenSource, rateLimit: snapshot.rateLimit, build: buildId() });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, publicConfig(req));
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
      if (req.method === 'HEAD') { res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': MIME['.html'] }); return res.end(); }
      const { html } = await loadPage();
      return send(res, 200, html.replace('__BUILD__', buildId()), MIME['.html']);
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
refresh('startup');
server.listen(PORT, HOST, () => {
  log(`Repo Pulse ${buildId()} on http://${HOST}:${PORT}  (config: ${CONFIG_PATH})`);
  if (WEBHOOK_SECRET) log('Webhooks enabled at POST /webhook');
});
