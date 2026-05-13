# PR Dashboard

## Overview
Show open pull requests per project with status, review state, and CI check results — all visible without leaving the console.

## Features
- List open PRs for each project with title, author, branch, and age
- Review status indicators (approved, changes requested, pending)
- CI/CD check status (pass/fail/pending)
- Click to open PR in browser
- Auto-refresh via GitHub webhook or polling

## Implementation Notes
- Use `gh pr list --json` for data (gh CLI already available)
- New `/api/projects/:id/prs` endpoint
- Cache results with short TTL (60s) to avoid rate limits
- Optional GitHub webhook integration for real-time updates
