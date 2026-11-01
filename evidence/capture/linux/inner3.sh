#!/bin/bash
# Third pass: manual compaction in the interactive app via /compress. Runs as 'cap' in a loopback-only namespace.
OUT=/home/cap/out; DROID=/opt/droid/droid; FAKE=/opt/cap/fake_anthropic.py
log() { echo "$(date -Is) $*" >> "$OUT/run3.log"; }
echo "start $(date -Is)" > "$OUT/run3.log"
if timeout 5 python3 -c 'import socket; socket.create_connection(("1.1.1.1",443),3)' 2>/dev/null; then
  log "NETWORK REACHABLE - aborting"; exit 1
else
  log "network check: unreachable (good)"
fi
MODEL='{"model":"fake-model","displayName":"mock","provider":"anthropic","baseUrl":"http://127.0.0.1:18080","apiKey":"local-mock-not-a-secret","maxContextLimit":200000}'
H=/home/cap/work/E3; mkdir -p "$H/.factory"
echo "{\"customModels\":[$MODEL],\"sessionDefaultSettings\":{\"model\":\"custom:mock-0\"}}" > "$H/.factory/settings.json"
python3 "$FAKE" 18080 "$OUT/E3-requests" > "$OUT/E3.server.out.txt" 2>&1 &
srv=$!; sleep 1
export FACTORY_HOME_OVERRIDE=$H FACTORY_AIRGAP_ENABLED=1 FACTORY_DISABLE_KEYRING=1 FACTORY_DROID_AUTO_UPDATE_ENABLED=false OTEL_SDK_DISABLED=true HOME=$H TERM=xterm-256color
export TUI_CMD=/compress TUI_DELAY=0.15 TUI_CONFIRM=1
( cd "$H" && timeout -k 5 150 python3 /opt/cap/tui.py "$OUT/E3" "$OUT/E3-requests" "$DROID" ); log "E3 exit=$?"
kill $srv 2>/dev/null; wait $srv 2>/dev/null
if [ -d "$H/.factory/logs" ]; then cp -r "$H/.factory/logs" "$OUT/E3-logs"; fi
log DONE
