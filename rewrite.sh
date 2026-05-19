#!/bin/bash
# Rewrite git history on main branch:
# - Change author/committer email to tiongl@users.noreply.github.com
# - Remove "Copilot" mentions from commit messages
# - Shift all commit dates to weekends (Sat/Sun)
#
# Run from repo root:
#   bash rewrite.sh
#
# After success, force push:
#   git push --force origin main

set -e
cd "$(dirname "$0")"

echo "==> Rewriting main branch history..."

git filter-branch -f \
  --env-filter "$(cat env-filter.sh)" \
  --msg-filter "$(cat msg-filter.sh)" \
  -- main

echo ""
echo "==> Done! Verify with:"
echo "    git --no-pager log --oneline --format='%ad %s' --date=format:'%a %Y-%m-%d %H:%M' main"
echo ""
echo "==> Then force push:"
echo "    git push --force origin main"
