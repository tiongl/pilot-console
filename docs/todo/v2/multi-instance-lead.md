# Multi-instance Lead — all-knowing without a single bottleneck

**Status: DESIGN NOTE / DEFERRED** — resolves the original "can the Lead be
multi-instance but still all-knowing" question. Verdict: scale the Lead by
**replication + shared state**, never by widening one Lead across projects.

## The two readings

1. **Multi-instance for one project** (failover / load distribution) — several
   Lead sessions that could serve the same project, staying consistent by reading
   shared state rather than each holding private memory.
2. **One Lead spanning many projects** (a "multi-project Lead") — a single session
   coordinating N projects at once.

Reading 2 is the wrong shape and is rejected below. Reading 1 is viable and is
mostly an artifact of externalizing state (see `persistent-memory-hosted-db.md`).

## Why a multi-project Lead is wrong

The Lead is deliberately single-project because its power is **local, stateful,
and per-project**:

| Lead machinery | Scoped to |
|----------------|-----------|
| worktrees it coordinates | one project's repo |
| delegations / merge queue | one project |
| project memory (`project_memory` row) | one `project_id` |
| todos, decision threads | one project |

Widen it and you get the worst of both:

- **Context bloat** — one session holding N projects' worktrees/delegations/memory
  stops fitting; coordination gets *worse*, not broader.
- **Turn-queue serialization** — the SDK runs one turn at a time per session
  (`sendToSession` queues when busy, `agent-bridge.ts:2128-2132`). A multi-project
  Lead serializes *all* its projects through one queue; two projects can't progress
  concurrently. Per-project Leads run independently.
- **Blast radius** — one stuck mega-Lead stalls every project; today a stuck Lead
  only stalls its own.
- **Fights on-demand** — per-project Leads materialize and idle independently
  (`getOrCreatePersistentLeadSession`, `agent-bridge.ts:519`). A mega-Lead is
  either always warm (expensive) or a per-event bottleneck.

**Cross-project needs are about intent/priority and technical fit, not execution.**
Those go to the PM (`pm-role.md`) and Architect (`architect-role.md`) at CoS
altitude — not into a widened Lead.

## The viable reading: replicated per-project Lead over shared state

"All-knowing" comes from **shared durable state**, not from one omniscient session:

- Externalize the Lead's state to a shared DB (`persistent-memory-hosted-db.md`):
  `project_memory`, `delegations`, todos, decision threads all move behind
  `getDb()` to a hosted store.
- Any Lead instance for a project reads the same rows, so a second instance
  (failover, or a spun-off assessor) is consistent without private memory.
- The `spin_off_review` reviewer is already an example of a scoped second instance
  attached to the same project's worktree, reading shared state and reporting back.

## Recommendation

- **Reject** the multi-project Lead. Scale execution by **replication** (one Lead
  per project, parallel), scale intent/coherence via **CoS-altitude PM/Architect**.
- **Enable** per-project multi-instance/failover as a by-product of the hosted-DB
  work — durable shared state makes a second Lead instance safe. No dedicated
  feature needed beyond state externalization + a `reportsTo`/ownership edge (R0).
