# Chief of Staff (CoS)

## Overview
A meta-agent layer that oversees all projects a user is working on: sequencing work,
parallelizing where safe, flagging conflicts, gating merges, and answering questions
about portfolio status — without needing to hold full context of every project at once.

Three-tier agent hierarchy:

```
Chief of Staff  (portfolio-level, one per user)
      │
Project Lead    (project-level, one per project)
      │
Worktree Agent  (existing agent sessions — unchanged, N per worktree)
```

- **Chief of Staff** — cross-project prioritization, sequencing, portfolio status,
  merge-queue prioritization across projects. Talks to the user from Home.
- **Project Lead** — owns one project's full picture: all its worktrees, conventions,
  conflicts between features, plan review, merge validation. Acts as a context
  firewall so CoS never needs project-level implementation detail. It is also the
  requirements owner: before delegating work, it must clarify the desired outcome,
  constraints, acceptance criteria, and unresolved decisions with the user.
- **Worktree Agent** — unchanged from today. Does the actual work, reports up.

Compartmentalization is architectural, not a memory trick: CoS never ingests raw
transcripts. It only reads small structured rows (digests, decision records, audit
summaries) written by Project Leads.

## Data Model (new SQLite tables)

```sql
-- Rolling per-worktree status, written by the worktree agent itself.
CREATE TABLE agent_digests (
  worktree_id   TEXT PRIMARY KEY REFERENCES worktrees(id),
  project_id    TEXT NOT NULL,
  headline      TEXT,        -- "Implementing OAuth refresh flow"
  status        TEXT,        -- in_progress | blocked | ready_to_merge | idle
  detail        TEXT,        -- 2-4 sentence summary
  scope         TEXT,        -- small | medium | large (self-reported)
  touched_files TEXT,        -- JSON array, for conflict detection
  risk_notes    TEXT,
  stuck_since   TEXT,         -- computed, not self-reported (see Stuck Detection)
  updated_at    TEXT
);

-- One merge lock per project — at most one worktree merges to master at a time.
CREATE TABLE merge_locks (
  project_id        TEXT PRIMARY KEY REFERENCES projects(id),
  held_by_worktree_id TEXT REFERENCES worktrees(id),
  held_since        TEXT,
  expires_at        TEXT      -- auto-release timeout, see Corner Cases
);

-- Merge request queue, project-scoped, one active request per worktree.
CREATE TABLE merge_requests (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  worktree_id   TEXT NOT NULL UNIQUE,  -- enforces one pending/active request per worktree
  branch        TEXT NOT NULL,
  status        TEXT NOT NULL,   -- pending | approved | merging | merged | rejected | conflict
  priority      TEXT,            -- normal | urgent (manual override, see Corner Cases)
  requested_at  TEXT,
  resolved_at   TEXT,
  summary       TEXT,
  lead_note     TEXT             -- Project Lead's reasoning for approve/reject/defer
);

-- Decision threads: Project Lead <-> user planning conversations, resumable.
CREATE TABLE decision_threads (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  title                 TEXT,
  question              TEXT,
  status                TEXT,    -- open | resolved | paused
  session_id            TEXT,    -- backing agent session for resume
  decision              TEXT,
  rationale             TEXT,
  alternatives_considered TEXT,
  user_verdict          TEXT,
  follow_up_actions     TEXT,
  created_at            TEXT,
  updated_at            TEXT
);

-- Two-tier audit log. Project Lead writes detailed entries; CoS writes rollups.
CREATE TABLE project_audit_log (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  actor       TEXT,     -- 'project_lead' | 'worktree_agent:<id>'
  action      TEXT,     -- approve_merge | reject_merge | create_worktree | nudge_worker | ...
  reasoning   TEXT,
  risk_level  TEXT,      -- low | medium | high
  created_at  TEXT
);

CREATE TABLE portfolio_audit_log (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  summary     TEXT,       -- one-line rollup of a project_audit_log entry
  risk_level  TEXT,
  source_entry_id TEXT REFERENCES project_audit_log(id),
  created_at  TEXT
);

-- Per-project autonomy configuration.
CREATE TABLE project_autonomy_settings (
  project_id      TEXT PRIMARY KEY REFERENCES projects(id),
  merge_mode      TEXT DEFAULT 'advisory',   -- advisory | auto_queue | full_auto
  intervention_mode TEXT DEFAULT 'flag_only', -- flag_only | flag_nudge | flag_nudge_cancel
  dnd             INTEGER DEFAULT 0           -- mute proactive nudges for this project
);
```

Reuses the existing `project_todos` table for planning artifacts rather than
inventing a parallel task-tracking concept.

## Tool Surface (SDK `defineTool`, in-process, no MCP server)

**Given to Worktree Agents:**
- `update_digest(headline, status, detail, scope, touched_files?, risk_notes?)`
- `request_merge(summary)` — creates/updates its own `merge_requests` row (unique per worktree)
- `check_merge_status()`

**Given to Project Leads:**
- `list_worktrees(projectId)`, `get_digest(worktreeId)`, `list_digests(projectId)`
- `detect_conflicts(projectId)` — pure function: diffs `touched_files` across active
  worktrees in the same project, returns candidates (not a verdict)
- `approve_merge(requestId)` / `reject_merge(requestId, reason)` — governed by
  `merge_mode`; writes `project_audit_log` + sends CoS a summary in the same transaction
- `review_plan(worktreeId, plan)` — called when a worker hits its exit-plan gate;
  returns approve / approve-with-note / request-changes / escalate-to-user
- `nudge_worker(worktreeId, message)` — Tier 1 soft intervention (see Intervention Model)
- `cancel_worker(worktreeId, reason)` — Tier 2 hard intervention, gated by `intervention_mode`
- `bootstrap_digest(worktreeId)` — one-time cold-start seed from recent git log + transcript

**Given to CoS:**
- `list_projects()`, `list_project_status(projectId)` — reads Project Lead rollups only
- `list_merge_queue()` — cross-project queue view
- `prioritize_merge(requestId, priority)` — cross-project sequencing only; actual
  approve/reject stays with Project Lead
- `create_project(...)`, `create_worktree(...)` — call directly into existing
  `project-store.ts` functions, same code path as the manual UI buttons
- `open_decision_thread(projectId, question)` — creates a Project Lead handoff tab

## Merge Flow

1. Worker calls `request_merge` → row created, unique per worktree.
2. Project Lead runs `detect_conflicts` (mechanical, no LLM turn) — if clean and
   scope is small, auto-resolves per `merge_mode`. No contention with any live
   chat, since this never touches an LLM turn.
3. If ambiguous (overlapping files, large scope, or `merge_mode: advisory`),
   queues for Project Lead judgment — delivered next time that Lead's session is idle,
   not force-injected mid-conversation.
4. Project Lead approves/rejects/defers, logs to `project_audit_log`, sends CoS a
   one-line summary for `portfolio_audit_log`.
5. Actual merge execution is server-side (`gh pr create`, optional `--auto`), not
   delegated to the worker's own shell access — reliable and independent of the
   worker's tool-use judgment.
6. `merge_mode: full_auto` allows PR auto-merge without a human click; anything
   less requires your final "ship it."

## Plan-Gated Execution

For anything above `scope: small`, the worker runs in **plan mode** (existing
product feature) instead of autopilot. Its exit-plan request routes to the
Project Lead first:

- **Approve** — worker proceeds silently.
- **Approve with note** — proceeds, note logged to project audit trail.
- **Request changes** — sent back to the worker before the user ever sees it.
- **Escalate** — surfaces to the user via the existing exit-plan-approval UI,
  pre-annotated with Project Lead's reasoning.

Small-scope tasks skip this gate entirely and run in autopilot to avoid review
ceremony on trivial changes.

## Requirements Gathering

The Project Lead must collect and confirm requirements before asking a Worktree
Agent to implement a non-trivial item. Requirements are a first-class project
artifact, not informal context passed through prompts. The Lead should establish:

- desired outcome and user-visible behavior;
- scope boundaries and explicit non-goals;
- acceptance criteria and validation/test expectations;
- dependencies, compatibility constraints, and affected worktrees;
- unanswered questions, assumptions, and the decision owner.

The Lead presents a concise understanding back to the user for confirmation when
the request is ambiguous, high-risk, cross-cutting, or likely to create competing
work. Once confirmed, the Lead records the requirements with the relevant
`project_todos` item or `decision_threads` record and uses that record as the
source of truth for the worker's plan review.

Requirements gathering should not block genuinely small, unambiguous fixes. For
those, the Lead may infer a minimal requirement from the request, state the
assumption in the worker task, and proceed. If the worker discovers a
requirement gap or a material change in scope, it must stop at a plan boundary
and return to the Project Lead rather than guessing.

## Intervention Model (mid-execution)

Tiered, never defaults to a silent hard stop:

1. **Flag only** (default) — logged + dashboard badge, no action on the running agent.
2. **Soft nudge** — message injected at the worker's next natural turn boundary,
   non-destructive, preserves in-progress work.
3. **Hard cancel** — uses the existing `cancelAgent` mechanism (same as user's
   Escape-to-stop). Reserved for high-confidence danger (destructive commands,
   detected infinite loop). Even when `intervention_mode` allows it, defaults to
   asking the user for confirmation rather than acting silently.

Rationale: cancelling mid-turn can leave a worktree in an inconsistent state
(half-written file, orphaned permission prompt) — a strictly worse outcome than
a delayed flag in most cases.

## Stuck Detection

`stuck_since` is a computed field, not self-reported (agents are poor judges of
their own stuckness). Triggers:
- Idle-busy-idle churn or repeated similar tool calls past a threshold
- Unanswered permission/exit-plan prompt past a threshold

Explicitly excludes "waiting on human input" as a distinct healthy state — this
must never be conflated with "stuck," or the badge stops being trustworthy.

## Three-Way / Handoff Conversations

- Default is two separate lanes: user↔CoS (portfolio) and user↔Project Lead
  (technical), not a merged chat.
- CoS can open a **decision thread** — a dedicated Project Lead tab scoped to one
  question, backed by `decision_threads` (keyed by `projectId + decisionThreadId`)
  so it's resumable ("ask the Project Lead about that again" reopens the same
  thread with full prior context, not a new conversation).
- CoS can explicitly **defer** to the user + Project Lead alone when the question
  is too technical for CoS to usefully participate, rejoining only after a verdict
  is reached, via a structured handoff record (decision, reason, portfolio
  implication) rather than replaying the full sub-conversation into CoS's context.
- Closing a decision-thread tab without confirming a decision must not be treated
  as implicit agreement — UI explicitly prompts confirm / leave unresolved / keep open.
- A true three-way (user + CoS + Project Lead) room is available on demand
  ("consult Project Lead"), with strict turn-taking (one speaker at a time),
  clear role attribution, and forced closure after 1-2 rounds of disagreement
  ("ask the user to decide" rather than looping).

## UI

- **Home tab** — persistent CoS chat + portfolio dashboard (project → worktree
  status rows, stuck/conflict/ready-to-merge badges).
- **Floating widget** (mounted globally in `DashboardLayout`, outside the route
  outlet) — two-layer aggregated view:
  - Layer 1: CoS's own short portfolio synthesis line (regenerates on meaningful
    state change, not on every digest tick).
  - Layer 2: per-project rows sourced directly from Project Lead status/audit
    logs (no re-synthesis, cheap, reactive).
  - Defaults to quiet; only notable rows (stuck/conflict/awaiting decision) are
    emphasized. Respects per-project `dnd` setting.
- **Decision thread tabs** — opened by CoS, reusable, listed/searchable per project.
- **Worktree/project tabs** — entirely unchanged; manual navigation as today.
- **Recent actions feed** — project page shows the Project Lead's detailed audit
  log; Home shows CoS's compact cross-project rollup, deep-linking to full entries.

## Corner Cases & Mitigations

Treated as non-negotiable baseline, not day-2 polish:
- **Stale merge lock** — auto-expire/flag-for-review after a timeout; manual
  "force release" button on the dashboard.
- **Duplicate merge requests** — `UNIQUE` constraint on `worktree_id` in
  `merge_requests`.
- **Belief-state drift** — before trusting a lock/digest, cheap live reconciliation
  against existing read-only git endpoints (`git-status`/`git-log`), not blind
  reads from the DB.
- **Auto-merge trust** — `merge_mode` starts at `advisory` for every project;
  escalate only deliberately, never default to full autonomy.

Mitigated with an explicit manual override, not fully automatable:
- **Notification fatigue** — escalation thresholds default conservative/quiet.
- **False stuck alarms** — explicit human-input-wait exclusion (see Stuck Detection).
- **Backlog dump after being away** — CoS batches/summarizes queued items into "N
  things happened, here's the one that needs a decision," not chronological replay.
- **Priority inversion** — manual "bump to front" override always available on
  the merge queue (`priority` column); no attempt to auto-infer business urgency.

Out of scope for v1 (explicit non-goal):
- **Cross-project dependency sequencing** — Project Lead reasons within one
  project only, by design (compartmentalization). If Project A must land before
  Project B, the user declares that edge explicitly; CoS does not attempt to
  infer cross-project ordering automatically.

## Phased Build Plan

1. **Digest plumbing** — `agent_digests` table, `update_digest` tool wired into
   worktree agents, `bootstrap_digest` cold-start seed, dashboard renders live
   per-worktree status. No CoS/Project Lead agents yet.
2. **Project Lead session** — new session kind, project-scoped tools
   (`list_digests`, `detect_conflicts`, plan review), decision threads, project
   audit log.
3. **Chief of Staff session** — portfolio tools, Home tab, floating widget
   (two-layer aggregation), portfolio audit rollup, autonomy settings UI.
4. **Merge queue** — `merge_requests`/`merge_locks`, `request_merge`/
   `approve_merge`, PR-based execution, stale-lock timeout + force-release.
5. **Intervention & plan-gating** — plan-mode routing through Project Lead review,
   nudge/cancel tools gated by `intervention_mode`, stuck detection.
6. **Trust tooling** — digest thumbs-down → live spot-check, decision-thread
   search, background token budget/backoff for proactive checks.
