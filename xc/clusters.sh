#!/usr/bin/env bash
# Bring up TWO independent Fabric clusters on one host.
#   A = stock test-network (ports 7050..)        domain example.com
#   B = clone of test-network, ports +10000,      domain b.example.com, own docker network + project
# Each cluster: own orderer (Raft), own CAs/MSPs, 2 orgs x 1 peer, own channel and ledger, LevelDB.
# Usage: clusters.sh up|down
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$HERE/experiment.env"
FS="$(dirname "$TEST_NETWORK")"
A="$FS/test-network"; B="$FS/test-network-b"
BLOCK="${BLOCK:-100}"; TIMEOUT="${BATCH_TIMEOUT_XC:-100ms}"
log(){ echo "[$(date +%H:%M:%S)] $*"; }

tune() { # $1 = dir
  local CFG="$1/configtx/configtx.yaml"
  sed -i "s/^\(\s*MaxMessageCount:\).*/\1 $BLOCK/; s/^\(\s*BatchTimeout:\).*/\1 $TIMEOUT/; s/^\(\s*AbsoluteMaxBytes:\).*/\1 $ABSOLUTE_MAX_BYTES/; s/^\(\s*PreferredMaxBytes:\).*/\1 $PREFERRED_MAX_BYTES/" "$CFG"
  grep -E "MaxMessageCount|BatchTimeout|AbsoluteMaxBytes|PreferredMaxBytes" "$CFG" | grep -v '#'
}

make_b() {
  rm -rf "$B"; cp -r "$A" "$B"
  rm -rf "$B/organizations/peerOrganizations" "$B/organizations/ordererOrganizations" "$B/channel-artifacts" "$B/log.txt"
  # shift every host/container port by +10000, rename domain, docker network
  grep -rIl . "$B" --include='*.sh' --include='*.yaml' --include='*.yml' --include='*.json' --include='*.env' --include='*.tpl' | while read -r f; do
    perl -pi -e 's/\b(7050|7051|7052|7053|9051|9052|9443|9444|9445|7054|8054|9054|10054|5984|7984)\b/$1+10000/ge; s/example\.com/b.example.com/g; s/fabric_test/fabric_test_b/g' "$f"
  done
  # ccp templates and scripts use "localhost:PORT" and "orgN.example.com" - covered by the substitutions above
  grep -rn "fabric_test_b\|name:" "$B/compose" 2>/dev/null | head -8
}

bring_up() { # $1 = dir, $2 = project name, $3 = tag
  export COMPOSE_PROJECT_NAME="$2"
  local P1=7051 P2=9051; [ "$3" = B ] && { P1=17051; P2=19051; }
  ( cd "$1" && ./network.sh up >"/tmp/xc_up_$3.log" 2>&1 ) || { log "cluster $3: network up FAILED"; tail -20 /tmp/xc_up_$3.log; return 1; }
  for i in $(seq 1 60); do (echo > /dev/tcp/127.0.0.1/$P1) >/dev/null 2>&1 && (echo > /dev/tcp/127.0.0.1/$P2) >/dev/null 2>&1 && break; sleep 2; done
  sleep 5
  ( cd "$1" && export PATH="$1/../bin:$PATH" FABRIC_CFG_PATH="$1/configtx" && ./scripts/createChannel.sh "$CHANNEL" 3 10 false 0 >"/tmp/xc_ch_$3.log" 2>&1 ) || { log "cluster $3: createChannel FAILED"; tail -20 /tmp/xc_ch_$3.log; return 1; }
  ( cd "$1" && ./network.sh deployCC -c "$CHANNEL" -ccn "$CC_NAME" -ccp "$HERE/chaincode/ehr" -ccl go >"/tmp/xc_cc_$3.log" 2>&1 ) || { log "cluster $3: deployCC FAILED"; tail -20 /tmp/xc_cc_$3.log; return 1; }
  log "cluster $3 is up (channel $CHANNEL, chaincode $CC_NAME)"
}

case "${1:-up}" in
  up)
    docker rm -f $(docker ps -aq) >/dev/null 2>&1 || true; docker volume prune -f >/dev/null 2>&1 || true
    cp -n "$A/configtx/configtx.yaml" "$A/configtx/configtx.yaml.orig" 2>/dev/null; cp "$A/configtx/configtx.yaml.orig" "$A/configtx/configtx.yaml"
    make_b
    tune "$A"; tune "$B"
    bring_up "$A" clustera A || exit 1
    bring_up "$B" clusterb B || exit 1
    docker ps --format '{{.Names}}\t{{.Image}}' | sort | tee /tmp/xc_containers.txt
    ;;
  down)
    export COMPOSE_PROJECT_NAME=clusterb; ( cd "$B" && ./network.sh down >/dev/null 2>&1 )
    export COMPOSE_PROJECT_NAME=clustera; ( cd "$A" && ./network.sh down >/dev/null 2>&1 )
    docker rm -f $(docker ps -aq) >/dev/null 2>&1 || true ;;
esac
