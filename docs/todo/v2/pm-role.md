# PM — cross-project intent & priority

**Status: NOT STARTED** — capability first (a CoS hat), standing role later.
Gated on `role-registry.md` (R0). See `agent-roles-taxonomy.md` for where it sits.

## The gap it fills

Roles today divide by altitude and axis: CoS = cross-project *awareness*, Lead =
per-project *execution*, Worker = repo *build*, Reviewer = repo *correctness*. No
role deliberately owns the leftmost slot on the intent→execution spectrum:
**what is worth building, in what order, and why** — backlog, prioritization,
acceptance criteria, roadmap coherence.

The Lead already does this *as a side job* (`record_requirements`, decision
threads, the project todo list, `review_plan`) — a player-coach doing both "what
to build" and "how to run it." That is fine at small scale and overloads at large.

## Why it belongs beside the CoS, not under a Lead

A PM's value is **cross-project prioritization and intent** — strategy altitude,
peer of the CoS, not per-project. A PM buried under one Lead is just a second Lead.

- CoS owns *awareness* ("what's happening").
- PM owns *direction* ("what should happen next").
- PM feeds prioritized requirements **down** to per-project Leads, who keep doing
  independent, single-project execution — preserving per-project Lead concurrency
  (the SDK runs one turn at a time per session; a shared coordinator serializes).

```
PM (backlog / priority / intent)  ⇄  CoS (cross-project awareness)
                                  │
              ┌───────────────────┼───────────────────┐
            Lead A              Lead B              Lead C
```

## When it earns a *separate* seat (triggers)

| Trigger | Why Lead-as-PM breaks | What a PM adds |
|---------|-----------------------|----------------|
| Many projects, one direction | each Lead optimizes its own project | one backlog across projects |
| Requirements churn | Lead context is full of execution | requirements as its primary job |
| Intent drift | workers pass review but miss the point | validates outcome vs. **intent** (distinct from reviewer's correctness check) |
| Stakeholder intake | no role turns "what the user wants" into prioritized work | the intake + prioritization funnel |

## Recommended path

1. **Now:** do **not** add a role. Give the **CoS a PM hat** — add backlog +
   prioritize + define-acceptance + validate-outcome tools to the CoS. Leads stay
   single-project. Zero new `reportsTo` hop.
2. **Later:** promote to a standalone PM role (a new `RoleDef` under R0) when
   prioritization is heavy enough to deserve its own dedicated context.

## Candidate tool surface (to pressure-test distinctness)

- `list_backlog()` / `prioritize_item(id, rank, rationale)` — cross-project queue.
- `define_acceptance(itemId, criteria)` — durable acceptance criteria artifact.
- `validate_outcome(itemId, evidence)` — does the shipped result match intent?
  (a different check from the reviewer's "is the diff correct").
- Feeds existing `record_requirements` / decision threads down to the target Lead.

## Explicit non-goal

Not a multi-project Lead. Intent scales via a single cross-project owner;
execution scales via replication (one Lead per project). See
`multi-instance-lead.md`.
