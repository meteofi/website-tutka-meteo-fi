#!/bin/bash
# PreToolUse[Bash] hook: block `git commit` while on master and any `git push`
# that targets master. Pushing master auto-deploys production (Firebase), so
# all work must go through a topic branch + PR.
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

# Prose that merely *mentions* these commands must not trigger a block: PR
# bodies and commit messages routinely quote `git push`. Strip single- and
# double-quoted spans first, so what remains is roughly the part of the command
# line the shell would actually execute.
#
# Heredoc bodies are not stripped, but they are reached through `git commit -F -`
# / `gh pr create --body-file`, and the former is itself a blocked command on
# master anyway — so the residual false-positive surface is small.
bare=$(printf '%s' "$cmd" | sed -e "s/'[^']*'//g" -e 's/"[^"]*"//g')

# Only care about commands that actually invoke `git commit` or `git push`.
#
# Match at any command position, not just after a shell separator. The previous
# anchor ('^' or ';&|') silently missed wrapper forms — most importantly
# `… | xargs git push origin --delete`, which is a real push and went through
# unchecked. Requiring only a non-word character before `git` covers separators,
# subshells and wrappers (xargs/sudo/env/time/nohup) alike.
# The trailing class must accept `)`, `;`, `|` and friends as well as
# whitespace — `(git push)` in a subshell is still a push — while rejecting an
# alphanumeric continuation so `git pushd` is not mistaken for `git push`.
if ! printf '%s' "$bare" | grep -qE '(^|[^[:alnum:]_.-])git[[:space:]]+(commit|push)([^[:alnum:]_-]|$)'; then
  exit 0
fi

branch=$(git -C "${CLAUDE_PROJECT_DIR:-.}" branch --show-current 2>/dev/null)

blocked=false
# Any commit or push while sitting on master. Deliberately broad: it also
# refuses harmless-looking pushes such as `git push origin --delete <topic>`.
# Do that from a topic branch rather than loosening this.
if [ "$branch" = "master" ]; then
  blocked=true
fi
# Explicit push to master from any branch (git push origin master / HEAD:master).
if printf '%s' "$bare" | grep -qE 'git[[:space:]]+push[^;|&]*[[:space:]:]master([[:space:]]|$)'; then
  blocked=true
fi

if [ "$blocked" = true ]; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED by repo policy: never commit or push directly to master — pushing master deploys production immediately. Create a topic branch first: git fetch origin && git checkout -b <topic> origin/master, commit there, push the branch, and open a PR (PRs get a preview deploy)."}}
EOF
  exit 0
fi
exit 0
