# Activity Feed

## Overview
A unified timeline of commits, session starts/ends, automation runs, and project changes across all projects.

## Features
- Chronological feed on the home page
- Filter by project, event type, and date range
- Real-time updates via WebSocket
- Clickable entries linking to relevant pages
- Compact and expanded view modes

## Implementation Notes
- New `activity_log` table: `(id, type, projectId, userId, payload, createdAt)`
- Emit activity events from key server actions (session create/end, git commit, schedule run)
- New `GET /api/activity` endpoint with pagination and filters
- Broadcast new activity via existing WS infrastructure
