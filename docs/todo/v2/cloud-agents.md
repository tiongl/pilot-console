# Cloud agents — workers and the cloud-portable assessor

**Status: NOT STARTED** — the roles that *do* fit `copilot --cloud`. Complements
`cloud-lead.md` (why the coordinator does not fit).

## Copilot cloud sandbox, in one line

Per-repo, ephemeral, isolated, billed, public-preview compute hosted by GitHub —
distinct from but inheriting policies from the coding agent (GHCO). A natural fit
for any role whose work is **single-repo, self-contained, and (for the assessor)
read-only**.

## Workers → cloud sandbox (natural fit)

A builder worker needs exactly what a sandbox provides: one repo checkout, isolated
compute, its own tools. Pushing workers to cloud sandboxes:

- **Offloads the heaviest, most variable cost** (agent token burn) to the user's
  own Copilot entitlement — GitHub runs it, not you (see `saas-multi-tenant.md`).
- **Gives isolation for free** — GitHub walls off each sandbox, which is most of
  the per-tenant isolation a SaaS needs.
- Keeps the Lead/CoS coordinating from the control plane; only the code-grinding
  moves off-machine.

## Cloud-portable assessor — `spin_off_review` in a sandbox

Assessment is the **one split of the Lead that ports cleanly to `copilot --cloud`**,
because it is inherently single-repo and read-only — unlike the Lead core.

Today `spin_off_review` (`project-lead-tools.ts:582`) already spawns a read-only
review persona into the worker's existing worktree: it may read the diff and run
tests but never commits (`isReview` structurally strips merge tools,
`agent-bridge.ts:2010-2014`), carries the Lead's focus brief, and reports a
pass / changes-needed verdict back (`digest-tools.ts`, optional `deepMerge`). It
runs on its own concurrency budget (`project-lead-tools.ts:46`).

The cloud version: when a worker runs in a cloud sandbox, the assessor **attaches
to that same sandbox/checkout (or a fresh cloud session on the same branch)** and
assesses there — read diff, run tests, report verdict — **without the Lead ever
leaving the control plane** and without burning the Lead's context.

```
Lead (control plane) ──spin_off_review focus──► review persona
                                                   │ (in the worker's cloud repo)
  copilot --cloud sandbox:  worker builds ──────► assessor reads diff + runs tests
                                                   │
              verdict + reasoning ◄───────────────┘  ──► back to Lead
```

### The one orchestration caveat

Today the reviewer is serialized against its builder in the *same* worktree
(`delegation-store.ts:95`) so it never runs tests mid-write. In a cloud sandbox,
review a **frozen branch/commit** (worker done) or a **separate checkout of the
same ref**, so the assessor gets a stable tree. A small orchestration detail, not
a blocker.

## Why this decomposition is clean

| Role | Scope | State needed | Mutates? | Fits a sandbox? |
|------|-------|--------------|----------|-----------------|
| Lead / CoS (coordinate) | cross-worktree / cross-project | delegations, memory, merge queue | yes | ✗ |
| Worker (build) | one repo | just the task | yes | ✅ |
| Assessor (review) | one repo | just the diff + tests | **no** | ✅ (best fit) |

The rule that keeps recurring: **cloud sessions are for repo-scoped work
(workers/assessors); the control plane is for coordination (Lead/CoS).**

## Tasks (when pursued)

1. Route builder workers to a cloud sandbox via `SessionConfig.cloud` /
   `remoteSession:'on'` (needs `enableRemoteSessions` on the daemon `forTcp`
   runtime — see `always-on-remote-lead.md`).
2. Extend `spin_off_review` to target a cloud sandbox / frozen ref rather than a
   local sibling worktree; keep the verdict/merge-back path unchanged.
3. Thread the worker's cloud `copilot_session_id` through `delegations` so the
   assessor can attach and the Lead can track it.
