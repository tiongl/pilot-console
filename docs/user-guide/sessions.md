# Sessions & terminals

Pilot Console's workspace is a **multi-tabbed terminal and chat environment**.
Open it by clicking a project's branch or a worktree in the sidebar. Each tab is
one session; tabs persist across reloads, and their status shows in the tab
header.

## Tab types

Click the **+** on the tab bar to open a new tab:

| Type | What it is |
|------|-----------|
| **Copilot CLI** | The default AI-assisted CLI session. |
| **Copilot CLI (classic terminal)** | Same, but with `TERM=xterm-256color` for accurate terminal identity — fixes some scrollback glitches at the cost of exposing occasional TUI rendering quirks. |
| **Copilot Agent** | The full agent chat pane (see below). |
| **Terminal** | A raw shell (bash/zsh/…). |
| **PowerShell** | A PowerShell session. |
| **Git log / Git status / Files** | Read-only helpers for the working tree. |

Tabs can be renamed (double-click), closed, dragged between panes in
[split view](interface.md#split-view), and each can override the workspace's
font family, font size, and terminal colour theme.

## Terminal tabs

CLI, shell, and PowerShell tabs are full terminal emulators (xterm.js) with
complete ANSI support. Type directly; `Ctrl+C`, `Ctrl+D` and friends work as
usual. Terminals resize automatically with the window. Font family, size (8–24px)
and colour theme are saved per project.

## The Copilot Agent pane

The **Copilot Agent** tab is a rich conversational interface with streaming
responses, tool calls, and reasoning.

- **Mode** — switch between **Interactive**, **Plan**, and **Auto-pilot** from the
  header (or `/mode`, or `Shift+Tab`).
- **Model** — choose **Auto** or a specific model from the header (or `/model`).
- **Input** — type in the box; **Enter** sends, **Shift+Enter** inserts a newline.
- **Dictation** — click the **microphone** to dictate; transcribed text is
  appended to your message. (Hidden in browsers without the Web Speech API.)
- **Slash commands** — type `/` for an autocomplete menu: `/model`, `/mode`,
  `/resume`, `/diff`, `/share`, `/stop`, `/clear`, `/help`, plus any skill
  commands.

### Reading the transcript

Use the **View** menu to show/hide **tool calls**, **tool output**, **reasoning**,
and **notices**, or switch to **Outline mode** (just your requests and the final
replies). There's an in-transcript **search**, and a **usage** popover showing
token counts and cost. **Share** exports the session or produces a shareable
GitHub link.

### Permission prompts & "Allow all"

When the agent needs to perform an action it shows an inline **permission**
card — **Approve** or **Deny**. Toggle **Allow all** to auto-approve every further
request in that session (shown as `allow all: on/off` in the pane footer).

### Click-to-answer questions

When the agent asks you something with the **ask_user** tool, it appears as a card
with **buttons** — click one to answer in a single click. If free text is allowed
you can also type your own answer. (You can always type instead of clicking, and
your typed reply is taken as the real answer.)

### Plan mode

In **Plan** mode the agent proposes a set of actions before making changes and
asks you to confirm or pick a different mode before it proceeds.

## Where sessions live

All terminal/agent processes are owned by the background **session daemon**, so
they keep running if the server restarts and reconnect automatically. See
[Administration → Daemon](admin.md#session-daemon) for the operational view.
