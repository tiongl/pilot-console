import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { createWorktreeForIssue, getWorktreeByIssueNumber } from '../../shared/project-store';
import {
  GitHubCliError,
  resolveRepo,
  listMilestones,
  listIssues,
  getIssueDetail,
  updateIssue,
  listPullRequests,
  listLinkedProjectsV2,
  getBoard,
  getProjectOverview,
  getProjectView,
  updateProjectMeta,
  getViewNameOverrides,
  setViewNameOverride,
  listProjectLinks,
  getDefaultProjectLink,
  setProjectLinks,
  createLinkedProjectV2,
  moveBoardItem,
  createBoardIssue,
  updateIssueTitle,
  removeBoardItem,
  createPullRequest,
} from '../../shared/github-store';

const router = Router({ mergeParams: true });

router.use(requireAuth);

/** The parent `:id` (project id) from the mounted path. */
const pid = (req: import('express').Request): string => (req.params as { id: string }).id;

/** Map a GitHubCliError to an HTTP status + structured body. */
function sendGhError(res: import('express').Response, err: unknown): void {
  if (err instanceof GitHubCliError) {
    const status =
      err.code === 'missing-scope' ? 403
      : err.code === 'not-authenticated' ? 401
      : err.code === 'no-remote' || err.code === 'not-found' ? 404
      : err.code === 'gh-missing' ? 500
      : 502;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: String(err), code: 'failed' });
}

const forced = (req: import('express').Request): boolean => req.query.refresh === '1' || req.query.refresh === 'true';

// GET /api/projects/:id/github/repo — owner/repo + scope status
router.get('/repo', async (req, res) => {
  try {
    res.json(await resolveRepo(pid(req), forced(req)));
  } catch (err) {
    sendGhError(res, err);
  }
});

// GET /api/projects/:id/github/milestones
router.get('/milestones', async (req, res) => {
  try {
    res.json({ milestones: await listMilestones(pid(req), forced(req)) });
  } catch (err) {
    sendGhError(res, err);
  }
});

// GET /api/projects/:id/github/issues
router.get('/issues', async (req, res) => {
  try {
    res.json({ issues: await listIssues(pid(req), forced(req)) });
  } catch (err) {
    sendGhError(res, err);
  }
});

// GET /api/projects/:id/github/issues/:number — single issue with body
router.get('/issues/:number', async (req, res) => {
  try {
    const number = Number(req.params.number);
    if (!Number.isInteger(number)) {
      res.status(400).json({ error: 'Invalid issue number' });
      return;
    }
    res.json({ issue: await getIssueDetail(pid(req), number, forced(req)) });
  } catch (err) {
    sendGhError(res, err);
  }
});

// PATCH /api/projects/:id/github/issues/:number — update title/body
router.patch('/issues/:number', async (req, res) => {
  try {
    const number = Number(req.params.number);
    if (!Number.isInteger(number)) {
      res.status(400).json({ error: 'Invalid issue number' });
      return;
    }
    const body = req.body as { title?: string; body?: string };
    const fields: { title?: string; body?: string } = {};
    if (typeof body.title === 'string') fields.title = body.title;
    if (typeof body.body === 'string') fields.body = body.body;
    if (Object.keys(fields).length === 0) {
      res.status(400).json({ error: 'title or body is required' });
      return;
    }
    await updateIssue(pid(req), number, fields);
    res.json({ issue: await getIssueDetail(pid(req), number, true) });
  } catch (err) {
    sendGhError(res, err);
  }
});

/** Build a single-line, hands-off seed prompt for a Copilot CLI session. */
function buildIssueSeedPrompt(number: number, title: string, body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim().slice(0, 600);
  const desc = flat ? ` Description: ${flat}` : '';
  return (
    `Work on GitHub issue #${number}: "${title}".${desc} ` +
    `Implement the required changes in this worktree, keeping commits focused. ` +
    `When finished, summarize what you did so I can open a pull request that closes the issue.`
  );
}

// POST /api/projects/:id/github/issues/:number/start-work — start or resume an
// issue worktree. If a worktree already exists for the issue it is returned as-is
// (resume); otherwise a new branch worktree seeded with a Copilot prompt is made.
router.post('/issues/:number/start-work', async (req, res) => {
  try {
    const projectId = pid(req);
    const number = Number(req.params.number);
    if (!Number.isInteger(number)) {
      res.status(400).json({ error: 'Invalid issue number' });
      return;
    }
    const existing = getWorktreeByIssueNumber(projectId, number);
    if (existing) {
      res.json({ worktree: existing, resumed: true });
      return;
    }
    const issue = await getIssueDetail(projectId, number, true);
    const seed = buildIssueSeedPrompt(number, issue.title, issue.body);
    const worktree = createWorktreeForIssue(projectId, number, issue.title, seed);
    res.status(201).json({ worktree, resumed: false });
  } catch (err) {
    if (err instanceof GitHubCliError) return sendGhError(res, err);
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/projects/:id/github/pulls/create — push a worktree branch + open a PR
router.post('/pulls/create', async (req, res) => {
  try {
    const body = req.body as { worktreeId?: string; title?: string; body?: string; draft?: boolean; base?: string };
    if (!body.worktreeId || !body.title?.trim()) {
      res.status(400).json({ error: 'worktreeId and title are required' });
      return;
    }
    const result = await createPullRequest(pid(req), body.worktreeId, {
      title: body.title,
      body: body.body,
      draft: body.draft,
      base: body.base,
    });
    res.status(201).json(result);
  } catch (err) {
    sendGhError(res, err);
  }
});

// GET /api/projects/:id/github/pulls
router.get('/pulls', async (req, res) => {
  try {
    res.json({ pulls: await listPullRequests(pid(req), forced(req)) });
  } catch (err) {
    sendGhError(res, err);
  }
});

// GET /api/projects/:id/github/linked-projects — Projects V2 attached to the repo
router.get('/linked-projects', async (req, res) => {
  try {
    res.json({ projects: await listLinkedProjectsV2(pid(req), forced(req)) });
  } catch (err) {
    sendGhError(res, err);
  }
});

// GET|PUT /api/projects/:id/github/links — stored project↔board associations
router.get('/links', (req, res) => {
  res.json({ links: listProjectLinks(pid(req)) });
});

router.put('/links', (req, res) => {
  const body = req.body as {
    links?: Array<{ ghProjectId: string; ghProjectNumber: number; title: string; isDefault?: boolean }>;
  };
  if (!Array.isArray(body.links)) {
    res.status(400).json({ error: 'links array required' });
    return;
  }
  res.json({ links: setProjectLinks(pid(req), body.links) });
});

// POST /api/projects/:id/github/links/create — create a new Projects V2 board and link it
router.post('/links/create', async (req, res) => {
  try {
    const body = req.body as { title?: string };
    const link = await createLinkedProjectV2(pid(req), body.title ?? '');
    res.status(201).json({ link });
  } catch (err) {
    sendGhError(res, err);
  }
});

/** Resolve the target Projects V2 id from the query or the default link. */
function resolveGhProjectId(req: import('express').Request): string | undefined {
  return (req.query.ghProjectId as string) || getDefaultProjectLink(pid(req))?.ghProjectId;
}

// GET /api/projects/:id/github/project-overview — a project's metadata + saved views
router.get('/project-overview', async (req, res) => {
  try {
    const ghProjectId = resolveGhProjectId(req);
    if (!ghProjectId) {
      res.status(404).json({ error: 'No GitHub Project linked to this project.', code: 'no-link' });
      return;
    }
    const overview = await getProjectOverview(pid(req), ghProjectId, forced(req));
    const overrides = getViewNameOverrides(pid(req), ghProjectId);
    if (Object.keys(overrides).length > 0) {
      overview.views = overview.views.map((v) =>
        overrides[v.number] ? { ...v, name: overrides[v.number] } : v,
      );
    }
    res.json({ overview });
  } catch (err) {
    sendGhError(res, err);
  }
});

// GET /api/projects/:id/github/project-view — a single saved view (board/table/roadmap)
router.get('/project-view', async (req, res) => {
  try {
    const ghProjectId = resolveGhProjectId(req);
    if (!ghProjectId) {
      res.status(404).json({ error: 'No GitHub Project linked to this project.', code: 'no-link' });
      return;
    }
    const viewNumber = Number(req.query.view);
    if (!Number.isInteger(viewNumber)) {
      res.status(400).json({ error: 'view (number) is required' });
      return;
    }
    const view = await getProjectView(pid(req), ghProjectId, viewNumber, forced(req));
    const override = getViewNameOverrides(pid(req), ghProjectId)[viewNumber];
    if (override) view.name = override;
    res.json({ view });
  } catch (err) {
    sendGhError(res, err);
  }
});

// PATCH /api/projects/:id/github/project-meta — edit project title/description/visibility
router.patch('/project-meta', async (req, res) => {
  try {
    const ghProjectId = resolveGhProjectId(req);
    if (!ghProjectId) {
      res.status(404).json({ error: 'No GitHub Project linked to this project.', code: 'no-link' });
      return;
    }
    const body = req.body as { title?: string; shortDescription?: string; public?: boolean };
    const patch: { title?: string; shortDescription?: string; public?: boolean } = {};
    if (typeof body.title === 'string') patch.title = body.title;
    if (typeof body.shortDescription === 'string') patch.shortDescription = body.shortDescription;
    if (typeof body.public === 'boolean') patch.public = body.public;
    await updateProjectMeta(pid(req), ghProjectId, patch);
    res.json({ ok: true });
  } catch (err) {
    sendGhError(res, err);
  }
});

// PATCH /api/projects/:id/github/project-view-name — set/clear a local view-name
// override. GitHub has no view-rename API, so the name is stored locally and
// applied when serving overview/view responses. Blank name clears the override.
router.patch('/project-view-name', (req, res) => {
  try {
    const ghProjectId = resolveGhProjectId(req);
    if (!ghProjectId) {
      res.status(404).json({ error: 'No GitHub Project linked to this project.', code: 'no-link' });
      return;
    }
    const body = req.body as { view?: number; name?: string | null };
    const viewNumber = Number(body.view);
    if (!Number.isInteger(viewNumber)) {
      res.status(400).json({ error: 'view (number) is required' });
      return;
    }
    setViewNameOverride(pid(req), ghProjectId, viewNumber, body.name ?? null);
    res.json({ ok: true });
  } catch (err) {
    sendGhError(res, err);
  }
});

// GET /api/projects/:id/github/board — board for a specific (or default) linked project
router.get('/board', async (req, res) => {
  try {
    const ghProjectId =
      (req.query.ghProjectId as string) || getDefaultProjectLink(pid(req))?.ghProjectId;
    if (!ghProjectId) {
      res.status(404).json({ error: 'No GitHub Project linked to this project.', code: 'no-link' });
      return;
    }
    res.json({ board: await getBoard(pid(req), ghProjectId, forced(req)) });
  } catch (err) {
    sendGhError(res, err);
  }
});

// GET /api/projects/:id/github/pulls-by-task — board items grouped w/ their linked PRs
router.get('/pulls-by-task', async (req, res) => {
  try {
    const ghProjectId =
      (req.query.ghProjectId as string) || getDefaultProjectLink(pid(req))?.ghProjectId;
    if (!ghProjectId) {
      res.status(404).json({ error: 'No GitHub Project linked to this project.', code: 'no-link' });
      return;
    }
    const board = await getBoard(pid(req), ghProjectId, forced(req));
    // Group by Status column; only items that actually have linked PRs.
    const groups = board.columns
      .map((col) => ({
        status: col.name,
        items: board.items.filter((it) => it.status === col.name && it.linkedPullRequests.length > 0),
      }))
      .concat([
        {
          status: 'No Status',
          items: board.items.filter((it) => it.status === null && it.linkedPullRequests.length > 0),
        },
      ])
      .filter((g) => g.items.length > 0);
    res.json({ title: board.title, groups });
  } catch (err) {
    sendGhError(res, err);
  }
});

// POST /api/projects/:id/github/board/item/move — set a card's Status column
router.post('/board/item/move', async (req, res) => {
  try {
    const body = req.body as {
      ghProjectId?: string;
      itemId?: string;
      fieldId?: string;
      optionId?: string | null;
    };
    const ghProjectId = body.ghProjectId || getDefaultProjectLink(pid(req))?.ghProjectId;
    if (!ghProjectId) {
      res.status(404).json({ error: 'No GitHub Project linked to this project.', code: 'no-link' });
      return;
    }
    if (!body.itemId || !body.fieldId) {
      res.status(400).json({ error: 'itemId and fieldId are required' });
      return;
    }
    await moveBoardItem(pid(req), ghProjectId, body.itemId, body.fieldId, body.optionId ?? null);
    res.json({ ok: true });
  } catch (err) {
    sendGhError(res, err);
  }
});

// POST /api/projects/:id/github/board/item/create — create an issue + add to board
router.post('/board/item/create', async (req, res) => {
  try {
    const body = req.body as {
      ghProjectId?: string;
      statusFieldId?: string | null;
      optionId?: string | null;
      title?: string;
      body?: string;
    };
    const ghProjectId = body.ghProjectId || getDefaultProjectLink(pid(req))?.ghProjectId;
    if (!ghProjectId) {
      res.status(404).json({ error: 'No GitHub Project linked to this project.', code: 'no-link' });
      return;
    }
    const title = (body.title ?? '').trim();
    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    const created = await createBoardIssue(
      pid(req),
      ghProjectId,
      body.statusFieldId ?? null,
      body.optionId ?? null,
      title,
      body.body ?? '',
    );
    res.json(created);
  } catch (err) {
    sendGhError(res, err);
  }
});

// PATCH /api/projects/:id/github/board/item — rename the issue behind a card
router.patch('/board/item', async (req, res) => {
  try {
    const body = req.body as { issueNumber?: number; title?: string };
    const title = (body.title ?? '').trim();
    if (!body.issueNumber || !title) {
      res.status(400).json({ error: 'issueNumber and title are required' });
      return;
    }
    await updateIssueTitle(pid(req), body.issueNumber, title);
    res.json({ ok: true });
  } catch (err) {
    sendGhError(res, err);
  }
});

// DELETE /api/projects/:id/github/board/item — remove a card from the board
router.delete('/board/item', async (req, res) => {
  try {
    const body = req.body as { ghProjectId?: string; itemId?: string };
    const ghProjectId = body.ghProjectId || getDefaultProjectLink(pid(req))?.ghProjectId;
    if (!ghProjectId) {
      res.status(404).json({ error: 'No GitHub Project linked to this project.', code: 'no-link' });
      return;
    }
    if (!body.itemId) {
      res.status(400).json({ error: 'itemId is required' });
      return;
    }
    await removeBoardItem(pid(req), ghProjectId, body.itemId);
    res.json({ ok: true });
  } catch (err) {
    sendGhError(res, err);
  }
});

export default router;