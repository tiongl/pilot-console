# Mobile voice console — a hands-free, remote, voice-first client

**Status: NOT STARTED (exploration / design)** — a new **UX surface** that rides on
the Platform track. It exposes pilot-console as a **mobile web app**, behind **2FA
login**, driven **primarily by voice** (speech-to-text *in* **and** speech *out* —
a two-way spoken loop, not just dictation), with **Lavish tabs and screen capture
as occasional visual escape hatches**. It does **not** re-architect the agent org;
it depends on the remote/exposure substrate specced in `always-on-remote-lead.md`,
`cloud-lead.md`, and the tenancy+auth in `saas-multi-tenant.md`
(state in `persistent-memory-hosted-db.md`).

This is opt-in and remote-only. It does not touch the **hard invariant** that
local mode is the default (see `README.md`): a solo user running locally never
logs in, never enables 2FA, and never sees the voice view unless they turn it on.

## 1. Problem / vision

The use case is **eyes-free, on-the-go supervision**: you are walking, driving,
cooking, or away from a keyboard, and you want to *talk to your project* — "what's
the Lead waiting on?", "approve the worker's plan", "tell it to use Postgres not
SQLite", "read me the last failure" — and hear the answer spoken back. The phone
is a **remote control for a Lead that lives elsewhere**, not a place to write code.

Why **voice-first**, not a responsive shrink of the desktop UI:

- The desktop app is a dense, multi-pane cockpit (tab strips, side panels, todo
  boards — `ProjectLeadPage.tsx`). Squeezing that onto a phone produces a worse
  desktop, not a good phone. The mobile value is *not* "see everything smaller";
  it is "do the 5 high-value supervisory actions without looking".
- pilot-console's core loop is **approval-heavy** (permission prompts, `ask_user`,
  plan reviews — see §2). Those are exactly the moments where a spoken
  "the worker wants to run `npm install` — approve?" / "yes" beats fishing a
  precise tap out of a pocket.
- Voice is the interaction that works when the screen is *not* the primary
  channel. The visual surfaces (Lavish, a screenshot) become **fallbacks** you
  reach for only when voice cannot convey something — a diff, a rendered UI, a
  chart — not the default.

The north star: a spoken, turn-taking conversation with your remote Lead, where
the screen is optional and only lights up for "show me" moments.

## 2. Current state (grounded)

Honest baseline — most of what a mobile voice console needs does not exist yet.

**Auth is single-factor and local-trust.** `POST /api/auth/login`
(`src/server/index.ts:75-94`) does not take a password or a second factor — it
reads the server's own `gh auth login` identity (`getGitHubCliProfile`), upserts
that user, and issues a `pilot_console_session` cookie. `requireAuth`
(`src/server/middleware/auth.ts:59-76`) simply checks that cookie against a local
`auth_sessions` table (`:32-57`), and `app.use('/api', requireAuth)`
(`src/server/index.ts:118`) gates the API. All three WebSocket servers authenticate
by reading the *same* cookie off the upgrade request
(`src/server/websocket.ts:107-115`, `src/server/agent-websocket.ts:72-80`,
`src/server/server-websocket.ts:52-60`). The cookie is `httpOnly` +
`sameSite:'lax'` with a 30-day `maxAge` (`src/server/index.ts:84-89`) — but **no
`secure` flag, no CSRF token, no origin/CORS allow-list, no 2FA**. In other words:
**login trusts whoever can reach the box and hit the endpoint.** On a laptop bound
to `localhost` that is fine; the moment this is exposed to the public internet it
is the primary security hole (see §3).

**STT is dictation-only and one-way.** `src/client/hooks/useSpeechInput.ts` wraps
the browser Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`,
`:42-49`), running continuously and auto-restarting on pauses (`:117-118,149-161`).
It is wired into the composer in `AgentPane.tsx:596-606`: recognized text is
appended to the `input` textbox, and a mic button toggles it (`:2510-2524`). The
user still **reads the transcript, edits it, and presses send** — and the mic is
deliberately cut off on send (`:1404`). There is **no TTS / voice output, no wake
word, no auto-submit on end-of-utterance, no read-back of the agent's replies, and
no barge-in.** `supported` is already `false` on Firefox and Safari < 16.4
(`useSpeechInput.ts:65`), foreshadowing the fragmentation problem (§8).

**The approval-heavy flow is entirely visual/tap-driven** — and this is the
hardest part to voice-enable. The agent raises `permission_request` events
(`AgentPane.tsx:767`) rendered as prompts with **Approve once / Approve for session
/ Approve all / Reject** buttons (`:2244-2276`, decisions at `:1154-1157`); it
raises `ask_user` questions (`:586,:804`) that **block the turn** until answered by
text (`:1209,:1413`); and it raises plan/`exitPlan` reviews. There is an `allowAll`
"auto-approve everything" toggle (`:625-626,:2582-2592`). Any voice loop must have
a spoken answer for each of these gates.

**Remote reachability is unsolved here but partially specced.** The always-on /
remote track (`always-on-remote-lead.md`, R1/R2; `cloud-lead.md`) is the substrate
that makes a phone able to reach the Lead at all. This doc **references** it and
does not duplicate it.

**Visual surfaces exist only in part.** Live **Lavish** artifact tabs already
render in-app via a **same-origin reverse proxy**
(`src/client/components/terminal/ArtifactTab.tsx:19-33`,
`src/server/lavish-proxy.ts:8-30`) — and the proxy was written **assuming the
browser may not be on the daemon's machine** (`lavish-proxy.ts:11-13`), so it is
already remote-aware. That makes Lavish the natural "show me" surface on mobile.
**Screen capture is not implemented anywhere** — it is net-new (§6).

**The UI is desktop-oriented.** `ProjectLeadPage.tsx:251` lays out a
`grid ... xl:min-h-0 xl:overflow-hidden` cockpit with a tab strip, a
`max-w-[14rem]` control, an 80-tall todo panel (`:449`), plus `DashboardLayout`
chrome and the `ProjectNav` sidebar. None of it is built for a one-handed phone,
and (see §5) a responsive retrofit is likely the wrong tool for a voice-first
client anyway.

## 3. Auth & exposure

**Public exposure is what makes 2FA mandatory.** Today the only thing standing
between an attacker and an agent that can *run arbitrary code on your machine and
push to your repos* is "can they reach the port" — because login just mints a
session from the server's `gh` identity (`src/server/index.ts:75-94`) with no
challenge. The instant this listens on a public address, a strong second factor is
non-negotiable.

**Options (with trade-offs):**

| Option | How it fits | Pros | Cons |
|--------|-------------|------|------|
| **TOTP (authenticator app) as a 2nd factor on top of the existing GitHub identity** | Keep `getGitHubCliProfile` as factor 1 (who you are), add a per-user TOTP secret + verify step before `createSession` mints the cookie | Simple, offline, no new IdP, phone-friendly (the phone *is* the authenticator) | Shared-secret storage must be protected; enrollment UX; no phishing resistance |
| **WebAuthn / passkeys** | Replace/augment the second factor with a platform authenticator (Face ID / fingerprint) | Phishing-resistant, excellent phone UX (biometric unlock), no shared secret | More implementation surface; needs `secure` origin; recovery/backup story |
| **Reverse proxy / external IdP in front** (e.g. an auth proxy, OAuth-forward-auth, or the SaaS tenancy layer) | Terminate identity + MFA *before* traffic reaches pilot-console; app trusts a signed header/assertion | Offloads MFA + session hardening; aligns with `saas-multi-tenant.md` GitHub-App auth | Operational weight; only sensible once the always-on host exists |

**Session/cookie hardening is required regardless of which factor** — the current
flags are tuned for localhost:

- Set **`secure`** (HTTPS-only) — mandatory once remote.
- Reconsider **`SameSite`**: `lax` (`index.ts:86`) is fine for a same-origin PWA
  but breaks if the mobile client is served from a different origin; a
  cross-origin split needs `SameSite=None; Secure` **plus** CSRF defense.
- Add **CSRF protection** and an **origin/allow-list check on the API and all
  three WS upgrades** (`websocket.ts`, `agent-websocket.ts`, `server-websocket.ts`
  currently trust any origin that carries the cookie).
- Shorten the **30-day** session (`index.ts:87`, `auth.ts:35`) for a public
  surface, and support explicit revocation (`destroyUserSessions` already exists,
  `auth.ts:45`).

**Relation to `saas-multi-tenant.md`:** that doc names **tenancy/auth as the one
genuinely new pillar** (GitHub-App auth, `tenant_id` on every row). The mobile
console should **not invent a parallel auth system** — near-term it adds a 2nd
factor to the *existing* single-user login; longer-term it should ride the SaaS
identity layer so "who are you + which tenant" is answered once.

**Recommended near-term path:** **TOTP as a second factor + full cookie hardening
(`secure`, origin checks, CSRF, shorter TTL), served over HTTPS behind the
always-on host** from `always-on-remote-lead.md`. It is the smallest change that
makes exposure safe, needs no external IdP, and the phone doubles as the
authenticator. Graduate to **passkeys** for better UX, and fold into the SaaS IdP
when tenancy lands.

## 4. Voice interaction loop

The jump is from "dictation into a textbox" (`useSpeechInput.ts` +
`AgentPane.tsx:596-606`) to an **eyes-free conversational loop**: STT in, the
agent's reply spoken out, and turn-taking that needs no screen.

**Architecture — two engines to add (STT already partially exists, TTS is net-new):**

- **STT in.** Reuse `useSpeechInput` where the browser supports it, but treat it as
  one backend behind an interface — because it is absent on Firefox/Safari<16.4
  (`useSpeechInput.ts:65`) and quality/latency vary.
- **TTS out.** Net-new. Either the browser `SpeechSynthesis` API (free, offline,
  but robotic and inconsistent across phones) or a **server/cloud TTS** stream for
  natural voice.

| Approach | Latency | Quality | Offline | Cost | Privacy |
|----------|---------|---------|---------|------|---------|
| **On-device Web Speech (STT) + `SpeechSynthesis` (TTS)** | low | mediocre, device-dependent | yes | free | best (never leaves device) |
| **Server/cloud STT + TTS** | network-bound | high, consistent | no | per-minute | transcript + audio leave the device |

Likely answer: **on-device as the default fallback, cloud as an opt-in upgrade** —
consistent with the local-default invariant (cloud is opt-in everywhere in v2).

**The loop mechanics to build:**

- **Endpointing / auto-submit.** Today an utterance never auto-sends (`:1404`
  actively stops the mic on send). A hands-free loop needs voice-activity detection
  / silence endpointing to decide "the user finished a turn" and submit
  automatically — with a short cancel window ("scratch that").
- **Read-back of streamed deltas.** The agent streams transcript deltas to the
  pane; the voice client must **speak** those deltas as they arrive, chunked at
  sentence boundaries so playback starts before the turn completes. Long tool
  output should be summarized/skipped, not read verbatim.
- **Barge-in / interruption.** The user must be able to talk over the TTS
  (stop playback, capture the new utterance). This is the single biggest factor in
  whether the loop feels natural, and it conflicts with mic/speaker echo on a phone
  (needs echo cancellation or push-to-talk).
- **A wake word / explicit turn control** so the mic is not hot forever
  (battery, privacy, mis-triggers). Push-to-talk is the safe default; a wake word
  is the stretch goal.

**Voice must handle this app's approval gates — the critical design point.** The
Lead/worker flow is approval-heavy (§2), so the loop is useless if it cannot
resolve gates by voice:

- **Permission requests** (`AgentPane.tsx:767,2244-2276`): speak the request
  ("the worker wants to run `git push` — approve once, approve for the session, or
  reject?") and map spoken answers to the existing decisions
  (`approve-once/approve-for-session/reject`, `:1154-1157`). Require an explicit
  verbal confirmation; **do not** map any casual "yeah" to `approve-all`.
- **`ask_user` questions** (`:804,1209`): these *block the turn* (`:1413`), so the
  loop must surface them immediately, read the question (and any offered options),
  and send the spoken answer as the `ask_user_response`.
- **Plan / `exitPlan` reviews**: summarize the plan aloud (it may be long — offer
  "read the full plan" vs "just the summary") and accept an approve/revise verdict.
- **`allowAll` is dangerous hands-free** (`:625-626,2582-2592`). Auto-approving
  everything while the operator cannot see the screen removes the last human gate
  on a code-running agent. The voice console should **discourage or disable**
  blanket auto-approve in eyes-free mode and prefer per-gate spoken confirmation.

## 5. Mobile client

**Dedicated minimal voice view, not a responsive retrofit.** The cockpit
(`ProjectLeadPage.tsx:251`, tab strip, `ProjectNav` sidebar, `DashboardLayout`) is
built for a large screen; reflowing it to a phone yields a cramped desktop and
still is not usable one-handed. A voice-first client wants a **purpose-built,
minimal surface**: a big talk button, a live transcript, the current gate/prompt,
and a "show me" affordance — reusing the existing API/WS event stream, not the
existing DOM. A modest amount of responsive polish on the full app is still worth
it for the occasional glance, but it is **not** the primary mobile experience.

**PWA considerations:**

- **Installable** (manifest + service worker) so it launches full-screen like an
  app and can hold a persistent session.
- **Microphone permission** must be requested from a user gesture and re-granted
  per origin; a PWA install helps make the grant sticky.
- **Background / lock-screen audio limits are the hard constraint.** Mobile
  browsers aggressively suspend JS, audio capture, and WebSockets when the tab is
  backgrounded or the screen locks — so a truly "phone-in-pocket, screen-off"
  continuous loop is **not reliably achievable** with web APIs today. Realistic
  near-term target: **foreground, screen-on** (a Media Session / audio element can
  extend playback, but continuous *capture* in the background is unreliable).
- **iOS Safari Web Speech caveats.** `SpeechRecognition` on iOS is limited/
  inconsistent and may route to a server, has short session limits, and requires
  gesture-initiated starts — reinforcing the need for a pluggable STT backend
  (§4) rather than assuming the browser API is enough.

## 6. Visual escape hatches

Voice cannot convey a diff, a rendered UI, or a chart — so keep **occasional**
visual fallbacks.

**Lavish on mobile** is the low-effort win. Live artifact tabs already render via a
**same-origin, remote-aware reverse proxy**
(`ArtifactTab.tsx:19-33`, `lavish-proxy.ts:8-30`, explicitly built for a browser
not on the daemon's machine, `:11-13`). On the voice client, "show me the preview"
can open the existing proxied Lavish iframe — mostly a layout/entry-point problem,
not new infrastructure.

**Screen capture is net-new and ambiguous — define what it even means here:**

- **Server-side worktree-preview screenshot** — render the running preview/app and
  ship a still image. Deterministic, no client capture, but needs a headless
  renderer on the host and only shows things that have a URL.
- **App screenshot of the pilot-console UI itself** — "show me what the desktop
  view looks like right now" as an image.
- **`getDisplayMedia` (client screen share)** — only meaningful if there is a
  *desktop* session to mirror; on a phone-only client there is nothing to share,
  so this is really about a companion desktop, not the mobile client.

**Feasibility / security questions to flag:** a headless renderer is extra host
weight and attack surface; screenshots can **leak secrets** (tokens, `.env`, source
on screen) to the phone and into transcripts/logs; captures must be
tenant/session-scoped and access-controlled exactly like the Lavish proxy already
scopes artifacts by session key. Recommendation: **start with Lavish-on-mobile;
treat screen capture as a later spike** with the worktree-preview screenshot as the
most tractable first form.

## 7. Phasing (near-term-first, dependency-ordered)

This surface **rides on** the Platform prerequisites already in v2 — it cannot
precede remote reachability, and its auth story should converge with SaaS auth.

1. **Prereq (not this doc):** always-on host + remote reach
   (`always-on-remote-lead.md`, R1 Mission-Control export) so a phone can reach the
   Lead at all; hosted DB (`persistent-memory-hosted-db.md`) so sessions/auth
   survive; SaaS tenancy+auth direction (`saas-multi-tenant.md`).
2. **Exposure hardening + 2FA (§3)** — `secure` cookies, origin/CSRF checks on API
   + all three WS upgrades, TOTP second factor over HTTPS behind the always-on
   host. **Gate:** nothing else ships publicly until this lands.
3. **Minimal mobile voice view (§5)** — a dedicated PWA surface over the existing
   event stream: push-to-talk STT (reuse `useSpeechInput`) + `SpeechSynthesis`
   read-back, foreground/screen-on only.
4. **Approval gates by voice (§4)** — spoken permission / `ask_user` / plan-review
   handling mapped onto the existing events; per-gate confirmation, `allowAll`
   discouraged hands-free. This is the feature that makes it *useful*, not a toy.
5. **Loop naturalness** — endpointing/auto-submit, streamed sentence-chunked
   read-back, barge-in; optional **cloud STT/TTS** as an opt-in quality upgrade.
6. **Visual escape hatches (§6)** — Lavish entry point first; worktree-preview
   screenshot spike later.
7. **Converge auth onto the SaaS IdP / passkeys** as tenancy matures.

Consistent with the README's **hard invariant**: every step above is **opt-in and
remote-only** — the local default path (no login, no 2FA, desktop cockpit) is
untouched.

## 8. Risks / open questions

- **Browser STT/TTS fragmentation.** Web Speech is absent on Firefox/Safari<16.4
  (`useSpeechInput.ts:65`) and inconsistent on iOS; `SpeechSynthesis` voices vary
  wildly. A pluggable STT/TTS backend is likely mandatory, which pulls in cloud
  cost/privacy trade-offs.
- **Mobile background-audio limits.** Reliable "screen-off, in-pocket" continuous
  voice is probably **not achievable** with today's web APIs; is
  foreground/screen-on acceptable for v1, or does this need a native shell?
- **Latency budget for a natural spoken loop.** STT + agent turn + TTS round-trips
  can feel sluggish; what is the acceptable time-to-first-spoken-word, and does it
  force cloud STT/TTS and aggressive streaming?
- **2FA UX on a phone.** TOTP re-entry is clumsy one-handed; do we jump straight to
  passkeys/biometrics for the mobile surface?
- **Security of exposing a code-running agent.** This is the deepest risk: the
  agent can run arbitrary commands and push to repos, and eyes-free operation
  removes the visual gate. How far do we lock down (disable `allowAll` remotely,
  require per-gate confirmation, spend/kill switches per
  `always-on-remote-lead.md` R2) before public exposure is defensible?
- **Cost.** Cloud STT/TTS is per-minute and a voice loop is chatty; where is the
  line between free on-device and paid cloud, and who pays (ties to the SaaS
  economics in `saas-multi-tenant.md`)?
- **Screen-capture scope & leakage.** Which of the three meanings (§6) do we
  actually want, and how do we keep secrets off the phone and out of transcripts?

## Cross-links

- `always-on-remote-lead.md` — the remote-reach substrate (R1 Mission-Control
  export, R2 durability/guardrails) this client depends on.
- `cloud-lead.md` — why the Lead's local tools/DB/worktrees constrain remoting.
- `saas-multi-tenant.md` — tenancy + GitHub-App auth this should converge onto;
  the economics of cloud STT/TTS cost.
- `persistent-memory-hosted-db.md` — hosted state so sessions/auth survive
  off a single local box.
- `README.md` — the hard invariant (local mode default; cloud/remote opt-in) that
  bounds this surface.
