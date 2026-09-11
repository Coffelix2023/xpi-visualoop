#!/usr/bin/env bash
#
# should-call smoke eval for xpi-visualoop.
#
# The only question this answers: does the model reach for the visual tools on
# its own, from the skill description alone? Code inspection cannot answer it,
# and neither can a unit test — the decision happens inside the model.
#
# Usage:
#   scripts/trigger-eval.sh              # run every case
#   scripts/trigger-eval.sh --case 2     # run one case
#
# Requires: `pi` on PATH, a model configured, and a reachable local dev server
# for the positive cases. The negative case needs nothing.
#
# Exit code: 0 when every case matched, 1 otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
readonly SCRIPT_DIR
readonly ROOT_DIR
readonly SKILL_DIR="$ROOT_DIR/skills"

# label | expected (yes = visual_prepare must appear, no = it must not) | prompt
readonly CASES=(
  'ui-intent|yes|打开 http://localhost:3000/settings,告诉我这个设置面板现在长什么样,有 console 报错也一并说明'
  'after-edit|yes|我刚调完 card 的间距,代码已经改好了,现在声明这个改动完成'
  'negative|no|把 src/visual-loop/config.ts 里未知字段的分支改成抛错,并补一个用例'
)

run_case() {
  local label="$1" expected="$2" prompt="$3"
  local workdir
  workdir="$(mktemp -d)"
  local transcript="$workdir/transcript.jsonl"

  echo "── $label (expect: $expected)"
  if ! pi -p -a \
    --session-dir "$workdir" \
    --name "trigger-eval-$label" \
    --skill "$SKILL_DIR" \
    "$prompt" >"$workdir/answer.txt" 2>&1; then
    echo "  FAIL: pi exited non-zero"
    sed 's/^/  | /' "$workdir/answer.txt" | tail -20
    return 1
  fi

  local session_file
  session_file="$(find "$workdir" -name '*.jsonl' -print0 | xargs -0 ls -t 2>/dev/null | head -1 || true)"
  if [[ -z "$session_file" ]]; then
    echo "  FAIL: no session transcript under $workdir"
    echo "  (check \`pi --session-dir\` layout; the answer is in $workdir/answer.txt)"
    return 1
  fi
  cp "$session_file" "$transcript"

  local calls
  calls="$(grep -c 'visual_prepare' "$transcript" || true)"
  echo "  session: $transcript"
  echo "  visual_prepare mentions: $calls"

  if [[ "$expected" == "yes" && "$calls" -gt 0 ]]; then
    echo "  PASS"
    return 0
  fi
  if [[ "$expected" == "no" && "$calls" -eq 0 ]]; then
    echo "  PASS"
    return 0
  fi
  echo "  FAIL: expected $expected, observed $calls mentions"
  return 1
}

main() {
  local only="${2:-}"
  local failures=0 index=0
  for entry in "${CASES[@]}"; do
    index=$((index + 1))
    if [[ -n "$only" && "$only" != "$index" ]]; then continue; fi
    IFS='|' read -r label expected prompt <<<"$entry"
    run_case "$label" "$expected" "$prompt" || failures=$((failures + 1))
  done
  echo
  if [[ "$failures" -eq 0 ]]; then
    echo "all cases matched"
  else
    echo "$failures case(s) did not match"
  fi
  [[ "$failures" -eq 0 ]]
}

main "$@"
