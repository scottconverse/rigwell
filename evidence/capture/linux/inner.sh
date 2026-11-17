#!/bin/bash
# Runs as user 'cap' inside a fresh network namespace (loopback only). Never with network.
OUT=/home/cap/out; DROID=/opt/droid/droid; FAKE=/opt/cap/fake_anthropic.py
log() { echo "$(date -Is) $*" >> "$OUT/run.log"; }
echo "start $(date -Is)" > "$OUT/run.log"
ip link set lo up 2>>"$OUT/run.log" || log "lo up failed"
log "interfaces: $(ip -o link | awk -F': ' '{print $2}' | tr '\n' ' ')"
if timeout 5 python3 -c 'import socket; socket.create_connection(("1.1.1.1",443),3)' 2>/dev/null; then
  log "NETWORK REACHABLE - aborting"; exit 1
else
  log "network check: unreachable (good)"
fi

run() { # name dir timeout args...
  local name=$1 dir=$2 to=$3; shift 3
  log "$name args: $*"
  ( cd "$dir" && timeout -k 5 "$to" "$DROID" "$@" < /dev/null > "$OUT/$name.stdout.txt" 2> "$OUT/$name.stderr.txt" )
  local rc=$?
  log "$name exit=$rc stdout=$(wc -c < "$OUT/$name.stdout.txt") stderr=$(wc -c < "$OUT/$name.stderr.txt")"
}

MODEL='{"model":"fake-model","displayName":"mock","provider":"anthropic","baseUrl":"http://127.0.0.1:18080","apiKey":"local-mock-not-a-secret","maxContextLimit":200000}'

scenario() { # name settingsJson snapshotJson-or-empty; runs body_<name>
  local name=$1 settings=$2 snap=$3
  local H=/home/cap/work/$name
  log "=== scenario $name"
  mkdir -p "$H/.factory"; echo "$settings" > "$H/.factory/settings.json"
  python3 "$FAKE" 18080 "$OUT/$name-requests" > "$OUT/$name.server.out.txt" 2>&1 &
  local srv=$!
  sleep 1
  export FACTORY_HOME_OVERRIDE=$H FACTORY_AIRGAP_ENABLED=1 FACTORY_DISABLE_KEYRING=1 FACTORY_DROID_AUTO_UPDATE_ENABLED=false OTEL_SDK_DISABLED=true HOME=$H
  if [ -n "$snap" ]; then
    echo "$snap" > "$H/snapshot.json"; export FACTORY_FEATURE_FLAGS_SNAPSHOT_PATH=$H/snapshot.json
  else
    unset FACTORY_FEATURE_FLAGS_SNAPSHOT_PATH
  fi
  "body_$name" "$H"
  kill $srv 2>/dev/null; wait $srv 2>/dev/null
}

body_A() { run A "$1" 180 exec -m custom:mock-0 -o json "say hi"; }
body_B() { run B "$1" 180 exec -m custom:mock-0 -o json "say hi"; }
body_C() {
  run C1 "$1" 180 exec -m custom:mock-0 -o json "say hi"
  local sid
  sid=$(grep -oE '"session_?[iI]d"[[:space:]]*:[[:space:]]*"[^"]+"' "$OUT/C1.stdout.txt" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
  log "C session id: $sid"
  if [ -n "$sid" ]; then run C2 "$1" 180 exec -m custom:mock-0 -o json -s "$sid" "say hi again"; fi
}

mkdir -p /home/cap/work
run version /home/cap/work 30 --version
run help-exec /home/cap/work 30 exec --help
scenario A "{\"customModels\":[$MODEL]}" ''
scenario B "{\"customModels\":[$MODEL]}" '{"flags":{},"configs":{"script_tool_models":{"models":["custom:mock-0","custom:mock","fake-model"]}}}'
scenario C "{\"customModels\":[$MODEL],\"compactionTokenLimit\":1000}" ''
log DONE; echo done > "$OUT/DONE"
