#!/usr/bin/env bash
# The self-heal GitHub Action, as a script (D-032).
#
# Runs the loop on a fresh `self-heal/…` branch and, when at least one fix was
# verified, pushes that branch and opens a pull request. It never pushes to the
# base branch: the threat model's last line of defence is a human reviewing the
# fix (THREAT-MODEL.md, T9), and a pull request is how CI asks for one.
#
# Plain bash rather than inline YAML so it can be run, and tested, outside GitHub.
# Everything comes in through the environment; every external command is
# overridable (SELF_HEAL_CMD, GH) so a test can stand in for it.
#
#   SELF_HEAL_BASE      branch the PR targets                       (required)
#   SELF_HEAL_CONFIG    path to the config          (default self-heal.config.json)
#   SELF_HEAL_BRANCH    branch to create   (default self-heal/<run id>-<attempt>)
#   SELF_HEAL_OPEN_PR   "false" to commit on the branch and stop     (default true)
#   SELF_HEAL_ARGS      extra arguments for `self-heal run`
#   SELF_HEAL_CMD       how to invoke self-heal (default npx --yes self-heal@latest)
#   GH                  how to invoke the GitHub CLI                  (default gh)
set -euo pipefail

say() { printf 'self-heal: %s\n' "$*" >&2; }
refuse() { say "refusing: $*"; exit 64; }

base="${SELF_HEAL_BASE:?SELF_HEAL_BASE is required: the branch a fix PR should target}"
config="${SELF_HEAL_CONFIG:-self-heal.config.json}"
branch="${SELF_HEAL_BRANCH:-self-heal/${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}}"
open_pr="${SELF_HEAL_OPEN_PR:-true}"
report="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/self-heal-report.md"
self_heal="${SELF_HEAL_CMD:-npx --yes self-heal@latest}"
gh_cmd="${GH:-gh}"

# --- never push anywhere a human did not ask for -----------------------------
case "$branch" in
  self-heal/*) ;;
  *) refuse "branch \"$branch\" must start with self-heal/ — this action only pushes branches it owns" ;;
esac
[ "$branch" != "$base" ] || refuse "branch and base are both \"$base\""

# --- never run on code from someone else's fork, with this repo's secrets -----
# `pull_request_target` and `workflow_run` run with the base repository's secrets
# and write token. Checking out a fork's code there and handing it to a model is
# the textbook way to leak both. The workflow should already exclude it; this
# makes it impossible rather than unlikely.
if [ "${GITHUB_EVENT_NAME:-}" = "pull_request_target" ]; then
  refuse "pull_request_target runs fork code with this repository's secrets"
fi
if [ "${GITHUB_EVENT_NAME:-}" = "workflow_run" ] && [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "$GITHUB_EVENT_PATH" ]; then
  head_repo="$(node -e 'const e=require(process.argv[1]); process.stdout.write(String(e.workflow_run?.head_repository?.full_name ?? ""))' "$GITHUB_EVENT_PATH")"
  if [ -n "$head_repo" ] && [ "$head_repo" != "${GITHUB_REPOSITORY:-}" ]; then
    refuse "the failing run came from $head_repo, not ${GITHUB_REPOSITORY:-this repository}"
  fi
fi

# --- run the loop on a branch of its own --------------------------------------
start="$(git rev-parse HEAD)"
git switch --quiet --create "$branch"
say "on $branch from ${start:0:8}, targeting $base"

set +e
# shellcheck disable=SC2086 # word splitting of the command and extra args is intended
$self_heal run --config "$config" --report-md "$report" ${SELF_HEAL_ARGS:-}
status=$?
set -e

if [ -f "$report" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$report" >> "$GITHUB_STEP_SUMMARY"
fi

fixes="$(git rev-list --count "$start..HEAD")"
output() { if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; fi; }
output fixes "$fixes"
output exit-code "$status"
output branch "$branch"

if [ "$fixes" -eq 0 ]; then
  say "no verified fixes — nothing to push"
  exit "$status"
fi
if [ "$open_pr" != "true" ]; then
  say "$fixes fix commit(s) on $branch; open-pr is off, so not pushing"
  exit "$status"
fi

# Explicit refspec: the only ref this ever writes is the self-heal branch.
git push --quiet origin "HEAD:refs/heads/$branch"
[ -f "$report" ] || printf 'self-heal made %s fix commit(s); no report was written.\n' "$fixes" > "$report"
# shellcheck disable=SC2086
url="$($gh_cmd pr create --base "$base" --head "$branch" --title "self-heal: $fixes verified fix(es)" --body-file "$report")"
output pr-url "$url"
say "opened $url"
exit "$status"
