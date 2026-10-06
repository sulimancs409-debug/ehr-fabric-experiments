# EHR anchor benchmark kit (Fabric 2.5.11 + Caliper 0.5.0)

Layout
- `chaincode/ehr/`    Go chaincode: CreateRecord (write anchor), ReadRecord (read anchor)
- `caliper/`          Caliper network + benchmark templates and workload modules
- `scripts/run_experiments.sh`  full factorial runner (block level x clients x repetitions)
- `scripts/analyze.py`          mean/SD over repetitions, P50/P95/P99, failure causes, resources
- `experiment.env`    ALL factors and paths. Edit only this file.

## One-time setup (inside Ubuntu, not on /mnt/c)
    sudo apt install -y gettext-base unzip      # gettext-base provides envsubst
    # Node 18 via nvm (check Caliper 0.5.0 supported Node versions in its docs)
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    source ~/.bashrc && nvm install 18 && nvm use 18
    cd ~/ehr-kit/caliper
    npm install
    npx caliper bind --caliper-bind-sut fabric:2.2   # gateway-based binding, works with Fabric 2.5
Make sure `KIT_DIR` and `TEST_NETWORK` in `experiment.env` match your paths.

## 1. Smoke test (about 10 minutes) - always do this first
In `experiment.env` set temporarily:
    BLOCK_MSG_LEVELS="10"   CLIENT_LEVELS="10"   REPS=1   TX_DURATION=20   PRELOAD_PER_WORKER=20
Run `./scripts/run_experiments.sh smoke`, then `python3 scripts/analyze.py results/smoke`.
Send me `results/smoke/run.log` and the `caliper.log` from the first run directory if anything fails.

## 2. Full run (cloud VM recommended, several hours)
Restore the factor values in `experiment.env`, then
    nohup ./scripts/run_experiments.sh full1 > full1.out 2>&1 &
    python3 scripts/analyze.py results/full1
Keep the whole `results/full1` folder (raw per-transaction logs, Caliper logs, configs).
Deposit it with the paper's data-availability statement.

## Design notes the paper must state
- Block size: Fabric cuts a block at MaxMessageCount, PreferredMaxBytes or BatchTimeout, whichever
  comes first. Anchor transactions are ~0.4 KB, so MaxMessageCount controls block size here.
  Report the levels as MaxMessageCount with the (fixed) BatchTimeout, and give the average block size
  in bytes if you measure it. Do not call them "0.5-3 MB" blocks unless the byte limit is what cuts blocks.
- Clients: total in-flight transactions under Caliper's fixed-load controller (WORKERS x load per worker).
- Endorsement: Fabric default lifecycle policy (majority of channel orgs = both Org1 and Org2).
- Read TPS: chaincode evaluate calls (no ordering) via the gateway, not application-level FHIR calls.
- Write/read data: synthetic; payload ~400 B JSON. Ledger accumulates within one block level
  (set RESTART_EACH_BLOCK_LEVEL logic in the script if you want a fresh ledger per run).
- Latency is the client-observed time per transaction logged in the workload, not Caliper's own report.
  Cross-check against Caliper's `report.html` for each run.
