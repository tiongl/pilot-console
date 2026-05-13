# Session Replay

## Overview
Replay past terminal sessions with a timeline scrubber, allowing users to step through output as it originally appeared.

## Features
- Scrubber/timeline control for completed sessions
- Play, pause, speed control (1x, 2x, 5x)
- Click on timeline to jump to any point
- Syntax-highlighted output in an xterm instance
- Shareable replay links

## Implementation Notes
- Requires timestamped output chunks (currently output_log is a single blob)
- Add a `session_chunks` table: `(session_id, seq, timestamp, data)`
- Record chunks in real-time during session, replay by feeding them to xterm with timing
- Alternatively, use asciicast format for compatibility with asciinema
