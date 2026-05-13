# Multi-Project Commands

## Overview
Run the same Copilot prompt or shell command across multiple projects in parallel, with aggregated results.

## Features
- Select multiple projects from a picker
- Enter a single prompt to execute in each project
- Parallel execution with per-project status indicators
- Aggregated result view showing output per project
- Useful for bulk updates, audits, or migrations

## Implementation Notes
- Reuse existing session creation API with a batch wrapper
- New `/api/batch` endpoint or client-side orchestration
- Results page with collapsible per-project output panels
