#!/usr/bin/env bash
# Lock down `main`, idempotently. Safe to re-run.
#
#   - all changes via PR (0 required approvals, so a solo dev can self-merge)
#   - required status checks must pass and the branch must be up to date
#   - rules apply to admins too
#   - no force-pushes, no deletions
#   - branches auto-delete on merge
#
# NOTE: the `pool` branch is deliberately NOT protected. The nightly harvester commits
# on top of it and fast-forwards (no force-push), because a GITHUB_TOKEN-created PR does
# not fire `pull_request` events and would therefore never satisfy the required checks
# below — every harvest PR would be permanently unmergeable. See docs/DESIGN.md §4.3.
set -euo pipefail

REPO="${1:-wardcrazy01894/RandomYoutubeLinkGenerator}"

echo "Applying branch protection to $REPO@main ..."
gh api -X PUT "repos/$REPO/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["build / typecheck / lint", "test", "secret scan", "pool integrity"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false,
  "required_conversation_resolution": true
}
JSON

echo "Enabling delete-branch-on-merge ..."
gh api -X PATCH "repos/$REPO" -f delete_branch_on_merge=true -f allow_squash_merge=true >/dev/null

echo "Done. main is PR-only with required checks: build / typecheck / lint, test, secret scan, pool integrity."
