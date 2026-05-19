#!/bin/bash
read -r -d '' MSG || true
case "$GIT_COMMIT" in
4392c9a91e0f0eaf0c9dcc28a8c94c2be85af6e2)
  echo "feat: add client-side output filter for CLI internal errors"
  exit 0
  ;;
415feb1a64e9b7b7267731b92d28935dd6aa40ad)
  echo "chore: add instructions — no co-authored-by trailers"
  exit 0
  ;;
esac
echo "$MSG"
