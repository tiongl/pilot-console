import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  GitHubCliError,
  resolveRepo,
  listMilestones,
  listIssues,
  listPullRequests,
  listLinkedProjectsV2,
  getBoard,
  listProjectLinks,
  getDefaultProjectLink,
  setProjectLinks,
  moveBoardItem,
  createBoardIssue,
  updateIssueTitle,
  removeBoardItem,
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