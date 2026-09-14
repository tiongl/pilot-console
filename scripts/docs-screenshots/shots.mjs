// Screenshot manifest for the docs capture script.
//
// Each entry describes one screenshot. To add or update a docs image, edit this
// list and re-run `npm run docs:screens` (optionally with `-- --only <name>`).
//
// Fields:
//   name       Output file name (written to docs/user-guide/images/<name>.png).
//   route      Path to visit (relative to the base URL), e.g. '/projects/proj-web/settings'.
//   caption    Human-readable description (used in the generated manifest.json).
//   viewport   Optional { width, height }. Defaults to the script's --width/--height.
//   waitFor    Optional selector or text to wait for before capturing.
//   waitMs     Optional extra settle delay in ms after load (default 600).
//   fullPage   Optional boolean — capture the full scrollable page (default false).
//   theme      Optional 'dark' | 'light' — sets localStorage theme before load.
//   actions    Optional array of steps run before capture. Each step is one of:
//                { click: 'selector-or-text' }
//                { fill: 'selector', value: 'text' }
//                { press: 'Enter' }
//                { wait: 500 }
//                { waitFor: 'selector-or-text' }

/** @type {import('./types').Shot[]} */
export const shots = [
  {
    name: 'login',
    route: '/login',
    caption: 'Sign-in screen (GitHub CLI authentication).',
    waitFor: 'Pilot Console',
  },
  {
    name: 'home-chief-of-staff',
    route: '/',
    caption: 'Chief of Staff home: portfolio overview, running workers, and merge queue.',
    waitMs: 1000,
  },
  {
    name: 'project-lead',
    route: '/projects/proj-web/lead',
    caption: 'Project Lead workspace with worker tabs and the detail panel.',
    waitMs: 1200,
  },
  {
    name: 'project-settings',
    route: '/projects/proj-web/settings',
    caption: 'Project settings, including Chief of Staff autonomy modes.',
    waitMs: 900,
    fullPage: true,
  },
  {
    name: 'project-skills',
    route: '/projects/proj-web/skills',
    caption: 'Skill catalog, installed plugins, and MCP servers.',
    waitMs: 900,
    fullPage: true,
  },
  {
    name: 'github-board',
    route: '/projects/proj-web/view/board',
    caption: 'GitHub Projects board view.',
    waitMs: 1000,
  },
  {
    name: 'github-issues',
    route: '/projects/proj-web/view/issues',
    caption: 'GitHub issues list with filters and “Work locally”.',
    waitMs: 900,
  },
  {
    name: 'github-pulls',
    route: '/projects/proj-web/view/pulls',
    caption: 'Pull requests, grouped by task or listed together.',
    waitMs: 900,
  },
  {
    name: 'github-milestones',
    route: '/projects/proj-web/view/milestones',
    caption: 'Milestone progress.',
    waitMs: 900,
  },
  {
    name: 'automation-schedules',
    route: '/automation/config',
    caption: 'Automation schedules configuration.',
    waitMs: 900,
  },
  {
    name: 'automation-history',
    route: '/automation',
    caption: 'Automation run history across all schedules.',
    waitMs: 900,
  },
  {
    name: 'admin-users',
    route: '/admin',
    caption: 'Admin user management.',
    waitMs: 800,
  },
  {
    name: 'admin-daemon',
    route: '/daemon',
    caption: 'Session daemon status and controls.',
    waitMs: 800,
  },
];
