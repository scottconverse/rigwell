#!/bin/bash
# Second capture pass. Runs as user 'cap' inside a fresh network namespace (loopback only).
OUT=/home/cap/out; DROID=/opt/droid/droid; FAKE=/opt/cap/fake_anthropic.py
log() { echo "$(date -Is) $*" >> "$OUT/run.log"; }
echo "start $(date -Is)" > "$OUT/run.log"
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
  log "$name exit=$? stdout=$(wc -c < "$OUT/$name.stdout.txt") stderr=$(wc -c < "$OUT/$name.stderr.txt")"
}

MODEL='{"model":"fake-model","displayName":"mock","provider":"anthropic","baseUrl":"http://127.0.0.1:18080","apiKey":"local-mock-not-a-secret","maxContextLimit":200000}'
MODEL_CAP='{"model":"fake-model","displayName":"mock","provider":"anthropic","baseUrl":"http://127.0.0.1:18080","apiKey":"local-mock-not-a-secret","maxContextLimit":200000,"maxOutputTokens":5000}'

scenario() { # name settingsJson ; runs body_<name> with a fresh home and a fresh fake server
  local name=$1 settings=$2
  local H=/home/cap/work/$name
  log "=== scenario $name"
  mkdir -p "$H/.factory"; echo "$settings" > "$H/.factory/settings.json"
  python3 "$FAKE" 18080 "$OUT/$name-requests" > "$OUT/$name.server.out.txt" 2>&1 &
  local srv=$!
  sleep 1
  export FACTORY_HOME_OVERRIDE=$H FACTORY_AIRGAP_ENABLED=1 FACTORY_DISABLE_KEYRING=1 FACTORY_DROID_AUTO_UPDATE_ENABLED=false OTEL_SDK_DISABLED=true HOME=$H TERM=xterm-256color
  "body_$name" "$H"
  kill $srv 2>/dev/null; wait $srv 2>/dev/null
  if [ -d "$H/.factory/logs" ]; then cp -r "$H/.factory/logs" "$OUT/$name-logs"; fi
}

two_turns() { # prefix home extra-args...
  local p=$1 h=$2; shift 2
  run ${p}1 "$h" 180 exec -m custom:mock-0 -o json "$@" "say hi"
  local sid
  sid=$(grep -oE '"session_?[iI]d"[[:space:]]*:[[:space:]]*"[^"]+"' "$OUT/${p}1.stdout.txt" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
  log "$p session id: $sid"
  if [ -n "$sid" ]; then run ${p}2 "$h" 180 exec -m custom:mock-0 -o json "$@" -s "$sid" "say hi again"; fi
}

# Tool lists per autonomy level (no model request needed)
listtools() {
  local H=/home/cap/work/L; mkdir -p "$H/.factory"; echo "{\"customModels\":[$MODEL]}" > "$H/.factory/settings.json"
  export FACTORY_HOME_OVERRIDE=$H FACTORY_AIRGAP_ENABLED=1 FACTORY_DISABLE_KEYRING=1 FACTORY_DROID_AUTO_UPDATE_ENABLED=false OTEL_SDK_DISABLED=true HOME=$H
  run L-default "$H" 60 exec -m custom:mock-0 --list-tools -o json
  for lvl in low medium high; do run L-$lvl "$H" 60 exec -m custom:mock-0 --auto $lvl --list-tools -o json; done
  run L-skip "$H" 60 exec -m custom:mock-0 --skip-permissions-unsafe --list-tools -o json
}

body_Dlow()    { run Dlow    "$1" 180 exec -m custom:mock-0 -o json --auto low "say hi"; }
body_Dmedium() { run Dmedium "$1" 180 exec -m custom:mock-0 -o json --auto medium "say hi"; }
body_Dhigh()   { run Dhigh   "$1" 180 exec -m custom:mock-0 -o json --auto high "say hi"; }
body_Dskip()   { run Dskip   "$1" 180 exec -m custom:mock-0 -o json --skip-permissions-unsafe "say hi"; }
body_F1() { two_turns F1 "$1"; }   # custom model with maxOutputTokens 5000
body_F2() { two_turns F2 "$1"; }   # repeat of the first compaction run, now with logs kept
body_E1() { ( cd "$1" && timeout -k 5 150 python3 /opt/cap/tui.py "$OUT/E1" "$OUT/E1-requests" "$DROID" ); log "E1 exit=$?"; }
body_E2() { ( cd "$1" && timeout -k 5 150 python3 /opt/cap/tui.py "$OUT/E2" "$OUT/E2-requests" "$DROID" --auto high ); log "E2 exit=$?"; }

mkdir -p /home/cap/work
listtools
scenario Dlow    "{\"customModels\":[$MODEL]}"
scenario Dmedium "{\"customModels\":[$MODEL]}"
scenario Dhigh   "{\"customModels\":[$MODEL]}"
scenario Dskip   "{\"customModels\":[$MODEL]}"
scenario F1 "{\"customModels\":[$MODEL_CAP],\"compactionTokenLimit\":1000}"
scenario F2 "{\"customModels\":[$MODEL],\"compactionTokenLimit\":1000}"
scenario E1 "{\"customModels\":[$MODEL],\"sessionDefaultSettings\":{\"model\":\"custom:mock-0\"}}"
scenario E2 "{\"customModels\":[$MODEL],\"sessionDefaultSettings\":{\"model\":\"custom:mock-0\"}}"
log DONE; echo done > "$OUT/DONE"
