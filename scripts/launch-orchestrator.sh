#!/usr/bin/env bash
# Visible, idempotent launcher for the comfyui-mcp orchestrator.
#
# WHY THIS LIVES OUTSIDE THE COMFYUI CUSTOM NODE: the Comfy Registry security
# standards (https://docs.comfy.org/registry/standards) bar a custom node from
# spawning processes at runtime (the scanner flags B404/B603), so comfyui-agent-
# panel deliberately never spawns the orchestrator. This launcher is the sanctioned
# "always-on" path: an external script, run in a VISIBLE terminal, that the user
# can see and kill — never a hidden daemon.
#
# USAGE:
#   ./launch-orchestrator.sh                 # run in the current (visible) terminal
#   open -a Terminal ./launch-orchestrator.sh  # open its own Terminal window
#   (or wire it to login via the sibling com.comfyui-mcp.orchestrator.plist)
#
# It is SAFE to run anytime: if an orchestrator already owns the bridge port it
# exits immediately instead of colliding on :9180.
set -euo pipefail

# Self-locate so the orchestrator path is not hardcoded to one machine.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH="$SCRIPT_DIR/../dist/index.js"

BRIDGE_PORT="${COMFYUI_MCP_BRIDGE_PORT:-9180}"
COMFY_PORT="${COMFYUI_PORT:-8188}"

if [ ! -f "$ORCH" ]; then
  echo "[launch] built orchestrator not found at: $ORCH"
  echo "[launch] run 'npm run build' in $(cd "$SCRIPT_DIR/.." && pwd) first."
  exit 1
fi

# Already running? Defer — never double-spawn / collide on the bridge port.
# -sTCP:LISTEN matters: a bare lsof also matches ESTABLISHED client sockets (e.g. a
# zombie process's dangling connection) and would false-positive "already running".
if lsof -ti "tcp:${BRIDGE_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[launch] an orchestrator already owns :${BRIDGE_PORT} — nothing to start."
  exit 0
fi

# Wait for the ComfyUI backend so 'connect' targets a live instance (up to 60s).
echo "[launch] waiting for ComfyUI on :${COMFY_PORT} …"
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:${COMFY_PORT}/" 2>/dev/null; then
    echo "[launch] ComfyUI is up."
    break
  fi
  sleep 1
done

echo "[launch] starting orchestrator — close this window or press Ctrl-C to stop."
# Foreground exec: whoever runs this script (a Terminal window) shows the process
# and its logs, and owns its lifetime. This is the 'visible terminal' contract.
exec node "$ORCH" connect
