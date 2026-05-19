#!/usr/bin/env python3
"""Rewrite git history: change email, remove copilot mentions, shift to weekends."""

import subprocess
import re
import math
from datetime import datetime, timedelta

def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=True)

# Get all commits on main in chronological order
result = run(['git', '--no-pager', 'log', 'main', '--reverse', '--format=%H|||%aI|||%s'])
commits = []
for line in result.stdout.strip().split('\n'):
    parts = line.split('|||')
    if len(parts) == 3:
        commits.append({'hash': parts[0], 'date': parts[1], 'msg': parts[2]})

print(f'Total commits on main: {len(commits)}')

# Generate weekend days (Sat+Sun) to spread commits across
weekends = []
start = datetime(2026, 3, 28)  # a Saturday
end = datetime(2026, 5, 17)
d = start
while d <= end:
    if d.weekday() == 5:  # Saturday
        weekends.append(d)
        weekends.append(d + timedelta(days=1))  # Sunday
    d += timedelta(days=1)

print(f'Available weekend days: {len(weekends)}')

# Distribute commits across weekend days
n = len(commits)
n_days = len(weekends)
# Spread evenly, multiple commits per day if needed
commits_per_day = max(1, math.ceil(n / n_days))

# Build hash -> (new_date, new_msg) mapping
NEW_EMAIL = 'tiongl@users.noreply.github.com'
NEW_NAME = 'Tiong Lee'

date_map = {}
msg_map = {}

day_idx = 0
count_on_day = 0

for i, c in enumerate(commits):
    # Assign weekend date with time spread across the day
    weekend_day = weekends[day_idx]
    # Spread commits within the day (9am - 11pm)
    hour_start = 9
    hour_end = 23
    if commits_per_day > 1:
        frac = count_on_day / commits_per_day
        hour = hour_start + frac * (hour_end - hour_start)
    else:
        hour = 10 + (i % 12)
    
    h = int(hour)
    m = int((hour - h) * 60)
    s = (i * 17) % 60  # pseudo-random seconds
    
    new_dt = weekend_day.replace(hour=h, minute=m, second=s)
    date_str = new_dt.strftime('%Y-%m-%dT%H:%M:%S') + '-07:00'
    date_map[c['hash']] = date_str
    
    # Fix copilot mentions in message
    msg = c['msg']
    msg = re.sub(r'[Cc]opilot\s+CLI\s+', 'CLI ', msg)
    msg = re.sub(r'[Cc]opilot\s+', '', msg)
    msg = re.sub(r'copilot', '', msg, flags=re.IGNORECASE)
    # Clean up any double spaces
    msg = re.sub(r'  +', ' ', msg).strip()
    if msg != c['msg']:
        print(f'  MSG: "{c["msg"]}" -> "{msg}"')
    msg_map[c['hash']] = msg
    
    count_on_day += 1
    if count_on_day >= commits_per_day:
        count_on_day = 0
        day_idx += 1
        if day_idx >= n_days:
            day_idx = n_days - 1

# Write env-filter script
env_lines = []
for h, d in date_map.items():
    env_lines.append(f'if [ "$GIT_COMMIT" = "{h}" ]; then')
    env_lines.append(f'  export GIT_AUTHOR_DATE="{d}"')
    env_lines.append(f'  export GIT_COMMITTER_DATE="{d}"')
    env_lines.append(f'fi')

env_script = '\n'.join(env_lines)
env_script += f'\nexport GIT_AUTHOR_EMAIL="{NEW_EMAIL}"'
env_script += f'\nexport GIT_COMMITTER_EMAIL="{NEW_EMAIL}"'
env_script += f'\nexport GIT_AUTHOR_NAME="{NEW_NAME}"'
env_script += f'\nexport GIT_COMMITTER_NAME="{NEW_NAME}"'

with open('env-filter.sh', 'w', newline='\n') as f:
    f.write(env_script)

# Write msg-filter script  
msg_lines = ['#!/bin/bash', 'read -r -d "" MSG || true', 'COMMIT="$GIT_COMMIT"']
for h, m in msg_map.items():
    if m != next((c['msg'] for c in commits if c['hash'] == h), ''):
        escaped = m.replace('"', '\\"').replace("'", "'\\''")
        msg_lines.append(f'if [ "$COMMIT" = "{h}" ]; then echo "{escaped}"; exit 0; fi')
msg_lines.append('echo "$MSG"')

with open('msg-filter.sh', 'w', newline='\n') as f:
    f.write('\n'.join(msg_lines))

print(f'\nGenerated env-filter.sh and msg-filter.sh')
print(f'Commits remapped to {day_idx + 1} weekend days')
print(f'\nDate range: {weekends[0].strftime("%Y-%m-%d")} to {weekends[day_idx].strftime("%Y-%m-%d")}')

# Show sample mappings
print('\nSample date mappings:')
for c in commits[:3] + commits[-3:]:
    old_d = c['date'][:10]
    new_d = date_map[c['hash']][:10]
    print(f'  {c["hash"][:8]} {old_d} -> {new_d}  {msg_map[c["hash"]][:60]}')
