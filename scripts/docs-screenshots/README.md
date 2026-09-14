# Docs screenshot capture

Reusable, config-driven screenshots for the user guide. Re-run whenever the UI
changes to refresh `docs/user-guide/images/`.

```bash
npm run docs:screens                       # capture every shot
npm run docs:screens -- --only login       # capture one shot
npm run docs:screens -- --only home-chief-of-staff,project-settings
npm run docs:screens -- --theme light      # light theme
npm run docs:screens -- --width 1600 --height 1000
```

## How it works

The script drives a headless Chromium (Playwright, already a dev dependency)
and **mocks the backend** — see `fixtures.mjs`. That means it needs no GitHub CLI
login, no session daemon, and no seeded projects: every `/api/**` call is answered
with deterministic fixture data, and WebSocket upgrades (live terminals/agent
streams) are aborted so pages don't hang. Screenshots therefore show the real UI
chrome with representative data, and are reproducible on any machine.

If no dev/prod server is reachable, the script starts `npm run dev` itself and
shuts it down when finished. To shoot against an already-running server, pass
`--base-url http://localhost:5173`.

Each run also writes `docs/user-guide/images/manifest.json` recording what was
captured (name, route, caption, file).

## Adding or updating a screenshot

Edit **`shots.mjs`** — add an entry with a `name`, `route`, and `caption`. Useful
optional fields: `waitFor` (selector or text to wait for), `waitMs` (settle
delay), `fullPage`, `viewport`, `theme`, and `actions` (clicks/fills/waits run
before capture). Then re-run `npm run docs:screens -- --only <name>`.

To make a page show richer data, edit **`fixtures.mjs`**: add an exact-path entry
to `FIXTURES` or a pattern to `REGEX_FIXTURES`. Un-fixtured endpoints fall back to
an empty-but-valid shape so pages still render.

## Limitations

Live terminals, agent transcripts, and Lavish artifact iframes stream over
WebSockets, which are intentionally disabled here — those panes render their
frame/controls but not live session content. Capture those manually if needed.

## Files

| File | Purpose |
|------|---------|
| `capture.mjs` | The runner (`npm run docs:screens`). |
| `shots.mjs` | The screenshot manifest — **edit this to add/update shots**. |
| `fixtures.mjs` | Mock API data — **edit this to enrich a page's data**. |
