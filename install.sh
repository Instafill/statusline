#!/usr/bin/env bash
# One-shot statusline setup for a new machine (macOS).
# Verifies Node 22+, installs the Claude Code hooks, registers the watcher to
# start at login, runs the preflight checks, and opens the UI.
# Safe to re-run: every step is idempotent.
#
#   ./install.sh                 full setup
#   ./install.sh --no-autostart  skip login registration
#   ./install.sh --no-start      do not launch the watcher now
#   ./install.sh --no-open       do not open the browser
#   ./install.sh --join <url> <enroll-code>   also enroll with the team endpoint
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$REPO/src/cli.js"
NO_AUTOSTART=0; NO_START=0; NO_OPEN=0; JOIN_URL=""; JOIN_CODE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --no-autostart) NO_AUTOSTART=1 ;;
    --no-start)     NO_START=1 ;;
    --no-open)      NO_OPEN=1 ;;
    --join)         JOIN_URL="${2:-}"; JOIN_CODE="${3:-}"; shift 2 ;;
    -h|--help)      sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

say()  { printf '  %s\n' "$1"; }
step() { printf '\n== %s\n' "$1"; }
die()  { printf '\nX %s\n' "$1" >&2; exit 1; }

printf '\nstatusline setup\n'
say "repo: $REPO"

step 'Checking Node.js'
command -v node >/dev/null 2>&1 || die 'Node.js is not installed or not on PATH. Install 22+ from https://nodejs.org, then re-run.'
VER="$(node --version)"; VER="${VER#v}"
[ "${VER%%.*}" -ge 22 ] || die "Node $VER found, but statusline needs 22 or newer."
say "Node $VER at $(command -v node)"

[ -f "$CLI" ] || die "Cannot find $CLI - run this script from inside the cloned repo."

step 'Checking Claude Code'
if command -v claude >/dev/null 2>&1; then
  say "claude at $(command -v claude)"
else
  say 'WARNING: the `claude` CLI is not on PATH.'
  say 'Hooks will still record sessions, but nothing can be classified until it is installed and logged in.'
fi

step 'Installing hooks into ~/.claude/settings.json'
node "$CLI" install || die 'Hook installation failed - see the error above. Your settings file was not modified.'

if [ "$NO_AUTOSTART" -eq 0 ]; then
  step 'Registering the watcher to start at login'
  node "$CLI" autostart || say 'WARNING: autostart registration failed. Start the watcher by hand with: node src/cli.js start'
else
  step 'Skipping autostart (--no-autostart)'
fi

if [ -n "$JOIN_URL" ] || [ -n "$JOIN_CODE" ]; then
  [ -n "$JOIN_URL" ] && [ -n "$JOIN_CODE" ] || die 'Enrollment needs both a URL and a code: --join <url> <enroll-code>'
  step 'Enrolling this machine with the team endpoint'
  node "$CLI" join "$JOIN_URL" "$JOIN_CODE" || die 'Enrollment failed - re-run with a fresh code from your dashboard.'
fi

if [ "$NO_START" -eq 0 ]; then
  step 'Starting the watcher'
  if curl -fsS --max-time 2 http://127.0.0.1:45817/api/health >/dev/null 2>&1; then
    say 'Already running.'
  else
    # launchd may have started it already; this is the fallback path.
    nohup node "$CLI" start >>"$HOME/.statusline/watcher.out.log" 2>&1 &
    say 'Launched in the background.'
    sleep 3
  fi
fi

step 'Running preflight checks'
node "$CLI" doctor || true

printf '\nSetup complete.\n'
say 'UI:        http://127.0.0.1:45817'
say 'Re-check:  node src/cli.js doctor'
say 'Remove:    node src/cli.js uninstall && node src/cli.js autostart --off'
printf '\n'
say 'statusline observes every Claude Code session on this machine, including personal'
say 'work, and sends a text digest of each one to an LLM through your own Claude login.'
say 'The Egress tab lists every call. Label a session "Ignore" to exclude it.'
printf '\n'

if [ "$NO_OPEN" -eq 0 ] && [ "$NO_START" -eq 0 ]; then
  if command -v open >/dev/null 2>&1; then open http://127.0.0.1:45817
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://127.0.0.1:45817 >/dev/null 2>&1 || true
  fi
fi
