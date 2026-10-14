#!/bin/zsh
# The daily run, unattended: what launchd starts before the US open.
#
#   scripts/scheduled-run.sh           the run: /daily-run unattended
#   scripts/scheduled-run.sh --check   a dry run: which tools the session gets
#   scripts/scheduled-run.sh --install load the schedule into launchd
#   scripts/scheduled-run.sh --remove  unload it
#
# It starts the dashboard when it is down, then a background Claude Code
# session (`claude --bg`: a print-mode session is not offered the tool that
# publishes the phone page) that does steps 0 to 6 of the skill and stops. It
# asks nothing: what is not on the allow list below is refused, not prompted
# for. That session cannot trade:
# every Zesty tool that previews, places or cancels an order is denied on its
# command line, whatever a prompt or a file may say. Orders wait for the user,
# who approves them from the phone page or with `/daily-run orders`.
#
# Log: .whatsapp/logs/daily-run-<date>.log. The session itself stays listed
# under `claude agents` until the next run, so it can be opened and read.

ROOT="${0:A:h:h}"
cd "$ROOT" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LABEL="com.stock-recommender.daily-run"
PLIST="$ROOT/scripts/schedule/$LABEL.plist"
LOGS="$ROOT/.whatsapp/logs"
LOG="$LOGS/daily-run-$(date +%F).log"
mkdir -p "$LOGS"

case "$1" in
  --install)
    mkdir -p "$HOME/Library/LaunchAgents"
    cp "$PLIST" "$HOME/Library/LaunchAgents/$LABEL.plist"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LABEL.plist" && launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|Weekday|Hour|Minute" | head -20
    exit $? ;;
  --remove)
    launchctl bootout "gui/$(id -u)/$LABEL"
    rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
    exit 0 ;;
esac

# What the session may do without asking, and what it may never do.
ALLOW=(
  "Bash(python3 scripts/*)" "Bash(pnpm exec tsx scripts/report-page.ts *)" "Bash(pnpm dev)"
  "Bash(curl *)" "Bash(date *)" "Bash(ls *)"
  Read Write Edit Glob Grep Agent Skill ToolSearch Monitor Artifact PushNotification
  mcp__stock-recommender mcp__tradingview
  mcp__claude_ai_Zesty__get_orders mcp__claude_ai_Zesty__get_order_detail mcp__claude_ai_Zesty__get_positions
  mcp__claude_ai_Zesty__get_balance mcp__claude_ai_Zesty__get_movements mcp__claude_ai_Zesty__get_dividends
  mcp__claude_ai_Zesty__get_market_status
)
DENY=(
  mcp__claude_ai_Zesty__confirm_us_order mcp__claude_ai_Zesty__apps_confirm_us_order
  mcp__claude_ai_Zesty__apps_preview_us_order mcp__claude_ai_Zesty__confirm_cl_order
  mcp__claude_ai_Zesty__confirm_buy_usd mcp__claude_ai_Zesty__confirm_sell_usd
  mcp__claude_ai_Zesty__cancel_order mcp__claude_ai_Zesty__preview_us_limit_order
  mcp__claude_ai_Zesty__preview_us_market_order mcp__claude_ai_Zesty__preview_us_stop_order
  mcp__claude_ai_Zesty__preview_us_trailing_stop_order mcp__claude_ai_Zesty__preview_us_bracket_order
  mcp__claude_ai_Zesty__preview_us_crypto_order mcp__claude_ai_Zesty__preview_cl_limit_order
  mcp__claude_ai_Zesty__preview_buy_usd mcp__claude_ai_Zesty__preview_sell_usd
  mcp__claude_ai_Zesty__send_feedback
)

# Start a background session, wait for it to finish and print what it said.
# $1 the prompt, $2 the most seconds to wait.
run_session() {
  local id state waited=0
  id=$(claude --bg "$1" --permission-mode dontAsk --allowedTools "${ALLOW[@]}" --disallowedTools "${DENY[@]}" < /dev/null 2>&1 \
    | sed -n 's/^backgrounded · //p' | head -1)
  if [[ -z "$id" ]]; then echo "could not start a background session"; return 1; fi
  echo "session $id (open it with: claude attach $id)"
  echo "$id" > "$LOGS/last-session"
  while (( waited < $2 )); do
    sleep 20; (( waited += 20 ))
    state=$(claude agents --json 2>/dev/null | python3 -c "
import json, sys
for r in json.load(sys.stdin):
    if r.get('id') == '$id':
        print(r.get('state') or r.get('status') or '')" 2>/dev/null)
    [[ "$state" == "done" || -z "$state" ]] && break
  done
  if [[ "$state" != "done" && -n "$state" ]]; then
    echo "still '$state' after $2 seconds: stopping it"
    claude stop "$id" > /dev/null 2>&1
  fi
  # The log of a terminal session is full of cursor movements: keep the text.
  claude logs "$id" 2>/dev/null | python3 -c "
import re, sys
t = sys.stdin.read()
t = re.sub(r'\x1b\[\d+G', ' ', t)
t = re.sub(r'\x1b\[\d*[ABCD]', '\n', t)
t = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', t)
lines = [l.rstrip() for l in t.splitlines() if l.strip()]
print('\n'.join(lines[-60:]))"
  [[ "$state" == "done" ]]
}

if [[ "$1" == "--check" ]]; then
  run_session "Do not run anything else. Call ToolSearch with query 'select:Artifact,PushNotification,mcp__claude_ai_Zesty__get_orders,mcp__claude_ai_Zesty__confirm_us_order,mcp__claude_ai_Zesty__preview_us_limit_order,mcp__claude_ai_Zesty__cancel_order,mcp__stock-recommender__playbook' and answer in one line starting with RESULT: naming exactly the tools that were returned. The three that confirm, preview or cancel an order must not be among them." 240
  code=$?
  claude rm "$(cat "$LOGS/last-session")" > /dev/null 2>&1
  exit $code
fi

# One run at a time: a second start while the first still works would sync and
# publish over it.
LOCK="$LOGS/run.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [[ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ]]; then rmdir "$LOCK"; mkdir "$LOCK"; else
    echo "$(date '+%F %T') another run holds $LOCK: not starting" >> "$LOG"; exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

{
  echo "=== $(date '+%F %T %Z') scheduled run"
  # Yesterday's session has been read or it never will be.
  [[ -f "$LOGS/last-session" ]] && claude rm "$(cat "$LOGS/last-session")" > /dev/null 2>&1
  if ! curl -sf -m 10 localhost:3000/api/whatsapp/status > /dev/null; then
    echo "dashboard down: starting it"
    nohup pnpm dev >> "$LOGS/dashboard.log" 2>&1 &
    for i in {1..60}; do
      curl -sf -m 5 localhost:3000/api/whatsapp/status > /dev/null && break
      sleep 5
    done
    # The WhatsApp client needs a moment after the server answers.
    sleep 30
  fi
  # caffeinate keeps the Mac awake while this script waits on the session.
  caffeinate -i -w $$ &
  run_session "Read .claude/skills/daily-run/SKILL.md and follow it as \`/daily-run unattended\`: steps 0 to 6, no question to the user, no order placed, and a PushNotification at the end." 7200
  CODE=$?
  echo "=== $(date '+%F %T %Z') finished with exit code $CODE"
} >> "$LOG" 2>&1
exit ${CODE:-1}
