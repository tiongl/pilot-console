# Chained Schedules

## Overview
Trigger one automation schedule when another completes successfully, enabling multi-step workflows.

## Features
- Configure "on success, run schedule X" in schedule settings
- Chain multiple schedules in sequence
- Visual pipeline view showing chain progress
- Conditional chaining (on success, on failure, always)
- Cycle detection to prevent infinite loops

## Implementation Notes
- Add `chainNextScheduleId` and `chainCondition` columns to schedules table
- After report execution completes, check for chain config and trigger next
- Add a `triggeredBy` field to runs to track chain provenance
- UI: dropdown to select next schedule in schedule edit form
