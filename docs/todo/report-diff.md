# Report Diff

## Overview
Compare two automation run outputs side-by-side to see what changed between runs — useful for monitoring drift or regressions.

## Features
- Select two runs of the same schedule to compare
- Side-by-side or unified diff view of output
- Highlight additions, removals, and changes
- Summary statistics (lines added/removed)
- Auto-compare with previous run option

## Implementation Notes
- Diff computed client-side using a library like `diff` or `jsdiff`
- New UI page or modal: `/automation/:scheduleId/compare?a=runId1&b=runId2`
- Store rendered report output (already in report runs table)
