#!/bin/bash
# Contract test for .claude/hooks/protect-master.sh.
#
#   bash scripts/test-protect-master.sh        (or: npm test)
#
# That hook is the only thing standing between an agent and an accidental
# production deploy — pushing master ships to Firebase immediately. It is also
# a regex over a shell command string, which is exactly the kind of code that
# fails silently and in one direction: a missed pattern does not error, it just
# quietly permits the push.
#
# It had six such holes (xargs, sudo, env, subshell, time, and any pipeline
# form) until 2026-08-21, found only because one of them let a 103-branch
# remote prune through from master. Hence this file.
#
# Drives the real hook with real JSON stdin against throwaway repos, so both
# branch states are exercised without touching this one.

set -u
HOOK="$(cd "$(dirname "$0")/.." && pwd)/.claude/hooks/protect-master.sh"
[ -f "$HOOK" ] || { echo "  FAIL  hook not found at $HOOK"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

setup() {
  mkdir -p "$1"
  git -C "$1" init -q -b "$2"
  git -C "$1" commit -q --allow-empty -m init
}
MASTER="$TMP/on-master"
TOPIC="$TMP/on-topic"
setup "$MASTER" master
setup "$TOPIC" feat/x

pass=0
fail=0
# run <repo> <BLOCK|ALLOW> <command>
run() {
  local repo="$1" expect="$2" cmd="$3" out got
  out=$(jq -nc --arg c "$cmd" '{tool_input:{command:$c}}' \
        | CLAUDE_PROJECT_DIR="$repo" bash "$HOOK" 2>/dev/null)
  got="ALLOW"
  [[ "$out" == *'"deny"'* ]] && got="BLOCK"
  if [ "$got" = "$expect" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf '  FAIL  [%s] expected %s got %s :: %s\n' "$(basename "$repo")" "$expect" "$got" "$cmd"
  fi
}

# --- on master: every commit/push must be refused ------------------------
run "$MASTER" BLOCK 'git push'
run "$MASTER" BLOCK 'git push origin master'
run "$MASTER" BLOCK 'git commit -m wip'
run "$MASTER" BLOCK 'git fetch && git push'
run "$MASTER" BLOCK 'git push -q origin --delete foo'
# Wrapper and pipeline forms. These are the regressions this file exists for:
# each one is a real push that the pre-2026-08-21 anchor let through.
run "$MASTER" BLOCK 'cat list.txt | xargs git push origin --delete'
run "$MASTER" BLOCK 'head -3 f | tr "\n" " " | xargs git push origin --delete'
run "$MASTER" BLOCK 'sudo git push'
run "$MASTER" BLOCK 'env FOO=1 git commit -m x'
run "$MASTER" BLOCK '(git push)'
run "$MASTER" BLOCK 'time git push'

# --- on master: reading and unrelated work must still be allowed ---------
run "$MASTER" ALLOW 'git status'
run "$MASTER" ALLOW 'git log --oneline -5'
run "$MASTER" ALLOW 'git fetch origin --prune'
run "$MASTER" ALLOW 'npm test'
run "$MASTER" ALLOW 'git branch -d foo'
# Prose that merely mentions the commands — PR bodies and commit messages do
# this constantly, and blocking them would make the hook unusable.
run "$MASTER" ALLOW 'gh pr create --body "then run git push to deploy"'
run "$MASTER" ALLOW "echo 'git commit is blocked here'"
run "$MASTER" ALLOW 'grep -rn "git push" docs/'
# Near-misses that are not the git command.
run "$MASTER" ALLOW 'legit push'
run "$MASTER" ALLOW './mygit push'
run "$MASTER" ALLOW 'git pushd'

# --- on a topic branch: normal work proceeds ----------------------------
run "$TOPIC" ALLOW 'git push -u origin feat/x'
run "$TOPIC" ALLOW 'git commit -m "real work"'
run "$TOPIC" ALLOW 'git push origin --delete old-branch'
run "$TOPIC" ALLOW 'cat list.txt | xargs git push origin --delete'

# --- from anywhere: an explicit push to master is still refused ---------
run "$TOPIC" BLOCK 'git push origin master'
run "$TOPIC" BLOCK 'git push origin HEAD:master'
run "$TOPIC" BLOCK 'git push -f origin master'

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "protect-master hook: $fail of $((pass + fail)) checks FAILED"
  exit 1
fi
echo "protect-master hook: $pass checks — all pass"
