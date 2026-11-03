#!/usr/bin/env bash
# Creates the good first issues from docs/good-first-issues/NN.md. Run create-labels.sh first.
# Usage: scripts/github/create-issues.sh [owner/repo] [--dry-run]
set -euo pipefail
REPO="${1:-techsaurabh-394/haat-gateway}"
DRY="${2:-}"
for f in docs/good-first-issues/[0-9][0-9].md; do
  title=$(sed -n 's/^title: //p' "$f" | head -1)
  labels=$(sed -n 's/^labels: //p' "$f" | head -1 | sed 's/, */,/g')
  body=$(awk 'f{print} /^---$/{f=1}' "$f")
  if [[ "$DRY" == "--dry-run" ]]; then
    echo "would create: $title [$labels]"
  else
    gh issue create --repo "$REPO" --title "$title" --label "$labels" --body "$body"
    sleep 1
  fi
done
