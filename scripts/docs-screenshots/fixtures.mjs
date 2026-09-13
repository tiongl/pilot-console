// Mock API data for docs screenshots.
//
// The capture script routes every `/api/**` request through `installApiMocks()`
// so screenshots render a realistic, deterministic UI without a live backend,
// GitHub CLI auth, a running daemon, or seeded data. To enrich a screenshot,
// add or edit an entry in `FIXTURES` / `REGEX_FIXTURES` below — no other code
// needs to change.
//
// A fixture value may be a plain object/array (returned as JSON) or a function
// `(url, request) => value` for dynamic responses. Keys are matched against the
// request pathname: exact match first, then the first RegExp key that matches.

const now = Date.now();
const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString();

const ADMIN_USER = {
  id: 'admin-1',
  githubId: '12345',
  githubLogin: 'octocat',
  email: 'admin@example.com',
  displayName: 'Ada Admin',
  role: 'admin',
};

const PROJECTS = [
  { id: 'proj-web', name: 'Acme Web', repoPath: '/home/dev/acme-web', pinned: 1 },
  { id: 'proj-api', name: 'Acme API', repoPath: '/home/dev/acme-api', pinned: 0 },
];

const WORKTREES = [
  {
    id: 'wt-1', projectId: 'proj-web', name: 'checkout-redesign',
    branch: 'issue-482', worktreePath: '/home/dev/acme-web-wt-checkout',
    isManaged: true, type: 'worktree', issueNumber: 482, createdAt: iso(-3600_000),
  },
  {
    id: 'wt-2', projectId: 'proj-web', name: 'flaky-test-fix',
    branch: 'issue-491', worktreePath: '/home/dev/acme-web-wt-flaky',
    isManaged: true, type: 'worktree', issueNumber: 491, createdAt: iso(-7200_000),
  },
];

const DELEGATIONS = [
  { id: 'dg-1', projectId: 'proj-web', worktreeId: 'wt-1', title: 'Checkout redesign', status: 'working', unread: 1 },
  { id: 'dg-2', projectId: 'proj-web', worktreeId: 'wt-2', title: 'Fix flaky test', status: 'awaiting_plan_review', unread: 0 },
];

const SCHEDULES = [
  {
    id: 'sched-1', name: 'Daily PR Summary', prompt: 'Summarize open pull requests and flag stale ones.',
    cronExpression: '0 9 * * 1-5', rendererType: 'markdown', enabled: true,
    maxRuntimeMs: 300000, maxRunsRetained: 50, nextRunAt: iso(3600_000), createdAt: iso(-86400_000 * 7),
  },
  {
    id: 'sched-2', name: 'Weekly Security Scan', prompt: 'Review dependencies for known vulnerabilities.',
    cronExpression: '0 6 * * 1', rendererType: 'html', enabled: true,
    maxRuntimeMs: 600000, maxRunsRetained: 20, nextRunAt: iso(86400_000 * 2), createdAt: iso(-86400_000 * 30),
  },
  {
    id: 'sched-3', name: 'Nightly Changelog', prompt: 'Draft a changelog entry from today\'s merged PRs.',
    cronExpression: '0 22 * * *', rendererType: 'markdown', enabled: false,
    maxRuntimeMs: 300000, maxRunsRetained: 50, nextRunAt: null, createdAt: iso(-86400_000 * 3),
  },
];

const RUNS = [
  { id: 'run-1', scheduleId: 'sched-1', scheduleName: 'Daily PR Summary', status: 'completed', startedAt: iso(-3600_000), finishedAt: iso(-3590_000), durationMs: 10_000, exitCode: 0, triggeredBy: 'schedule', rendererType: 'markdown' },
  { id: 'run-2', scheduleId: 'sched-2', scheduleName: 'Weekly Security Scan', status: 'running', startedAt: iso(-60_000), finishedAt: null, durationMs: null, exitCode: null, triggeredBy: 'manual', rendererType: 'html' },
  { id: 'run-3', scheduleId: 'sched-1', scheduleName: 'Daily PR Summary', status: 'failed', startedAt: iso(-86400_000), finishedAt: iso(-86400_000 + 8000), durationMs: 8_000, exitCode: 1, triggeredBy: 'schedule', rendererType: 'markdown' },
];

const ISSUES = [
  { number: 482, title: 'Redesign the checkout flow', state: 'open', author: { login: 'octocat' }, createdAt: iso(-86400_000 * 2), labels: [{ name: 'enhancement', color: 'a2eeef' }], assignees: [{ login: 'octocat' }], milestone: 'v2.0', comments: 4 },
  { number: 491, title: 'Checkout test is flaky under CI', state: 'open', author: { login: 'hubot' }, createdAt: iso(-86400_000), labels: [{ name: 'bug', color: 'd73a4a' }], assignees: [], milestone: null, comments: 1 },
  { number: 450, title: 'Add dark mode to the dashboard', state: 'closed', author: { login: 'octocat' }, createdAt: iso(-86400_000 * 10), labels: [{ name: 'ui', color: '5319e7' }], assignees: [{ login: 'hubot' }], milestone: 'v1.5', comments: 8 },
];

const PULLS = [
  { number: 501, title: 'Implement checkout redesign', state: 'open', draft: false, merged: false, author: { login: 'octocat' }, createdAt: iso(-3600_000), labels: [{ name: 'enhancement', color: 'a2eeef' }], milestone: 'v2.0' },
  { number: 498, title: 'WIP: refactor cart store', state: 'open', draft: true, merged: false, author: { login: 'hubot' }, createdAt: iso(-86400_000), labels: [], milestone: null },
  { number: 480, title: 'Fix login redirect loop', state: 'closed', draft: false, merged: true, author: { login: 'octocat' }, createdAt: iso(-86400_000 * 4), labels: [{ name: 'bug', color: 'd73a4a' }], milestone: 'v1.5' },
];

const MILESTONES = [
  { number: 1, title: 'v2.0', description: 'Checkout redesign and dark mode.', state: 'open', openIssues: 5, closedIssues: 12, dueOn: iso(86400_000 * 30), htmlUrl: 'https://github.com/acme/web/milestone/1' },
  { number: 2, title: 'v1.5', description: 'Stability and polish.', state: 'closed', openIssues: 0, closedIssues: 22, dueOn: iso(-86400_000 * 5), htmlUrl: 'https://github.com/acme/web/milestone/2' },
];

const AUTONOMY = {
  projectId: 'proj-web', mergeMode: 'advisory', interventionMode: 'flag_nudge',
  skillInstallMode: 'suggest_only', dnd: 0,
};

const SKILL_MARKETPLACES = [
  { name: 'copilot-plugins', source: 'github/copilot-plugins', builtin: true },
  { name: 'work-iq', source: 'work-iq/skills', builtin: false },
];

const SKILL_BROWSE = [
  { name: 'lavish-axi', description: 'Interactive HTML & Mermaid diagram review with live human feedback.' },
  { name: 'pr-reviewer', description: 'Structured pull-request review checklist.' },
  { name: 'test-writer', description: 'Generate unit tests from a diff.' },
];

const SKILL_INSTALLED = [
  { name: 'lavish-axi', marketplace: 'copilot-plugins', version: '1.4.0', enabled: true, skills: [{ name: 'review-artifact' }, { name: 'whiteboard' }] },
];

// Exact-path fixtures take priority; RegExp fixtures are tried in order after.
const FIXTURES = {
  '/api/auth/me': { user: ADMIN_USER },
  '/api/auth/login': { user: ADMIN_USER },
  '/api/projects': { projects: PROJECTS },
  '/api/delegations': { delegations: DELEGATIONS },
  '/api/admin/schedules': { schedules: SCHEDULES },
  '/api/admin/runs': { runs: RUNS },
  '/api/admin/runs/unseen-count': { count: 2 },
  '/api/admin/users': { users: [ADMIN_USER, { ...ADMIN_USER, id: 'user-2', githubLogin: 'hubot', displayName: 'Herbie User', role: 'user', email: 'herbie@example.com' }] },
  '/api/admin/sessions': { sessions: [] },
  '/api/cos/alerts': { alerts: [] },
  '/api/cos/status': { alerts: [], summary: 'All projects healthy.' },
  '/api/merge-requests': { requests: [] },
  '/api/skill-catalog/marketplaces': { marketplaces: SKILL_MARKETPLACES },
  '/api/skill-catalog/browse': { plugins: SKILL_BROWSE, marketplace: 'copilot-plugins' },
  '/api/skill-catalog/installed': { installed: SKILL_INSTALLED },
  '/api/daemon/status': {
    connected: true,
    sessions: [
      { sessionId: 'sess-a1b2c3', alive: true, exitCode: null, exitedAt: null, lastOutputAt: now - 30_000, bufferLength: 18_240, userId: 'admin-1', projectId: 'proj-web', source: 'interactive' },
      { sessionId: 'sess-d4e5f6', alive: true, exitCode: null, exitedAt: null, lastOutputAt: now - 120_000, bufferLength: 9_512, userId: 'user-2', projectId: 'proj-api', source: 'automation' },
      { sessionId: 'sess-g7h8i9', alive: false, exitCode: 0, exitedAt: now - 600_000, lastOutputAt: now - 610_000, bufferLength: 4_096, userId: 'admin-1', projectId: 'proj-web', source: 'interactive' },
    ],
  },
  '/api/daemon/sessions': { sessions: [] },
  '/api/copilot-config': {
    plugins: [
      { name: 'lavish-axi', marketplace: 'copilot-plugins', version: '1.4.0', enabled: true, skills: [{ name: 'review-artifact', description: 'Open an HTML artifact for live review.' }, { name: 'whiteboard', description: 'Edit Mermaid diagrams collaboratively.' }] },
      { name: 'pr-reviewer', marketplace: 'copilot-plugins', version: '0.9.2', enabled: false, skills: [{ name: 'review-pr', description: 'Run a structured PR review.' }] },
    ],
    mcpServers: { 'acme-tools': { type: 'stdio', command: 'npx', args: ['@acme/mcp', 'serve'] } },
    repoSkills: { agentsMd: true, customInstructions: ['.github/copilot-instructions.md'] },
  },
};

const REGEX_FIXTURES = [
  [/^\/api\/projects\/[^/]+\/autonomy$/, { settings: AUTONOMY }],
  [/^\/api\/projects\/[^/]+\/skills$/, { skills: SKILL_INSTALLED }],
  [/^\/api\/projects\/[^/]+\/mcp-servers$/, { servers: [] }],
  [/^\/api\/projects\/[^/]+\/servers$/, { servers: [] }],
  [/^\/api\/projects\/[^/]+\/lavish-artifacts$/, { artifacts: [] }],
  [/^\/api\/projects\/[^/]+\/worktrees$/, { worktrees: WORKTREES }],
  [/^\/api\/projects\/[^/]+\/github\/issues\/\d+$/, (url) => ({ issue: ISSUES.find((i) => String(i.number) === url.pathname.split('/').pop()) ?? ISSUES[0] })],
  [/^\/api\/projects\/[^/]+\/github\/issues$/, { issues: ISSUES }],
  [/^\/api\/projects\/[^/]+\/github\/pulls-by-task$/, { groups: [] }],
  [/^\/api\/projects\/[^/]+\/github\/pulls$/, { pulls: PULLS }],
  [/^\/api\/projects\/[^/]+\/github\/milestones$/, { milestones: MILESTONES }],
  [/^\/api\/projects\/[^/]+\/github\/projects$/, { projects: [] }],
  [/^\/api\/projects\/[^/]+$/, (url) => ({ project: PROJECTS.find((p) => p.id === url.pathname.split('/').pop()) ?? PROJECTS[0] })],
  [/^\/api\/admin\/schedules\/[^/]+\/runs$/, { runs: RUNS }],
  [/^\/api\/admin\/reports\/[^/]+$/, { run: { ...RUNS[0], output: '# Daily PR Summary\n\n- **#501** Implement checkout redesign — _ready for review_\n- **#498** Refactor cart store — _draft_\n\n2 open, 1 merged in the last 24h.', prompt: 'Summarize open pull requests and flag stale ones.' } }],
];

// Heuristic fallback for any un-fixtured endpoint: return `{ <lastSegment>: [] }`
// so list-style consumers (`data.projects`, `data.runs`, …) get an empty array
// instead of crashing, plus generic shapes for object consumers.
function fallbackFor(pathname) {
  const seg = pathname.split('?')[0].replace(/\/$/, '').split('/').pop() || 'items';
  return { [seg]: [], items: [], data: null, ok: true };
}

export function resolveFixture(url) {
  const pathname = url.pathname;
  if (Object.prototype.hasOwnProperty.call(FIXTURES, pathname)) return FIXTURES[pathname];
  for (const [re, val] of REGEX_FIXTURES) {
    if (re.test(pathname)) return val;
  }
  return fallbackFor(pathname);
}

// Register the mock router on a Playwright browser context.
export async function installApiMocks(context) {
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let value = resolveFixture(url);
    if (typeof value === 'function') value = value(url, request);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify(value ?? {}),
    });
  });

  // Abort outbound WebSocket upgrades (terminals/agent streams) so the browser
  // doesn't hang retrying; the surrounding UI chrome still renders.
  await context.route('**/ws/**', (route) => route.abort());
}

export { ADMIN_USER, PROJECTS };
