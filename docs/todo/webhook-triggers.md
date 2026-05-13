# Webhook Triggers

## Overview
Run automations in response to GitHub events (push, PR opened, issue created) via incoming webhooks.

## Features
- Register webhook endpoints per schedule
- Filter by event type, branch, and repository
- Secret-based signature verification (HMAC-SHA256)
- Event log showing received webhooks and triggered runs
- Manual webhook test/replay

## Implementation Notes
- New `POST /api/webhooks/:scheduleId` endpoint
- Verify `X-Hub-Signature-256` header
- Parse GitHub event payload, match against schedule filters
- Reuse `executeReport()` for execution
- Store webhook events in a `webhook_log` table
