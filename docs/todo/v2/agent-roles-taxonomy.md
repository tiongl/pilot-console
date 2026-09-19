# Agent role taxonomy — axes vs. hats, and the unowned gaps

**Status: DESIGN NOTE** — the map that PM / Architect / Ops / cloud-assessor todos
hang off. Not a feature itself; it is the framing that keeps role proliferation
in check. Gated conceptually on `role-registry.md` (R0).

## The map: altitude × function

```
                  AWARENESS   INTENT      TECHNICAL     EXECUTION    ASSESSMENT   RUNTIME
                  (what's      (what &     COHERENCE     (build)      (is it       (after
                   happening)   why)       (does it fit)               good?)       merge)
 ┌──────────────┬───────────┬───────────┬─────────────┬────────────┬────────────┬──────────┐
 │ cross-project│  CoS ✅    │  PM 🟡    │ Architect 🟡│     —      │     —      │    —     │
 ├──────────────┼───────────┼───────────┼─────────────┼────────────┼────────────┼──────────┤
 │ per-project  │ (Lead)    │ (Lead PM  │             │  Lead ✅   │            │ ❌ Ops   │
 │              │           │  hat)     │             │(coordinate)│            │   gap    │
 ├──────────────┼───────────┼───────────┼─────────────┼────────────┼────────────┼──────────┤
 │ repo / task  │           │           │             │ Worker ✅  │ Reviewer ✅│          │
 └──────────────┴───────────┴───────────┴─────────────┴────────────┴────────────┴──────────┘
   ✅ exists   🟡 discussed (see own file)   ❌ unowned gap
```

## Distinct axes (real roles, not hats)

1. **CoS — awareness** ✅ (`docs/todo/CoS.md`) — cross-project "what's happening."
2. **Lead — per-project execution** ✅ — coordinate one project.
3. **Worker — build** ✅ — do the repo work.
4. **Reviewer — correctness assessment** ✅ (bolt-on `isReview`) — read-only "is the diff right."
5. **PM — intent / priority** 🟡 → `pm-role.md`.
6. **Architect — technical coherence** 🟡 → `architect-role.md`.
7. **Ops / runtime** ❌ → `ops-runtime-role.md` — the one cleanly-missing lifecycle phase.

## Hats, not axes (specializations under R0's lens parameter)

These recur in org analogies but are **not** new roles — each is a lens on an
existing base. Under the role registry they are a config/prompt variant.

**Assessment family (lens on `reviewer`, read-only):**

| "Role" | Really is |
|--------|-----------|
| Security reviewer | reviewer + security lens (already a `security-review` agent type) |
| Performance reviewer | reviewer + perf lens |
| Accessibility / UX reviewer | reviewer + a11y lens |
| QA / Tester | reviewer that authors tests + owns coverage strategy |

**Build family (deliverable-variant of `worker`):**

| "Role" | Really is |
|--------|-----------|
| Docs / technical writer | worker whose deliverable is docs |
| Data / migration engineer | worker scoped to schema/data |
| Refactor specialist | worker with a no-behavior-change constraint |

**Coordination family (function of `Lead`/`CoS`):**

| "Role" | Really is |
|--------|-----------|
| Planner | the Lead's `review_plan` / decomposition |
| Integrator / Merge-master | the Lead's `approve_merge` (GitHub "Agent Merge") |
| Researcher | a scoped read-only worker (already a `research` agent type) |

## Design rules that fall out of this

- **Scale execution by replication, not by widening one coordinator.** One Lead
  per project running in parallel — never a single multi-project Lead
  (see `multi-instance-lead.md` for why widening bottlenecks the turn queue).
- **Scale intent by a single cross-project owner** — CoS-as-PM now, a standalone
  PM later.
- **Add a lens before adding a role.** Only promote a lens to a standing role
  when its volume of work justifies a dedicated context.
- **Only three things are genuinely unowned axes:** PM (intent), Architect
  (technical coherence), Ops (runtime). Everything else is already covered.
