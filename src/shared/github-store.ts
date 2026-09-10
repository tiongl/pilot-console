import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDb } from './db';
import { getProjectById } from './project-store';
import type {
  GitHubBoard,
  GitHubBoardColumn,
  GitHubBoardItem,
  GitHubIssue,
  GitHubLabel,
  GitHubMilestone,
  GitHubProjectLink,
  GitHubProjectV2Summary,
  GitHubPullRequest,
  GitHubRepoInfo,
  GitHubUserRef,
} from './types';

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error raised when a `gh` invocation fails; carries a coarse `code` for callers. */
export class GitHubCliError extends Error {
  code: 'not-authenticated' | 'missing-scope' | 'not-found' | 'no-remote' | 'gh-missing' | 'failed';
  constructor(
    message: string,
    code: GitHubCliError['code'] = 'failed',
  ) {
    super(message);
    this.name = 'GitHubCliError';
    this.code = code;
  }
}

function classifyGhError(stderr: string, err: unknown): GitHubCliError {
  const text = `${stderr}\n${err instanceof Error ? err.message : String(err)}`;
  const lower = text.toLowerCase();
  if ((err as { code?: string }).code === 'ENOENT') {
    return new GitHubCliError('The `gh` CLI is not installed or not on PATH.', 'gh-missing');
  }
  if (lower.includes('not logged') || lower.includes('authentication') || lower.includes('gh auth login')) {
    return new GitHubCliError('GitHub CLI is not authenticated. Run `gh auth login`.', 'not-authenticated');
  }
  if (lower.includes('scope') || (lower.includes('project') && lower.includes('token'))) {
    return new GitHubCliError(
      'The GitHub token is missing the `project` scope. Run `gh auth refresh -s project`.',
      'missing-scope',
    );
  }
  if (lower.includes('could not resolve to') || lower.includes('not found') || lower.includes('404')) {
    return new GitHubCliError('GitHub resource not found.', 'not-found');
  }
  return new GitHubCliError(text.trim() || 'gh command failed', 'failed');
}

// ---------------------------------------------------------------------------
// Low-level gh invocation
// ---------------------------------------------------------------------------

/** Run `gh` with args and return raw stdout. */
export async function ghRaw(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd,
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    throw classifyGhError(stderr, err);
  }
}

/** Run `gh` with args and JSON.parse stdout. */
export async function ghJson<T>(args: string[], cwd?: string): Promise<T> {
  const out = await ghRaw(args, cwd);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new GitHubCliError('Failed to parse gh JSON output', 'failed');
  }
}

/**
 * Run a GraphQL query via `gh api graphql`. Field args are passed as `-F`
 * (typed) so numbers/ids serialize correctly.
 */
export async function ghGraphql<T>(query: string, variables: Record<string, string | number> = {}): Promise<T> {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(variables)) {
    args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  }
  const res = await ghJson<{ data?: T; errors?: Array<{ message: string; type?: string }> }>(args);
  if (res.errors && res.errors.length) {
    const msg = res.errors.map((e) => e.message).join('; ');
    const scopeErr = res.errors.some((e) => /scope|INSUFFICIENT/i.test(`${e.type ?? ''} ${e.message}`));
    throw new GitHubCliError(msg, scopeErr ? 'missing-scope' : 'failed');
  }
  if (!res.data) throw new GitHubCliError('GraphQL returned no data', 'failed');
  return res.data;
}

// ---------------------------------------------------------------------------
// Simple TTL cache (in-memory only — never persisted)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expires: number;
}
const cache = new Map<string, CacheEntry<unknown>>();

/** Fetch through a short-TTL cache; `force` bypasses (and refreshes) it. */
export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>, force = false): Promise<T> {
  const now = Date.now();
  if (!force) {
    const hit = cache.get(key);
    if (hit && hit.expires > now) return hit.value as T;
  }
  const value = await loader();
  cache.set(key, { value, expires: now + ttlMs });
  return value;
}

/** Drop cache entries whose key starts with `prefix` (used after writes). */
export function invalidateCache(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Repo resolution + scope detection
// ---------------------------------------------------------------------------

const REPO_TTL_MS = 5 * 60_000;
const SCOPE_TTL_MS = 5 * 60_000;

/** Parse an owner/repo out of a git remote URL (ssh or https). */
export function parseRemoteUrl(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  // git@github.com:owner/repo(.git)?
  const ssh = trimmed.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  // https://github.com/owner/repo(.git)? (also ssh://, git://)
  const http = trimmed.match(/^(?:https?|ssh|git):\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (http) return { owner: http[1], repo: http[2] };
  return null;
}

/** Whether the server `gh` token carries the `project` scope (Projects V2). */
export async function hasProjectScope(force = false): Promise<boolean> {
  return cached(
    'scope:project',
    SCOPE_TTL_MS,
    async () => {
      // `gh api -i` prepends the HTTP status + response headers, incl. the
      // X-Oauth-Scopes header listing the token's granted scopes.
      const out = await ghRaw(['api', '-i', 'user']);
      const line = out.split(/\r?\n/).find((l) => /^x-oauth-scopes:/i.test(l));
      if (!line) return false;
      const scopes = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((s) => s.trim().toLowerCase());
      return scopes.includes('project') || scopes.includes('read:project');
    },
    force,
  );
}

/** Resolve owner/repo (+ scope status) for a console project. */
export async function resolveRepo(projectId: string, force = false): Promise<GitHubRepoInfo> {
  const info = await cached<{ owner: string; repo: string }>(
    `repo:${projectId}`,
    REPO_TTL_MS,
    async () => {
      const project = getProjectById(projectId);
      if (!project) throw new GitHubCliError('Project not found', 'not-found');
      // Prefer gh's own remote detection; fall back to parsing origin.
      try {
        const parsed = await ghJson<{ owner: { login: string }; name: string }>(
          ['repo', 'view', '--json', 'owner,name'],
          project.repoPath,
        );
        return { owner: parsed.owner.login, repo: parsed.name };
      } catch {
        const url = await gitRemoteUrl(project.repoPath);
        const parsed = url && parseRemoteUrl(url);
        if (!parsed) throw new GitHubCliError('No GitHub remote found for this project.', 'no-remote');
        return parsed;
      }
    },
    force,
  );
  const hasScope = await hasProjectScope(force);
  return {
    owner: info.owner,
    repo: info.repo,
    nameWithOwner: `${info.owner}/${info.repo}`,
    hasProjectScope: hasScope,
  };
}

async function gitRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      timeout: 5_000,
      encoding: 'utf8',
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Project ↔ GitHub Project link storage (config only, never GitHub content)
// ---------------------------------------------------------------------------

function rowToLink(row: Record<string, unknown>): GitHubProjectLink {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    ghProjectId: row.gh_project_id as string,
    ghProjectNumber: row.gh_project_number as number,
    title: row.title as string,
    isDefault: (row.is_default as number) === 1,
    createdAt: row.created_at as string,
  };
}

export function listProjectLinks(projectId: string): GitHubProjectLink[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_github_projects WHERE project_id = ? ORDER BY is_default DESC, created_at')
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToLink);
}

export function getDefaultProjectLink(projectId: string): GitHubProjectLink | null {
  const links = listProjectLinks(projectId);
  return links.find((l) => l.isDefault) ?? links[0] ?? null;
}

/** Replace the set of linked Projects V2 for a console project. */
export function setProjectLinks(
  projectId: string,
  links: Array<{ ghProjectId: string; ghProjectNumber: number; title: string; isDefault?: boolean }>,
): GitHubProjectLink[] {
  const db = getDb();
  const hasDefault = links.some((l) => l.isDefault);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM project_github_projects WHERE project_id = ?').run(projectId);
    const insert = db.prepare(
      'INSERT INTO project_github_projects (id, project_id, gh_project_id, gh_project_number, title, is_default) VALUES (?, ?, ?, ?, ?, ?)',
    );
    links.forEach((l, i) => {
      const isDefault = l.isDefault || (!hasDefault && i === 0);
      insert.run(crypto.randomUUID(), projectId, l.ghProjectId, l.ghProjectNumber, l.title, isDefault ? 1 : 0);
    });
  });
  tx();
  return listProjectLinks(projectId);
}

// ---------------------------------------------------------------------------
// GitHub reads (issues / PRs / milestones via REST; Projects V2 via GraphQL)
// ---------------------------------------------------------------------------

const READ_TTL_MS = 20_000;

function userRef(login: string | null | undefined): GitHubUserRef | null {
  if (!login) return null;
  return { login, avatarUrl: `https://github.com/${login}.png?size=40` };
}

interface RawAuthor { login?: string }
interface RawLabel { name: string; color: string }
interface RawMilestone { title?: string }

function normLabels(labels: RawLabel[] | undefined): GitHubLabel[] {
  return (labels ?? []).map((l) => ({ name: l.name, color: l.color }));
}
function normAssignees(list: RawAuthor[] | undefined): GitHubUserRef[] {
  return (list ?? []).map((a) => userRef(a.login)).filter((u): u is GitHubUserRef => u !== null);
}
function normState(s: string | undefined): 'open' | 'closed' {
  return (s ?? '').toUpperCase() === 'CLOSED' ? 'closed' : 'open';
}

export async function listMilestones(projectId: string, force = false): Promise<GitHubMilestone[]> {
  const { nameWithOwner } = await resolveRepo(projectId);
  return cached(`milestones:${nameWithOwner}`, READ_TTL_MS, async () => {
    interface Raw {
      number: number; title: string; description: string | null; state: string;
      open_issues: number; closed_issues: number; due_on: string | null; html_url: string;
    }
    const rows = await ghJson<Raw[]>([
      'api', `repos/${nameWithOwner}/milestones?state=all&per_page=100&sort=due_on`,
    ]);
    return rows.map((m) => ({
      number: m.number,
      title: m.title,
      description: m.description ?? null,
      state: m.state === 'closed' ? 'closed' : 'open',
      openIssues: m.open_issues,
      closedIssues: m.closed_issues,
      dueOn: m.due_on ?? null,
      url: m.html_url,
    }));
  }, force);
}

export async function listIssues(projectId: string, force = false): Promise<GitHubIssue[]> {
  const { nameWithOwner } = await resolveRepo(projectId);
  return cached(`issues:${nameWithOwner}`, READ_TTL_MS, async () => {
    interface Raw {
      number: number; title: string; state: string; url: string;
      author: RawAuthor | null; assignees: RawAuthor[]; labels: RawLabel[];
      milestone: RawMilestone | null; comments: unknown; createdAt: string; updatedAt: string;
    }
    const rows = await ghJson<Raw[]>([
      'issue', 'list', '-R', nameWithOwner, '--state', 'all', '--limit', '100',
      '--json', 'number,title,state,url,author,assignees,labels,milestone,comments,createdAt,updatedAt',
    ]);
    return rows.map((i) => ({
      number: i.number,
      title: i.title,
      state: normState(i.state),
      url: i.url,
      author: userRef(i.author?.login),
      assignees: normAssignees(i.assignees),
      labels: normLabels(i.labels),
      milestone: i.milestone?.title ?? null,
      comments: Array.isArray(i.comments) ? i.comments.length : typeof i.comments === 'number' ? i.comments : 0,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    }));
  }, force);
}

export async function listPullRequests(projectId: string, force = false): Promise<GitHubPullRequest[]> {
  const { nameWithOwner } = await resolveRepo(projectId);
  return cached(`pulls:${nameWithOwner}`, READ_TTL_MS, async () => {
    interface Raw {
      number: number; title: string; state: string; isDraft: boolean; url: string;
      author: RawAuthor | null; labels: RawLabel[]; milestone: RawMilestone | null;
      createdAt: string; updatedAt: string;
    }
    const rows = await ghJson<Raw[]>([
      'pr', 'list', '-R', nameWithOwner, '--state', 'all', '--limit', '100',
      '--json', 'number,title,state,isDraft,url,author,labels,milestone,createdAt,updatedAt',
    ]);
    return rows.map(normPull);
  }, force);
}

interface RawPull {
  number: number; title: string; state: string; isDraft: boolean; url: string;
  author: RawAuthor | null; labels?: RawLabel[]; milestone?: RawMilestone | null;
  createdAt: string; updatedAt: string;
}
function normPull(p: RawPull): GitHubPullRequest {
  const upper = (p.state ?? '').toUpperCase();
  const state: GitHubPullRequest['state'] = upper === 'MERGED' ? 'merged' : upper === 'CLOSED' ? 'closed' : 'open';
  return {
    number: p.number,
    title: p.title,
    state,
    isDraft: Boolean(p.isDraft),
    url: p.url,
    author: userRef(p.author?.login),
    labels: normLabels(p.labels),
    milestone: p.milestone?.title ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// --- Projects V2 (GraphQL) --------------------------------------------------

const LINKED_PROJECTS_QUERY = `query($owner:String!,$repo:String!){
  repository(owner:$owner,name:$repo){
    projectsV2(first:20,orderBy:{field:TITLE,direction:ASC}){
      nodes{ id number title url closed owner{ __typename ... on User{login} ... on Organization{login} } }
    }
  }
}`;

export async function listLinkedProjectsV2(projectId: string, force = false): Promise<GitHubProjectV2Summary[]> {
  const { owner, repo, nameWithOwner, hasProjectScope: scope } = await resolveRepo(projectId);
  if (!scope) throw new GitHubCliError('The `project` scope is required. Run `gh auth refresh -s project`.', 'missing-scope');
  return cached(`linked-projects:${nameWithOwner}`, READ_TTL_MS, async () => {
    interface Resp {
      repository: { projectsV2: { nodes: Array<{
        id: string; number: number; title: string; url: string; closed: boolean;
        owner: { login?: string };
      }> } } | null;
    }
    const data = await ghGraphql<Resp>(LINKED_PROJECTS_QUERY, { owner, repo });
    const nodes = data.repository?.projectsV2.nodes ?? [];
    return nodes.map((n) => ({
      id: n.id,
      number: n.number,
      title: n.title,
      url: n.url,
      closed: n.closed,
      ownerLogin: n.owner?.login ?? '',
    }));
  }, force);
}

const BOARD_QUERY = `query($id:ID!,$cursor:String){
  node(id:$id){
    ... on ProjectV2 {
      number title
      fields(first:50){ nodes{ __typename ... on ProjectV2SingleSelectField { id name options{ id name } } } }
      items(first:50,after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id
          fieldValues(first:20){ nodes{ __typename ... on ProjectV2ItemFieldSingleSelectValue { name optionId field{ __typename ... on ProjectV2SingleSelectField { id name } } } } }
          content{
            __typename
            ... on Issue { number title url state assignees(first:10){nodes{login}} labels(first:10){nodes{name color}} closedByPullRequestsReferences(first:10){ nodes{ number title url state isDraft author{login} createdAt updatedAt } } }
            ... on PullRequest { number title url state isDraft author{login} assignees(first:10){nodes{login}} labels(first:10){nodes{name color}} createdAt updatedAt }
            ... on DraftIssue { title }
          }
        }
      }
    }
  }
}`;

interface BoardField { __typename: string; id?: string; name?: string; options?: Array<{ id: string; name: string }> }
interface BoardFieldValue {
  __typename: string; name?: string; optionId?: string;
  field?: { __typename: string; id?: string; name?: string };
}
interface BoardContent {
  __typename: 'Issue' | 'PullRequest' | 'DraftIssue';
  number?: number; title?: string; url?: string; state?: string; isDraft?: boolean;
  author?: RawAuthor; assignees?: { nodes: RawAuthor[] }; labels?: { nodes: RawLabel[] };
  closedByPullRequestsReferences?: { nodes: RawPull[] };
  createdAt?: string; updatedAt?: string;
}
interface BoardNode {
  node: {
    number: number; title: string;
    fields: { nodes: BoardField[] };
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ id: string; fieldValues: { nodes: BoardFieldValue[] }; content: BoardContent | null }>;
    };
  } | null;
}

/** Fetch a Projects V2 board (columns from the Status field + items w/ linked PRs). */
export async function getBoard(projectId: string, ghProjectId: string, force = false): Promise<GitHubBoard> {
  const { hasProjectScope: scope } = await resolveRepo(projectId);
  if (!scope) throw new GitHubCliError('The `project` scope is required. Run `gh auth refresh -s project`.', 'missing-scope');
  return cached(`board:${ghProjectId}`, READ_TTL_MS, async () => {
    let cursor: string | null = null;
    let title = '';
    let number = 0;
    let statusField: BoardField | undefined;
    const rawItems: BoardNode['node'] extends null ? never : NonNullable<BoardNode['node']>['items']['nodes'] = [];
    // Paginate items (cap pages to stay bounded).
    for (let page = 0; page < 20; page++) {
      const vars: Record<string, string> = { id: ghProjectId };
      if (cursor) vars.cursor = cursor;
      const data: BoardNode = await ghGraphql<BoardNode>(BOARD_QUERY, vars);
      const node = data.node;
      if (!node) throw new GitHubCliError('Project not found', 'not-found');
      title = node.title;
      number = node.number;
      if (!statusField) {
        const singles = node.fields.nodes.filter((f) => f.__typename === 'ProjectV2SingleSelectField');
        statusField = singles.find((f) => (f.name ?? '').toLowerCase() === 'status') ?? singles[0];
      }
      rawItems.push(...node.items.nodes);
      if (!node.items.pageInfo.hasNextPage) break;
      cursor = node.items.pageInfo.endCursor;
      if (!cursor) break;
    }

    const columns: GitHubBoardColumn[] = (statusField?.options ?? []).map((o) => ({ id: o.id, name: o.name }));
    const statusFieldId = statusField?.id ?? null;

    const items: GitHubBoardItem[] = rawItems.map((it) => {
      const c = it.content;
      const statusValue = it.fieldValues.nodes.find(
        (v) => v.__typename === 'ProjectV2ItemFieldSingleSelectValue' && v.field?.id === statusFieldId,
      );
      const contentType = (c?.__typename ?? 'DraftIssue') as GitHubBoardItem['contentType'];
      const linkedPullRequests: GitHubPullRequest[] =
        c?.__typename === 'PullRequest'
          ? [normPull({
              number: c.number!, title: c.title ?? '', state: c.state ?? 'OPEN', isDraft: Boolean(c.isDraft),
              url: c.url ?? '', author: c.author ?? null, labels: c.labels?.nodes, createdAt: c.createdAt ?? '', updatedAt: c.updatedAt ?? '',
            })]
          : c?.__typename === 'Issue'
            ? (c.closedByPullRequestsReferences?.nodes ?? []).map(normPull)
            : [];
      return {
        itemId: it.id,
        contentType,
        title: c?.title ?? '(draft)',
        number: c?.number ?? null,
        url: c?.url ?? null,
        state: c?.state ? normState(c.state) : null,
        status: statusValue?.name ?? null,
        assignees: normAssignees(c?.assignees?.nodes),
        labels: normLabels(c?.labels?.nodes),
        linkedPullRequests,
      };
    });

    return { projectId: ghProjectId, projectNumber: number, title, statusFieldId, columns, items };
  }, force);
}

// ---------------------------------------------------------------------------
// Writes (require the `project` scope)
// ---------------------------------------------------------------------------

const MOVE_MUTATION = `
mutation($project:ID!, $item:ID!, $field:ID!, $value:String!) {
  updateProjectV2ItemFieldValue(input:{ projectId:$project, itemId:$item, fieldId:$field, value:{ singleSelectOptionId:$value } }) {
    projectV2Item { id }
  }
}`;

const CLEAR_MUTATION = `
mutation($project:ID!, $item:ID!, $field:ID!) {
  clearProjectV2ItemFieldValue(input:{ projectId:$project, itemId:$item, fieldId:$field }) {
    projectV2Item { id }
  }
}`;

/**
 * Set (or clear) a board item's Status single-select value. Passing a null/empty
 * `optionId` moves the card to "No Status". Invalidates the cached board so the
 * next read reflects the change.
 */
export async function moveBoardItem(
  projectId: string,
  ghProjectId: string,
  itemId: string,
  fieldId: string,
  optionId: string | null,
): Promise<void> {
  const { hasProjectScope: scope } = await resolveRepo(projectId);
  if (!scope) throw new GitHubCliError('The `project` scope is required. Run `gh auth refresh -s project`.', 'missing-scope');
  if (optionId) {
    await ghGraphql(MOVE_MUTATION, { project: ghProjectId, item: itemId, field: fieldId, value: optionId });
  } else {
    await ghGraphql(CLEAR_MUTATION, { project: ghProjectId, item: itemId, field: fieldId });
  }
  invalidateCache(`board:${ghProjectId}`);
}

const ADD_ITEM_MUTATION = `
mutation($project:ID!, $content:ID!) {
  addProjectV2ItemById(input:{ projectId:$project, contentId:$content }) {
    item { id }
  }
}`;

const DELETE_ITEM_MUTATION = `
mutation($project:ID!, $item:ID!) {
  deleteProjectV2Item(input:{ projectId:$project, itemId:$item }) {
    deletedItemId
  }
}`;

/**
 * Create a new GitHub issue in the repo, add it to the board, and optionally set
 * its Status column. Returns the created item's identifiers. Invalidates caches
 * that would otherwise hide the new issue/card.
 */
export async function createBoardIssue(
  projectId: string,
  ghProjectId: string,
  statusFieldId: string | null,
  optionId: string | null,
  title: string,
  body: string,
): Promise<{ itemId: string; number: number; url: string }> {
  const { owner, repo, nameWithOwner, hasProjectScope: scope } = await resolveRepo(projectId);
  if (!scope) throw new GitHubCliError('The `project` scope is required. Run `gh auth refresh -s project`.', 'missing-scope');

  const created = await ghJson<{ number: number; node_id: string; html_url: string }>([
    'api', `repos/${owner}/${repo}/issues`, '-f', `title=${title}`, '-f', `body=${body}`,
  ]);

  const added = await ghGraphql<{ addProjectV2ItemById: { item: { id: string } } }>(ADD_ITEM_MUTATION, {
    project: ghProjectId,
    content: created.node_id,
  });
  const itemId = added.addProjectV2ItemById.item.id;

  if (optionId && statusFieldId) {
    await ghGraphql(MOVE_MUTATION, { project: ghProjectId, item: itemId, field: statusFieldId, value: optionId });
  }

  invalidateCache(`board:${ghProjectId}`);
  invalidateCache(`issues:${nameWithOwner}`);
  return { itemId, number: created.number, url: created.html_url };
}

/** Rename the issue backing a board item (via the REST issues API). */
export async function updateIssueTitle(projectId: string, issueNumber: number, title: string): Promise<void> {
  const { owner, repo, nameWithOwner, hasProjectScope: scope } = await resolveRepo(projectId);
  if (!scope) throw new GitHubCliError('The `project` scope is required. Run `gh auth refresh -s project`.', 'missing-scope');
  await ghJson([
    'api', `repos/${owner}/${repo}/issues/${issueNumber}`, '-X', 'PATCH', '-f', `title=${title}`,
  ]);
  invalidateCache(`board:`); // any linked board may show this item
  invalidateCache(`issues:${nameWithOwner}`);
}

/** Remove a card from the board (does not delete the underlying issue/PR). */
export async function removeBoardItem(projectId: string, ghProjectId: string, itemId: string): Promise<void> {
  const { hasProjectScope: scope } = await resolveRepo(projectId);
  if (!scope) throw new GitHubCliError('The `project` scope is required. Run `gh auth refresh -s project`.', 'missing-scope');
  await ghGraphql(DELETE_ITEM_MUTATION, { project: ghProjectId, item: itemId });
  invalidateCache(`board:${ghProjectId}`);
}
