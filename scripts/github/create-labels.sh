#!/usr/bin/env bash
# Creates or updates the repository labels from .github/labels.json. Needs the GitHub CLI (gh) and jq.
set -euo pipefail
REPO="${1:-techsaurabh-394/haat-gateway}"
jq -c '.[]' .github/labels.json | while read -r label; do
  name=$(jq -r .name <<<"$label"); color=$(jq -r .color <<<"$label"); desc=$(jq -r .description <<<"$label")
  gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force
done
