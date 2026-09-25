# Cost & per-seat pricing — hosted v2 SaaS

**Status: NOT STARTED (exploration / cost analysis)** — quantifies the qualitative
cost-center model. Depends on the whole Platform track: `saas-multi-tenant.md`
(the cost-center framing), `always-on-remote-lead.md` (the control plane),
`persistent-memory-hosted-db.md` (hosted DB), and `cloud-agents.md` (offloaded
worker compute). Optional add-on ties to `mobile-voice-console.md`.

> **Every dollar figure below is an ASSUMPTION with a plausible range, not a
> quote.** There is no billing or usage data yet. Numbers are order-of-magnitude
> cloud list-price estimates chosen to make the *shape* of the economics legible;
> they must be re-derived against real telemetry before any pricing is committed.
> Treat the arithmetic as a model, not a forecast.

> **Scope guard (README hard invariant, `README.md:15-40`).** Local mode is the
> free default: one process, local SQLite, no login, no hosted services. **None of
> this cost or pricing applies to local users** — it applies *only* to the opt-in
> hosted SaaS. A solo user running locally pays nothing and is unaffected.

## Why this doc

`saas-multi-tenant.md:55-67` already argues the economics are attractive and gives
the cost-center table, but with **no numbers**:

| Cost center | Who pays | Margin impact |
|-------------|----------|---------------|
| Worker compute (the expensive part) | tenant's own Copilot cloud entitlement | you don't pay |
| Lead/CoS compute | on-demand, idles to zero | minimal, spiky |
| Control plane + hosted DB | you (shared across tenants) | fixed, amortized |
| Storage (transcripts / memory) | you | cheap, slow growth |

This doc puts plausible numbers on that table, derives a **monthly operator cost
per seat** across usage tiers, and turns that into **per-seat price points** at
target margins. It is a modelling exercise to pressure-test the thesis — *"you
mostly sell the coordination layer on top of compute you do not buy"*
(`saas-multi-tenant.md:64-67`) — and to expose which levers actually move the
number.

## 1. Cost model overview — who pays for what

The single most important line in the whole model is **operator-absorbed cost vs
cost passed through to the tenant.** Get that line right and the rest is
arithmetic.

| Cost center | Operator pays? | Notes / grounding |
|-------------|:--------------:|-------------------|
| Always-on control plane (monitor + scheduler + router + daemon) | **yes** | the one cost that cannot be eliminated (`always-on-remote-lead.md:23-49`); shared across all tenants (`saas-multi-tenant.md:43-44`) |
| Hosted DB (per-tenant Postgres or shared-with-`tenant_id`) | **yes** | `persistent-memory-hosted-db.md:34-38` |
| Storage growth (transcripts / project memory) | **yes** | cheap, slow (`saas-multi-tenant.md:62`); write pattern matters (§2) |
| Egress (WS streaming to browsers, DB/API traffic) | **yes** | usually small; can surprise (§6) |
| Lead/CoS **hosting compute** (vCPU-hours to run the sessions) | **yes** | on-demand, idles to zero (`saas-multi-tenant.md:41`, `always-on-remote-lead.md:8-21`) |
| Optional cloud STT/TTS | **maybe** | only if the operator eats it; per-minute metered (`mobile-voice-console.md:164`) — see §2e |
| **Worker token burn** (the heaviest, most variable cost) | **NO — tenant** | runs in Copilot cloud sandboxes billed to the tenant's own Copilot entitlement (`cloud-agents.md:18-19`, `saas-multi-tenant.md:39-40`) |
| **Lead/CoS agent tokens** | **contested — see below** | the Lead/CoS also run Copilot CLI sessions and burn tokens |

**The one thing to NOT double-count: worker token burn.** Because builder workers
run in Copilot cloud sandboxes (`cloud-agents.md:13-24`), GitHub runs and bills
that compute against the *tenant's* Copilot plan, not the operator's. This is the
whole reason the margins look good — the expensive, spiky part is off the
operator's books entirely. It must never appear as an operator line item.

**The genuinely ambiguous case: who owns the Lead/CoS *tokens*?** The Lead and CoS
are *also* Copilot CLI sessions and *also* burn model tokens when they reason,
route, and summarize. Two clean stances:

1. **Tenant-owned (recommended default assumption).** The Lead/CoS run under the
   tenant's own Copilot entitlement / BYOK, exactly like workers. Then the operator
   pays only for the *hosting* of those sessions (vCPU-hours, §2c), not the tokens.
   This keeps the "you don't buy the compute" thesis intact end-to-end and is
   consistent with the direction of `saas-multi-tenant.md` (BYOK, tenant
   entitlement). **This doc models Lead/CoS token cost as tenant-owned** and counts
   only their hosting compute against the operator.
2. **Operator-absorbed.** The operator pays for Lead/CoS tokens as a platform cost.
   This is simpler for the tenant but converts a pass-through into a real,
   usage-scaling operator cost — and it is unbounded per active seat, so it would
   dominate the model. If chosen, it belongs *inside* the per-seat cost and blows a
   hole in the high-margin story; it is called out as a top sensitivity lever (§5)
   and an open question (§6).

Everything below assumes stance (1). If the org picks stance (2), re-run §3 with a
per-seat Lead/CoS **token** line added — the numbers change materially.

## 2. Per-cost-center estimates

All unit costs are assumptions; ranges bracket typical hyperscaler list prices
(AWS/GCP/Azure/Fly/Render-class) as of writing, rounded for legibility.

### 2a. Always-on control plane

The control plane is one small always-on service **shared across all tenants**
(`saas-multi-tenant.md:43-44`) — API + auth/tenancy, the per-tenant monitor +
scheduler (60s tick, `always-on-remote-lead.md:27-28`), router, and the durable
daemon. A small VM is explicitly deemed enough (`always-on-remote-lead.md:37`).

| Item | Assumption | $/month (range) |
|------|-----------|-----------------|
| Always-on control-plane instance | 2 vCPU / 4–8 GB, always-on, single shared node | **$30–$80** |
| Redundancy / HA (optional, 2nd node + LB) | double for availability | +$40–$100 |

**Amortized per seat this is near-zero at any real scale.** At $60/mo shared across
even 50 seats it is **~$1.20/seat/mo**; across 500 seats, **~$0.12/seat/mo**. The
control plane is a *fixed* cost, so per-seat control-plane cost falls as tenants
are added — it only matters for the first handful of seats.

**Per-tenant Lead/CoS sandboxing (`saas-multi-tenant.md:50-52`, pillar 5).** Pillar
5 says Lead/CoS need per-tenant isolation (containers/namespaces), unlike workers
which get it free in cloud sandboxes. Two ways to provide it — this is a top cost
lever (§5):

| Model | What it is | Cost shape | $/active tenant/mo (range) |
|-------|-----------|-----------|----------------------------|
| **(A) Warm per-tenant container** | a small always-idle sandboxed container per active tenant | fixed while tenant is active, even when idle | **$5–$20** |
| **(B) On-demand materialization** | spin the sandboxed Lead/CoS up per session, idle to zero (`always-on-remote-lead.md:8-21`) | pay only for vCPU-hours actually used (§2c) | **$0.50–$6** (usage-driven) |

Model (B) preserves the "idles to zero" property that makes the economics work
(`saas-multi-tenant.md:60`); Model (A) trades money for warm-start latency. The
per-seat tiers in §3 use **(B)** as the base case and flag **(A)** as the pessimistic
sensitivity.

### 2b. Hosted DB

Per-tenant managed Postgres, or one shared instance partitioned by `tenant_id`
(`persistent-memory-hosted-db.md:34`, `:69-70`).

| Item | Assumption | $/month (range) |
|------|-----------|-----------------|
| Shared managed Postgres (tenant_id-partitioned) | 1 instance, many tenants | **$20–$100** total, amortized |
| DB-per-tenant (hard isolation) | smallest managed instance each | **$7–$25 per tenant** |

**Storage growth — the write-amplification caveat.** Transcripts are the bulk of
DB growth, and today `persistAgentState` rewrites the *entire* `output_log` on
every save (`persistent-memory-hosted-db.md:36-38`, `agent-bridge.ts:38-51`). For a
network DB this is both a write-throughput cost and, if versioned/WAL-retained, a
storage-churn cost. The hosted-DB doc already flags reworking this to
append/batch. Assumptions:

| Item | Assumption | Value |
|------|-----------|-------|
| Transcript bytes retained per seat/mo | after `MAX_TRANSCRIPT_BYTES` trimming | **20–200 MB/seat/mo** |
| Managed storage price | per GB/mo | **$0.10–$0.30/GB** |
| ⇒ storage cost per seat/mo | 0.02–0.2 GB × price | **~$0.002–$0.06/seat/mo** |

Storage itself is negligible; the *write amplification* is a throughput/IO concern
that can inflate the DB instance size, not a large standalone line. Shared-DB
amortization (e.g. $60/mo ÷ 100 seats ≈ **$0.60/seat/mo**) dominates over raw bytes.

### 2c. Lead/CoS hosting compute

On-demand vCPU-hours to actually *run* the Lead/CoS sessions (tokens excluded per
§1 stance 1). Modeled as fractional vCPU-hours per active user per day.

| Assumption | Value |
|-----------|-------|
| Effective vCPU while a session is materialized | 0.5–1.0 vCPU |
| vCPU-hour price (on-demand/serverless container) | **$0.02–$0.05 / vCPU-hr** |
| Session materialized-hours per active user/day | tier-dependent (§3) |

⇒ cost/user/day = materialized-hours × vCPU × $/vCPU-hr. Worked in §3.

### 2d. Storage + egress

| Item | Assumption | $/seat/mo (range) |
|------|-----------|-------------------|
| Transcript/memory storage | from §2b | ~$0.002–$0.06 |
| WS streaming + API egress | dashboard streaming is text/events, not media | **$0.05–$0.50** |

Egress for a text/event dashboard is small, but it is metered per GB and can
surprise under chatty streaming or large transcript replays (§6).

### 2e. Optional cloud STT/TTS (voice-enabled seats only)

**Separate add-on line — applies only to seats that opt into voice**
(`mobile-voice-console.md:164`, `:312-314`). On-device Web Speech is free; cloud
STT/TTS is per-minute and a voice loop is chatty. If the operator eats it:

| Assumption | Value |
|-----------|-------|
| Cloud STT + TTS combined | **$0.02–$0.06 / minute** |
| Voice minutes/day for a voice-enabled seat | 10–60 min |
| Active days/mo | ~22 |

⇒ **$4.40–$79/seat/mo** for voice-enabled seats — a wide, potentially *dominant*
band that can exceed the entire base infra cost. This is why it is kept out of the
base model and treated as a metered add-on (pass the per-minute cost through, or
price a voice tier), never bundled into the flat per-seat number.

## 3. Three usage tiers → monthly operator cost per seat

Profiles (all assumptions). "Delegations/day" drives worker *sandbox* activity
(tenant-billed, excluded from operator cost) and indirectly Lead/CoS
materialization time.

| Profile | Active hrs/day | Worker delegations/day | Lead/CoS materialized-hrs/day | Transcript vol | Voice |
|---------|:--------------:|:----------------------:|:-----------------------------:|:--------------:|:-----:|
| **Light** | ~1 | 1–3 | 0.3 | 20 MB/mo | off |
| **Medium** | ~3 | 5–15 | 1.0 | 80 MB/mo | off |
| **Heavy** | ~6 | 20–50 | 2.5 | 200 MB/mo | off |

Operator cost per seat/mo, base case = **on-demand Lead/CoS (Model B)**, **shared
DB**, Lead/CoS tokens tenant-owned, voice off. Amortized fixed costs assume a
mid-size fleet (~100 active seats).

| Line item | Light | Medium | Heavy |
|-----------|------:|------:|------:|
| Control plane (amortized) | $0.30 | $0.30 | $0.30 |
| Lead/CoS on-demand compute (§2c) | $0.10 | $0.50 | $1.50 |
| Per-tenant Lead/CoS sandbox, Model B (§2a) | $0.30 | $1.50 | $4.00 |
| Hosted DB (amortized share) | $0.40 | $0.60 | $0.90 |
| Storage (§2b) | $0.01 | $0.02 | $0.06 |
| Egress (§2d) | $0.05 | $0.15 | $0.40 |
| **Total operator cost / seat / mo** | **≈ $1.2** | **≈ $3.1** | **≈ $7.2** |
| *(worker token burn)* | *tenant* | *tenant* | *tenant* |

Rounded working ranges accounting for the assumption bands:

| | Light | Medium | Heavy |
|-|------:|------:|------:|
| **Operator cost/seat/mo (range)** | **$0.80–$2** | **$2–$5** | **$5–$12** |

**Pessimistic variant — warm per-tenant container (Model A) + DB-per-tenant:**
replace the sandbox line with $5–$20 and the DB line with $7–$25 per tenant, and
per-seat cost jumps to roughly **$12–$45+/seat/mo** — an order of magnitude worse.
This is the single biggest structural choice in the model (§5).

## 4. Per-seat pricing

From operator cost, price at a target gross margin: `price = cost / (1 − margin)`.

| Tier | Operator cost/seat/mo | Price @ 70% margin | Price @ 80% margin |
|------|----------------------:|-------------------:|-------------------:|
| Light | ~$1.2 | ~$4 | ~$6 |
| Medium | ~$3.1 | ~$10 | ~$16 |
| Heavy | ~$7.2 | ~$24 | ~$36 |

**Interpretation.** In the base case the marginal infra cost per seat is genuinely
low — **single-digit dollars** — because the expensive, variable part (worker token
burn) is on the tenant's Copilot entitlement (`cloud-agents.md:18-19`) and Lead/CoS
idle to zero (`saas-multi-tenant.md:60`). You are mostly selling the **coordination
layer** — the CoS→Lead→worker hierarchy, durable memory, the dashboard — on top of
compute you do not buy (`saas-multi-tenant.md:64-67`). That supports **high margins
at modest, simple per-seat prices.**

**Sanity check vs comparable dev-tool SaaS.** Coordination/dashboard/observability
layers that sit on top of a BYO-LLM or BYO-compute model typically list in the
**~$10–$40/seat/mo** band (team dev tooling, CI/observability, "control plane for
your agents" products). The pricing above lands squarely in that band for Medium
and Heavy without needing to mark up compute — consistent with a healthy
coordination-layer business. A flat **~$15–$20/seat/mo** with a fair-use cap covers
Light and Medium comfortably at 80%+ margin; Heavy and voice warrant a higher tier
or metered overage.

**Where the high-margin story breaks:**
- **Heavy Lead/CoS materialization** or a shift to warm per-tenant containers
  (Model A) — the sandbox line stops being idle-to-zero (§5).
- **Voice** — cloud STT/TTS can be **$4–$79/seat/mo** (§2e), potentially dwarfing
  base infra; must be a metered add-on or its own tier, never bundled flat.
- **Large transcript retention** — long retention windows plus the `output_log`
  full-rewrite write pattern inflate DB throughput/size (§2b).
- **Operator-absorbed Lead/CoS tokens** (§1 stance 2) — converts a pass-through
  into an unbounded per-seat cost and undercuts the whole thesis.

## 5. Sensitivity — what moves the number most

Ranked by impact on per-seat cost:

1. **Lead/CoS: idle-to-zero (Model B) vs warm per-tenant container (Model A).**
   The difference between "$0.5–$6" and "$5–$20" per active tenant is the largest
   *structural* swing in the base model — it decides whether per-seat cost is
   single-digit or double-digit dollars. Preserving on-demand materialization
   (`always-on-remote-lead.md:8-21`) is the highest-leverage cost decision.
2. **Who owns Lead/CoS tokens (§1).** Tenant-owned keeps them off the operator's
   books entirely; operator-absorbed adds an unbounded, usage-scaling per-seat line
   that can dominate everything else. This is a *policy* lever, not an infra one.
3. **DB-per-tenant vs shared-with-`tenant_id`.** Hard isolation (per-tenant
   Postgres, $7–$25 each) vs amortized shared ($0.4–$0.9/seat) is a several-dollar
   per-seat swing and trades cost against isolation strength.
4. **Transcript retention policy + `output_log` write pattern.** Retention window ×
   write amplification sets DB size/throughput; reworking full-rewrite to
   append/batch (`persistent-memory-hosted-db.md:36-38`, `:65`) contains it.
5. **Voice adoption %** — not in the base per-seat number, but at portfolio level
   the fraction of voice-enabled seats × per-minute cost can swamp base infra (§2e).

## 6. Risks / open questions

- **No real billing or usage data.** Every number here is a labeled assumption;
  the tiers, the vCPU-hours, the transcript volumes, and the unit prices all need
  validation once a real fleet exists. Do not price off this doc alone.
- **Whose entitlement pays Lead/CoS tokens?** (§1) — unresolved and materially
  changes the model. Needs a product/billing decision (tenant BYOK/entitlement vs
  operator-absorbed platform cost).
- **Free-tier / trial abuse of a code-running agent.** A hosted agent that runs
  arbitrary commands and can push to repos is an attractive target for abuse
  (crypto mining, egress abuse) even if worker token burn is tenant-billed —
  the *hosting* compute and egress are the operator's. Spend caps + kill switch
  (`always-on-remote-lead.md:61`) and quotas are prerequisites, not niceties.
- **Egress surprises.** Text/event streaming is cheap in theory, but chatty WS
  streams, large transcript replays, or cross-region traffic can inflate egress
  well past the $0.05–$0.50/seat estimate (§2d).
- **GitHub cloud-sandbox pricing changes.** The entire thesis leans on worker
  compute being billed to the tenant's Copilot entitlement
  (`cloud-agents.md:18-19`). It is public-preview compute (`cloud-agents.md:8-11`);
  if GitHub changes pricing, packaging, or who-can-be-billed, the pass-through
  could shift onto the operator and the margin story would need re-derivation.
- **Fleet-size amortization assumption.** Per-seat fixed-cost shares assume ~100
  active seats; at the first handful of seats the control plane + DB minimums
  dominate and per-seat cost is much higher until the fleet grows.

## Cross-links

- `saas-multi-tenant.md` — the cost-center framing this doc quantifies
  (`:55-67`) and the coordination-layer thesis; pillar 5 per-tenant Lead/CoS
  sandboxing (`:50-52`).
- `cloud-agents.md` — workers in Copilot cloud sandboxes billed to the tenant's
  entitlement (`:18-19`); why worker token burn is not an operator cost.
- `always-on-remote-lead.md` — the always-on control plane that cannot be
  eliminated (the core fixed cost) and the idle-to-zero Lead/CoS lifecycle;
  R2 spend caps / kill switch (`:61`).
- `persistent-memory-hosted-db.md` — hosted per-tenant DB and the `output_log`
  full-rewrite write-amplification factor (`:36-38`).
- `mobile-voice-console.md` — optional cloud STT/TTS, per-minute metered and
  chatty (`:164`, `:312-314`); the voice add-on line.
- `README.md` — the hard invariant (local mode is free/default; cloud is opt-in)
  that bounds who this pricing applies to.
