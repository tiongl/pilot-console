# Health Dashboard

## Overview
Visualize the existing `/api/perf` monitor data as interactive charts instead of raw JSON — event loop lag, WS latency, GC pauses, and stall sources.

## Features
- Event loop lag sparkline and histogram
- WS round-trip latency per session
- GC pause frequency and duration chart
- Stall source breakdown (bar chart)
- Auto-refresh with configurable interval
- Threshold markers for "healthy" vs "degraded"

## Implementation Notes
- New admin page: `/admin/health`
- Fetch `/api/perf` on interval
- Charts using recharts or similar
- Most data is already available — just needs visualization
