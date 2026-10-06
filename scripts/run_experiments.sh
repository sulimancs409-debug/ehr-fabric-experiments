#!/usr/bin/env bash
# Full-factorial run: block level x client level x REPS. Run from anywhere.
# Usage: ./run_experiments.sh [results_dir_name]
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$HERE/experiment.env"
LOAD_MODE="${LOAD_MODE:-load}"
STATE_DB="${STATE_DB:-couchdb}"; ENDORSE_POLICY="${ENDORSE_POLICY:-}"
DBFLAG=""; [ "$STATE_DB" = "couchdb" ] && DBFLAG="-s couchdb"
CCEP_ARGS=(); [ -n "$ENDORSE_POLICY" ] && CCEP_ARGS=(-ccep "$ENDORSE_POLICY")
STAMP="${1:-run_$(date +%Y%m%d_%H%M%S)}"
OUT="$HERE/results/$STAMP"
mkdir -p "$OUT"
cp "$HERE/experiment.env" "$OUT/experiment.env"
echo "LOAD_MODE=${LOAD_MODE:-load}" >>"$OUT/experiment.env"

CFG="$TEST_NETWORK/configtx/configtx.yaml"
[ -f "$CFG.orig" ] || cp "$CFG" "$CFG.orig"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/run.log"; }

cleanup_network() {
  (cd "$TEST_NETWORK" && ./network.sh down >/dev/null 2>&1)
  docker rm -f $(docker ps -aq) >/dev/null 2>&1 || true
  docker volume prune -f >/dev/null 2>&1 || true
  docker volume rm compose_orderer.example.com compose_peer0.org1.example.com compose_peer0.org2.example.com >/dev/null 2>&1 || true
}

wait_http() {  # $1 = URL (CouchDB, admin:adminpw as in test-network)
  for _ in $(seq 1 90); do curl -sf -u admin:adminpw "$1" >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}
wait_port() {  # $1 = TCP port on localhost
  for _ in $(seq 1 90); do (echo > /dev/tcp/127.0.0.1/"$1") >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}

start_network() {  # $1 = MaxMessageCount
  cp "$CFG.orig" "$CFG"
  sed -i "s/^\(\s*MaxMessageCount:\).*/\1 $1/" "$CFG"
  sed -i "s/^\(\s*BatchTimeout:\).*/\1 $BATCH_TIMEOUT/" "$CFG"
  sed -i "s/^\(\s*AbsoluteMaxBytes:\).*/\1 $ABSOLUTE_MAX_BYTES/" "$CFG"
  sed -i "s/^\(\s*PreferredMaxBytes:\).*/\1 $PREFERRED_MAX_BYTES/" "$CFG"
  grep -E "MaxMessageCount|BatchTimeout|AbsoluteMaxBytes|PreferredMaxBytes" "$CFG" | grep -v '#' | tee -a "$OUT/run.log"
  # 1) start containers only; peers can crash if they come up before CouchDB is ready
  (cd "$TEST_NETWORK" && ./network.sh up $DBFLAG >"$OUT/network_up_$1.log" 2>&1) || { log "network up FAILED"; return 1; }
  # 2) wait for both CouchDB instances, then (re)start the peers if they exited early
  if [ "$STATE_DB" = "couchdb" ]; then
    wait_http http://localhost:5984/ && wait_http http://localhost:7984/ || { log "CouchDB not ready"; return 1; }
  fi
  docker start peer0.org1.example.com peer0.org2.example.com >/dev/null 2>&1 || true
  wait_port 7051 && wait_port 9051 || { log "peer ports not open"; return 1; }
  sleep 5
  # 3) create the channel and join both peers. IMPORTANT: pass the same -s couchdb here, otherwise
  #    network.sh re-runs 'up' with LevelDB and docker-compose 1.29 crashes recreating the peers.
  (cd "$TEST_NETWORK" && export PATH="$TEST_NETWORK/../bin:$PATH" FABRIC_CFG_PATH="$TEST_NETWORK/configtx" && ./scripts/createChannel.sh "$CHANNEL" 3 10 false 0 >"$OUT/channel_$1.log" 2>&1) || { log "createChannel FAILED"; return 1; }
  # Default lifecycle endorsement policy = MAJORITY of channel orgs (both orgs here)
  (cd "$TEST_NETWORK" && ./network.sh deployCC -c "$CHANNEL" -ccn "$CC_NAME" -ccp "$HERE/chaincode/ehr" -ccl go "${CCEP_ARGS[@]}" >"$OUT/deploy_$1.log" 2>&1) || { log "deployCC FAILED"; return 1; }
  docker ps --format '{{.Names}} {{.Image}}' >"$OUT/containers_$1.txt"
}

gen_network_config() {
  local ORG1="$TEST_NETWORK/organizations/peerOrganizations/org1.example.com"
  export ORG1_KEY="$(ls "$ORG1"/users/User1@org1.example.com/msp/keystore/* | head -1)"
  export ORG1_CERT="$(ls "$ORG1"/users/User1@org1.example.com/msp/signcerts/* | head -1)"
  export ORG1_CCP="$ORG1/connection-org1.yaml"
  export CHANNEL CC_NAME
  envsubst < "$HERE/caliper/networks/networkConfig.template.yaml" > "$HERE/caliper/networks/networkConfig.yaml"
}


sample_resources() {  # $1 = output csv; runs until killed. ts_ms,name,cpu%,mem  (HOST row = whole VM CPU%)
  local prev_idle=0 prev_total=0
  while :; do
    local t; t=$(date +%s%3N)
    read -r _ u n sy id io irq sirq st _ < /proc/stat
    local idle=$((id+io)) total=$((u+n+sy+id+io+irq+sirq+st))
    if [ "$prev_total" -gt 0 ]; then
      echo "$t,HOST,$(( 100*( (total-prev_total) - (idle-prev_idle) ) / (total-prev_total) ))%,0MiB" >>"$1"
    fi
    prev_idle=$idle; prev_total=$total
    docker stats --no-stream --format "$t,{{.Name}},{{.CPUPerc}},{{.MemUsage}}" >>"$1" 2>/dev/null
    sleep 1
  done
}

run_caliper() {  # $1=block $2=clients $3=rep
  export RUN_ID="b$1_c$2_r$3_$(date +%s)"
  export RESULTS_DIR="$OUT/b$1/c$2/rep$3"
  export WORKERS TX_DURATION PRELOAD_PER_WORKER
  export LOAD_PER_WORKER=$(( $2 / WORKERS ))
  if [ "$LOAD_MODE" = "rate" ]; then export RATE_TYPE=fixed-rate RATE_KEY=tps RATE_VAL="$2"
  else export RATE_TYPE=fixed-load RATE_KEY=transactionLoad RATE_VAL="$LOAD_PER_WORKER"; fi
  mkdir -p "$RESULTS_DIR"
  envsubst < "$HERE/caliper/benchmarks/config.template.yaml" > "$HERE/caliper/benchmarks/config.yaml"
  cp "$HERE/caliper/benchmarks/config.yaml" "$RESULTS_DIR/config.yaml"
  sample_resources "$RESULTS_DIR/resources_ts.csv" & local SAMPLER=$!
  ( cd "$HERE/caliper" && npx caliper launch manager \
      --caliper-workspace . \
      --caliper-networkconfig networks/networkConfig.yaml \
      --caliper-benchconfig benchmarks/config.yaml \
      --caliper-flow-only-test \
      --caliper-fabric-gateway-enabled \
      --caliper-report-path "$RESULTS_DIR/report.html" ) >"$RESULTS_DIR/caliper.log" 2>&1
  local rc=$?
  kill $SAMPLER 2>/dev/null; wait $SAMPLER 2>/dev/null
  # snapshot container resource use right after the run
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}},{{.BlockIO}}' >"$RESULTS_DIR/docker_stats.csv" 2>/dev/null || true
  return $rc
}

trap 'log "interrupted, cleaning up"; cleanup_network; exit 130' INT TERM
log "Results in $OUT"
for B in $BLOCK_MSG_LEVELS; do
  log "=== Block level MaxMessageCount=$B ==="
  cleanup_network
  start_network "$B" || { log "skip block level $B"; continue; }
  gen_network_config
  for C in $CLIENT_LEVELS; do
    for R in $(seq 1 "$REPS"); do
      log "block=$B clients=$C rep=$R"
      run_caliper "$B" "$C" "$R" || log "caliper returned non-zero (kept data)"
      sleep "$COOLDOWN"
    done
  done
done
cleanup_network
log "DONE. Next: python3 $HERE/scripts/analyze.py $OUT"
