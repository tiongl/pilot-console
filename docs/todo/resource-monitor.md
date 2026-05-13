# Resource Monitor

## Overview
Track CPU and memory usage of the server and daemon processes over time, surfaced as charts in the admin panel.

## Features
- Real-time CPU and memory usage for server and daemon processes
- Historical charts (last hour, day, week)
- Per-session resource attribution
- Alerts when thresholds are exceeded
- Export data as CSV

## Implementation Notes
- Sample `process.cpuUsage()` and `process.memoryUsage()` every 10s
- Store in a ring buffer (in-memory) and optionally persist to SQLite
- Extend `/api/perf` or add `/api/admin/resources` endpoint
- Use a lightweight chart library (e.g., recharts, already common in React)
