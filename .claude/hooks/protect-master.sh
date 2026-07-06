#!/bin/bash
# PreToolUse[Bash] hook: block `git commit` while on master and any `git push`
# that targets master. Pushing master auto-deploys production (Firebase), so
# all work must go through a topic branch + PR.
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

# Only care about commands that actually invoke `git commit` or `git push`.
if ! printf '%s' "$cmd" | grep -qE '(^|[;&|][[:space:]]*|&&[[:space:]]*|\|\|[[:space:]]*)git[[:space:]]+(commit|push)'; then
  exit 0
fi

branch=$(git -C "${CLAUDE_PROJECT_DIR:-.}" branch --show-current 2>/dev/null)

blocked=false
if [ "$branch" = "master" ] && printf '%s' "$cmd" | grep -qE 'git[[:space:]]+(commit|push)'; then
  blocked=true
fi
# Explicit push to master from any branch (git push origin master / HEAD:master).
if printf '%s' "$cmd" | grep -qE 'git[[:space:]]+push[^;|&]*[[:space:]:]master([[:space:]]|$)'; then
  blocked=true
fi

if [ "$blocked" = true ]; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED by repo policy: never commit or push directly to master — pushing master deploys production immediately. Create a topic branch first: git fetch origin && git checkout -b <topic> origin/master, commit there, push the branch, and open a PR (PRs get a preview deploy)."}}
EOF
  exit 0
fi
exit 0
