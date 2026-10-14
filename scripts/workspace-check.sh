#!/usr/bin/env bash
# Read-only worktree check. Fetch updates remote refs but never changes files.
set -euo pipefail

mode="${1:---main}"
if [[ "$mode" == "--help" ]]; then
  printf 'Usage: bash scripts/workspace-check.sh [--main|--task]\n'
  printf 'Require a clean, current v2 checkout or a clean linked Git worktree based on origin/v2.\n'
  exit 0
fi
if [[ $# -gt 1 || ( "$mode" != "--main" && "$mode" != "--task" ) ]]; then
  printf 'Expected --main or --task.\n' >&2
  exit 2
fi

checkout_root="$(git rev-parse --show-toplevel)"
cd "$checkout_root"
if ! git fetch --quiet origin; then
  printf 'Cannot verify current v2: fetching origin failed.\n' >&2
  exit 1
fi
git rev-parse --verify origin/v2 >/dev/null
git_dir="$(git rev-parse --absolute-git-dir)"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
branch="$(git symbolic-ref --quiet --short HEAD || true)"
read -r ahead behind < <(git rev-list --left-right --count HEAD...origin/v2)
status="$(git status --porcelain=v1 --untracked-files=all)"
failed=0

printf 'Checkout: %s\nBranch: %s\nCompared with origin/v2: %s ahead, %s behind\n' \
  "$checkout_root" "${branch:-detached HEAD}" "$ahead" "$behind"

if [[ -n "$status" ]]; then
  printf '\nUncommitted work must be assigned to a task before continuing:\n%s\n' "$status"
  failed=1
fi
if [[ "$mode" == "--main" ]]; then
  if [[ "$git_dir" != "$common_dir" || "$branch" != "v2" ]]; then
    printf '\nUse the canonical executor-v2 checkout on v2.\n'
    failed=1
  fi
  if [[ "$ahead" != 0 || "$behind" != 0 ]]; then
    printf '\nv2 must match origin/v2. Preserve local commits; only fast-forward a clean checkout.\n'
    failed=1
  fi
else
  if [[ "$git_dir" == "$common_dir" ]]; then
    printf '\nUse an linked Git worktree for task work; keep the canonical checkout on v2.\n'
    failed=1
  fi
  if [[ -z "$branch" || "$branch" == "v2" ]]; then
    printf '\nTask work needs its own named branch.\n'
    failed=1
  fi
  if [[ "$behind" != 0 ]]; then
    printf '\nIntegrate current origin/v2 into this task branch before continuing.\n'
    failed=1
  fi
fi
if [[ "$failed" == 0 ]]; then printf '\nWorkspace check passed.\n'; fi
exit "$failed"
