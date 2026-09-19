# Cloud Lead — re-host coordination tools behind MCP (R3, optional)

**Status: NOT STARTED (optional / later)** — only meaningful after `role-registry.md`
(R0) and `always-on-remote-lead.md` (R1/R2). Even then, a cloud sandbox is the
*wrong home* for the Lead core; the tractable cloud win is the assessor, not the
coordinator. See `cloud-agents.md`.

## Why the Lead cannot be a `copilot --cloud` session today

A `copilot --cloud` session runs in GitHub's ephemeral, per-repo sandbox
container. The Lead's power is the opposite of that — everything it needs is local:

| What the Lead needs | Where it lives | In a cloud sandbox? |
|---------------------|----------------|---------------------|
| `delegate_to_worker`, `close_worktree`, `approve_merge`, todos, decisions | in-process TS tools bound at `buildToolsForKind` (`agent-bridge.ts:1993`) | ✗ local function calls, not remote APIs |
| project memory, delegations, digests, merge queue | local SQLite via `getDb()` | ✗ not in the container |
| the worktrees it coordinates across | on disk, multiple sibling checkouts | ✗ a sandbox is one repo checkout |
| cross-worktree / cross-project view | host filesystem + DB | ✗ sandbox sees one repo only |

The SDK plumbing exists (`SessionConfig.cloud`, `remoteSession:'on'`,
`enableRemoteSessions`, `SessionMetadata.isRemote`) — the blocker is not the API,
it is that the Lead's **tools are local**. In a sandbox the Lead is an agent with
no hands.

## What a real "yes" requires

Turn the Lead's local tools into **remote calls to the control plane**:

1. Re-implement `createProjectLeadTools` (and CoS tools) as a **remote MCP/HTTP
   service** the cloud session calls over the network. R0's data-driven tool
   registry is the prerequisite that makes this expressible.
2. Back that service with the **hosted DB** (`persistent-memory-hosted-db.md`) and
   a **worktree/worker orchestrator** running on the always-on plane
   (`always-on-remote-lead.md`).
3. The sandbox then hosts only the *model + reasoning*; all *state and actions*
   stay on your infra.

```
copilot --cloud sandbox            always-on control plane
  Lead session ──MCP/HTTP──►  tool API (delegate, merge, todos, memory)
                                     │
                                     ├── hosted DB
                                     └── worktree / worker orchestrator ──► GitHub
```

## Why it is still the wrong home even after that work

- The Lead barely uses the repo checkout — it delegates code work to workers. The
  sandbox's main feature (an isolated repo container) is **wasted** on it.
- Cloud sessions are ephemeral and **cannot perceive events** (a worker finishing,
  a 60s monitor tick). The Lead is fundamentally event-driven, so you would *still*
  need the always-on plane to wake it — the sandbox buys nothing on durability.
- You would pay cloud-session cost for a role whose on-demand materialization
  already idles to near-zero on a small host.

## Verdict

- **Workers → `copilot --cloud`: yes**, natural fit (see `cloud-agents.md`).
- **Lead → `copilot --cloud`: technically possible only after re-hosting all its
  tools as a remote service, and still the wrong fit.** Keep the Lead core as an
  on-demand session on the control plane.

Rule of thumb: **cloud sessions are for the role that does repo work in isolation
(workers/assessors); the control plane is for the role that coordinates across
repos and reacts to events (Lead/CoS).** `--cloud` is a code-execution surface,
not a coordination surface.
