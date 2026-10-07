# Measured data

Everything here was produced by the GitHub Actions workflows in `.github/workflows/` (public runners, ubuntu-22.04, 4 vCPU, ~15 GB RAM,
Docker 28.0.4, Hyperledger Fabric 2.5.15, Caliper 0.5.0). Nothing was edited, filtered or re-run to improve a result.

- `factorial/`  full factorial (block level x client load, 5 repetitions), fixed-load controller
- `ablation/`   state DB (LevelDB/CouchDB), endorsement policy, BatchTimeout, 6 configurations
- `final/<config>/`  offered-load sweep (fixed-rate, 100..600 TPS, 3 repetitions) per configuration
    - `summary.csv` mean and SD over repetitions, P50/P95/P99, success rate, failed tx
    - `resources.csv` CPU/memory sampled during each round (HOST = whole VM)
    - `failures.csv` failed transactions with error text
    - `raw_per_tx_logs.tar.gz` per-transaction start/end/ok/error logs and the exact Caliper configs of every round
    - `env_runner.txt` runner hardware and tool versions
- `xc/`  two-cluster experiment (added when that workflow has run)

Regenerate every figure:  `python3 scripts/make_figures.py data/final data/xc figures`
