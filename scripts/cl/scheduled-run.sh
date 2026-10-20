#!/bin/zsh
# The Chilean run, unattended: what launchd starts after the Santiago close.
#
#   scripts/cl/scheduled-run.sh           the run: /chile-run unattended
#   scripts/cl/scheduled-run.sh --check   a dry run: which tools the session gets
#   scripts/cl/scheduled-run.sh --install load the schedule into launchd
#   scripts/cl/scheduled-run.sh --remove  unload it
#
# It starts the dashboard when it is down, then a background Claude Code
# session (`claude --bg`: print mode has no Artifact tool for the phone page)
# that follows .claude/skills/chile-run/SKILL.md. It asks nothing: what is not
# on the allow list is refused, not prompted for. Of the Zesty connector it
# gets only the Chilean market data (asset details: price, order book,
# presencia bursátil; market hours); every tool that previews, places or
# cancels an order is denied, and so is the US stock-recommender MCP server,
# so this session can neither trade nor read the US book.
#
# It takes the same lock as the US run (scripts/scheduled-run.sh), so the two
# never sync WhatsApp at the same time.
#
# Log: .whatsapp/logs/chile-run-<date>.log.

ROOT="${0:A:h:h:h}"
cd "$ROOT" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LABEL="com.stock-recommender.chile-run"
PLIST="$ROOT/scripts/cl/schedule/$LABEL.plist"
LOGS="$ROOT/.whatsapp/logs"
LOG="$LOGS/chile-run-$(date +%F).log"
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

ALLOW=(
  "Bash(python3 scripts/*)" "Bash(pnpm exec tsx scripts/cl/*)" "Bash(pnpm dev)"
  "Bash(curl *)" "Bash(date *)" "Bash(ls *)" "Bash(pdfinfo *)" "Bash(pdftotext *)"
  Read Write Edit Glob Grep Agent Skill ToolSearch Monitor Artifact PushNotification WebSearch
  mcp__tradingview mcp__claude_ai_Zesty__get_asset_details mcp__claude_ai_Zesty__get_market_status
)
DENY=(
  mcp__stock-recommender
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
  echo "$id" > "$LOGS/chile-last-session"
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
  run_session "Do not run anything else. Call ToolSearch with query 'select:Artifact,PushNotification,WebSearch,mcp__claude_ai_Zesty__get_asset_details,mcp__claude_ai_Zesty__preview_cl_limit_order,mcp__claude_ai_Zesty__confirm_cl_order,mcp__stock-recommender__playbook' and answer in one line starting with RESULT: naming exactly the tools that were returned. get_asset_details should be among them; no preview, confirm or stock-recommender tool may be." 240
  code=$?
  claude rm "$(cat "$LOGS/chile-last-session")" > /dev/null 2>&1
  exit $code
fi

LOCK="$LOGS/run.lock"
for i in {1..18}; do
  mkdir "$LOCK" 2>/dev/null && break
  if [[ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ]]; then rmdir "$LOCK"; continue; fi
  # The other run holds it: wait up to 90 minutes before giving up.
  (( i == 18 )) && { echo "$(date '+%F %T') another run holds $LOCK: not starting" >> "$LOG"; exit 0; }
  sleep 300
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

{
  echo "=== $(date '+%F %T %Z') scheduled Chilean run"
  [[ -f "$LOGS/chile-last-session" ]] && claude rm "$(cat "$LOGS/chile-last-session")" > /dev/null 2>&1
  if ! curl -sf -m 10 localhost:3000/api/whatsapp/status > /dev/null; then
    echo "dashboard down: starting it"
    nohup pnpm dev >> "$LOGS/dashboard.log" 2>&1 &
    for i in {1..60}; do
      curl -sf -m 5 localhost:3000/api/whatsapp/status > /dev/null && break
      sleep 5
    done
    sleep 30
  fi
  caffeinate -i -w $$ &
  run_session "Read .claude/skills/chile-run/SKILL.md and follow it as \`/chile-run unattended\`: every step, no question to the user, and a PushNotification at the end." 5400
  CODE=$?
  echo "=== $(date '+%F %T %Z') finished with exit code $CODE"
} >> "$LOG" 2>&1
exit ${CODE:-1}
