# Role registry — collapse kinds + isReview into a declarative role model (R0)

**Status: NOT STARTED** — foundational refactor. Enables the PM, Architect, and
Ops roles, and the always-on / cloud phases, to slot in as configuration rather
than surgery. Pure refactor, no behavior change; existing tests are the contract.

## Problem

The agent role model today is a flat enum plus a bolt-on boolean:

- `AgentSessionKind = 'agent' | 'project_lead' | 'chief_of_staff'` (`src/shared/types.ts:81`).
- The reviewer is not a role — it is `kind:'agent'` + an `options.isReview` boolean
  (`agent-bridge.ts:2063`, `:2091`) whose only job is to strip the merge tools
  (`agent-bridge.ts:2008-2016`), persisted as `delegations.is_review` (`db.ts:231`).
- Tools are selected by a `switch` in `buildToolsForKind` (`agent-bridge.ts:1993`);
  system instructions by a parallel `switch` in `buildSystemInstructions`.
- Relations (who reports to whom) are implicit/scope-derived — there is no stored
  `reportsTo` edge (the `delegations` schema `db.ts:220-237` has no parent link).

Every new role today means touching all of those switches by hand. That does not
scale to PM / Architect / Ops, and it makes the reviewer a special case forever.

## The key insight: a few *base roles* × *lens* × *altitude*, not an enum of seats

Almost the entire org reduces to three primitives:

| Primitive | What it does | Today |
|-----------|--------------|-------|
| **coordinator** | orchestrates other agents, holds state, reacts to events | Lead, CoS |
| **worker** | does scoped repo work, produces a deliverable | worker |
| **assessor** | read-only judgment, never mutates | reviewer (`isReview`) |

Everything else people call a "role" is a **lens** on one of these (security /
perf / QA / docs / refactor / research = a lens on assessor or worker) or an
**altitude** (repo → project → cross-project). Model *that*, not fifteen seats.

## Proposed shape

A `src/shared/roles.ts` registry keyed by role id, each entry declaring:

```ts
interface RoleDef {
  id: string;                     // 'project_lead' | 'chief_of_staff' | 'worker' | 'reviewer' | …
  base: 'coordinator' | 'worker' | 'assessor';
  altitude: 'repo' | 'project' | 'cross_project';
  tools: (ctx) => Tool[];         // replaces the buildToolsForKind switch
  systemInstructions: (ctx) => string;
  capabilities: {                 // capability flags, not assumptions
    canMerge: boolean;
    canDelegate: boolean;
    mutatesRepo: boolean;         // false for every assessor
    lens?: string;                // 'security' | 'perf' | 'architecture' | …
  };
  reportsTo?: string;             // explicit edge, replaces scope-derived guessing
  concurrencyBucket: string;      // reviewers already counted separately today
}
```

- `buildToolsForKind` / `buildSystemInstructions` become table lookups.
- `isReview` becomes `base === 'assessor'` (or a `reviewer` role id); the
  merge-tool stripping is expressed as `capabilities.canMerge === false`.
- `reportsTo` becomes a stored edge on `delegations`, not inferred from scope.

## Tasks

1. Add `src/shared/roles.ts` with the registry and the four current roles
   (`project_lead`, `chief_of_staff`, `worker`, `reviewer`) reproducing today's
   exact tool sets and instructions.
2. Replace the `buildToolsForKind` / `buildSystemInstructions` switches with
   registry lookups. Keep `AgentSessionKind` as a type alias over role ids for
   one release so nothing downstream breaks.
3. Make `reviewer` a first-class role id; keep `delegations.is_review` populated
   from `base === 'assessor'` for backward compatibility, add a `role` column.
4. Add an explicit `reportsTo` edge column to `delegations` (nullable, migration).
5. Prove it is a pure refactor — the existing agent-bridge / delegation tests
   stay green with no assertion changes.

## Why this is R0

It is the enabler for everything else in `docs/todo/v2/`:

- **PM / Architect / Ops** become new `RoleDef` entries + tool modules, not new switches.
- **Review lenses** (security / perf / a11y / QA) become a `lens` parameter on the
  assessor base, not four new roles.
- **Cloud Lead** (see `cloud-lead.md`) needs the tool set expressed as data so it
  can be re-hosted behind MCP.
- **reportsTo** is a prerequisite for durable, restart-safe hierarchy reconstruction.
