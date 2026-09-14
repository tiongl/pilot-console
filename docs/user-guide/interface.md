# Interface tour

Once you sign in, the dashboard is split into a persistent **left sidebar** and a
main content area.

![Chief of Staff home](images/home-chief-of-staff.png)

## The left sidebar

- **Chief of Staff** (top) — jumps to the portfolio home page.
- **Projects** — a tree of every project. Expand a project to see its branch and
  git worktrees. A coloured status dot shows each session's state:
  - 🟢 green — idle (a session is running, waiting for input)
  - 🟡 yellow (pulsing) — busy (working)
  - 🔴 red — exited with an error
  - ⚫ grey — no active session
  - On hover you can **pin/unpin** a project (pinned projects float to the top),
    **add** a worktree or directory (**+**), or **delete** one (trash icon).
  - Clicking a **project name** opens its [Project Lead](project-lead.md); clicking
    a **worktree** opens that worktree's [chat workspace](sessions.md).
- **Automation** (lower section, with a draggable divider) — your automation
  schedules, each with an unread-activity badge. **All** opens the full
  [run history](automation.md); the wrench opens the schedule configuration.
- **Bottom bar** — a **theme** selector, a **daemon status** dot (click to open
  [Daemon management](admin.md)), and **Sign out**.

### Resizing

Drag the divider between the sidebar and the content to resize the sidebar
(180–400 px). Drag the dotted divider between **Projects** and **Automation** to
change how the two sections share the sidebar's height.

## Split view

Click the **columns** icon next to the *Projects* header to pick a grid layout
(1×1 up to 4×4). Each pane can show a different project, worktree, or automation
view; the active pane is highlighted, and choosing something from the sidebar
fills that pane. In multi-pane layouts you can **drag terminal tabs between
panes**.

## Themes

The theme selector at the bottom of the sidebar offers **Light**, **Dark**,
**System**, and several named themes (Midnight, Nord, Solarized, Catppuccin
Mocha, GitHub Dark). Your choice is remembered across reloads.

## Floating Lead / Chief of Staff chat

A round **chat button** floats in the bottom-right corner of every page. Click it
to open a draggable, resizable window and chat with the **Chief of Staff** or any
project's **Project Lead** without leaving the page you're on. The window
remembers its position and size.

Alongside it, a **bell/alert widget** surfaces portfolio alerts — blocked work,
stale work, pending merge requests, and open decisions — and clicking an alert
jumps to the relevant project.
