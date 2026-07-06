#!/bin/bash
# PostToolUse[Edit|Write] hook: lint the edited file if it is a JS file under
# src/, and feed any ESLint errors straight back to the model (exit 2).
input=$(cat)
f=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
proj="${CLAUDE_PROJECT_DIR:-$(pwd)}"

case "$f" in
  "$proj"/src/*.js) ;;
  *) exit 0 ;;
esac
[ -f "$f" ] || exit 0

cd "$proj" || exit 0
out=$(npx eslint --no-color "$f" 2>&1)
status=$?
if [ $status -ne 0 ]; then
  {
    echo "ESLint failed for $f — fix these before finishing:"
    echo "$out"
  } >&2
  exit 2
fi
exit 0
