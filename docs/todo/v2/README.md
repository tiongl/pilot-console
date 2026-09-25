# v2 — SaaS re-platforming + role-model evolution

**Status: NOT STARTED (strategy / milestone grouping)**

v2 is the architectural leap from a **single-tenant desktop app** (one process,
one user, local SQLite, local worktrees, in-process tools) to a **hosted,
multi-tenant, event-driven platform** with a richer agent org. Everything in this
folder is v2; nothing here is a small incremental feature — each item changes the
architecture, and they share prerequisites.

The through-line: **externalize state, host the control plane, push repo work to
cloud compute, and express roles as data** so the org can grow beyond
CoS→Lead→worker.

## Hard invariant: local mode is the default, cloud is opt-in

**Non-negotiable constraint on every v2 item.** v2 must be *one codebase with
opt-in cloud switches*, never a fork into a "local build" and a "cloud build". A
solo user running locally must experience **near-zero behavioral change**: same
UI, same on-disk worktrees, same local SQLite file, no login, no hosted services.

The rules that make that true:

1. **Local is the default branch at every seam; cloud/hosted is opt-in on the
   *same* seam.** One `getDb()` interface (local SQLite default, hosted adapter
   opt-in). One delegation path (local worktree + local session default,
   `remoteSession` opt-in). One role registry serving both the local org and any
   new roles. Never a parallel implementation.

2. **Tenancy defaults, it is never required.** The schema *may* carry a
   `tenant_id`, but "no auth context" must resolve to a single implicit local
   tenant (e.g. `tenant_id = 'local'` / nullable-defaulted) — **not** a required
   filter that a solo user has to satisfy. This required-vs-defaulted choice is the
   single biggest determinant of local-mode impact in all of v2: get it wrong and
   local needs an auth context it does not have; get it right and local never
   notices tenancy exists.

3. **Cloud/SaaS code is dead code from local's perspective** — flag-gated and never
   loaded on the default path (`enableRemoteSessions` unset, `remoteSession:'off'`,
   hosted-DB adapter not selected all reproduce today's behavior exactly).

### Blast radius on the existing local hot path

Only two items touch the code every local run goes through; both are shared-path
refactors (regression risk), **not** feature divergence:

| v2 item | Local hot path? | Impact if the rules above hold |
|---------|-----------------|--------------------------------|
| `role-registry.md` (R0) | yes — replaces `buildToolsForKind`/`buildSystemInstructions` | zero behavioral; pure refactor, existing tests are the contract |
| `persistent-memory-hosted-db.md` | yes — `getDb()` is the single chokepoint | low; local SQLite stays the default backend, hosted is a flag |
| always-on host (R1/R2) | partly — *where* monitor/scheduler run | additive; local already runs them in-process, unchanged |
| Mission-Control export | no — a daemon `forTcp` flag | opt-in, off by default |
| cloud agents (workers) | no — a new delegation *target* | additive; default stays local worktree + session |
| cloud Lead (R3) | no — a separate deployment mode | fully optional; local Lead untouched |
| PM / Architect / Ops roles | no — new `RoleDef` entries | additive; local CoS→Lead→worker org unchanged |
| tenancy / SaaS | yes conceptually — `tenant_id` on rows | low **iff** tenant defaults (rule 2); high if it becomes required |

**The failure mode to avoid:** forking into two DB layers, two delegation paths,
and two auth assumptions. That doubles maintenance and rots the local path over
time. Every v2 spec is written to a single-seam / opt-in-switch discipline
precisely to prevent it.

## Two tracks, one enabler


```
                         ┌──────────────────────────────┐
                         │  R0  role-registry.md         │  ← shared enabler
                         │  (roles as data: base × lens  │
                         │   × altitude + reportsTo)     │
                         └───────────────┬──────────────┘
             ┌───────────────────────────┴───────────────────────────┐
     Track A: PLATFORM (SaaS re-platforming)          Track B: ROLE MODEL (org scaling)
     persistent-memory-hosted-db.md                   agent-roles-taxonomy.md  (the map)
     always-on-remote-lead.md                         pm-role.md
     cloud-agents.md                                  architect-role.md
     cloud-lead.md                                    ops-runtime-role.md
     saas-multi-tenant.md                             multi-instance-lead.md
```

## Track A — Platform (SaaS re-platforming)

A re-platforming, not a lift-and-shift. Externalize **identity/tenancy, state, and
compute**; keep an always-on control plane because cloud sessions are ephemeral.

| File | What it changes | Depends on |
|------|-----------------|------------|
| `persistent-memory-hosted-db.md` | move state off local SQLite behind `getDb()` to a hosted DB (three-layer memory model) | — |
| `always-on-remote-lead.md` | always-on host + durable daemon + event ingestion + Mission-Control export (R1/R2) | hosted DB |
| `cloud-agents.md` | route workers + the read-only assessor to Copilot cloud sandboxes | always-on |
| `cloud-lead.md` | (optional) re-host Lead tools behind MCP so a cloud Lead can call them (R3) | R0, always-on, hosted DB |
| `saas-multi-tenant.md` | tenancy + auth + per-tenant isolation + billing; ties the platform together | all of the above |
| `mobile-voice-console.md` | new UX surface: mobile voice-first remote client (2FA/exposure hardening + two-way STT/TTS voice loop; Lavish/screen-capture fallbacks) — opt-in, remote-only | always-on-remote-lead, saas-multi-tenant (auth), persistent-memory-hosted-db |

## Track B — Role model (org scaling)

New axes the current CoS/Lead/Worker/Reviewer org does not own, expressed cleanly
once roles are data.

| File | What it adds | Depends on |
|------|--------------|------------|
| `agent-roles-taxonomy.md` | the axes-vs-hats map (framing, not a feature) | — |
| `pm-role.md` | cross-project **intent/priority** (CoS PM-hat → standalone PM) | R0 |
| `architect-role.md` | cross-project **technical coherence** (contract threads → multi-repo review → role) | R0 |
| `ops-runtime-role.md` | the **post-merge runtime** axis (deploy/monitor/incident) | R0, always-on + events |
| `multi-instance-lead.md` | reject multi-project Lead; replicate + share state | hosted DB, R0 |

## Recommended sequencing

1. **R0 — `role-registry.md`** (pure refactor; unblocks both tracks).
2. **Hosted DB — `persistent-memory-hosted-db.md`** (prerequisite for anything multi-host/tenant).
3. **Always-on host — `always-on-remote-lead.md`** (R1 + Mission-Control export spike, then R2 durability/events).
4. **Cloud compute — `cloud-agents.md`** (workers + cloud-portable assessor).
5. **Tenancy — `saas-multi-tenant.md`** (the one genuinely new pillar: `tenant_id` + GitHub-App auth).
6. **Role additions — `pm-role.md`, `architect-role.md`** as cross-project scale demands; **`ops-runtime-role.md`** only if scope grows past "get code merged".
7. **`cloud-lead.md`** (R3) — optional, last; the Lead core stays on the control plane regardless.

**Opt-in UX surface (Platform-adjacent):** `mobile-voice-console.md` — a mobile,
voice-first remote client behind 2FA. It is **remote-only and opt-in** (the
local-default invariant is untouched) and slots in **after** its prerequisites:
exposure/auth hardening rides on `saas-multi-tenant.md` (auth) + the always-on host
(`always-on-remote-lead.md`) + hosted state (`persistent-memory-hosted-db.md`).

**Near-term hybrid milestone** (the realistic first cut of v2): control plane +
hosted DB + on-demand Lead/CoS on one small always-on host, workers pushed to
Copilot cloud sandboxes. Full multi-tenant SaaS (hard isolation, billing, BYOK)
comes after.

## The economic thesis (why v2 is worth it)

The heaviest, most variable cost — **agent token burn** — is offloaded to each
tenant's own Copilot entitlement via cloud sandboxes. You run only a small, shared
control plane + hosted DB, and sell the **coordination layer** (the CoS→Lead→worker
hierarchy, durable memory, the dashboard) that is pilot-console's differentiator.
See `saas-multi-tenant.md` for the full cost breakdown.
