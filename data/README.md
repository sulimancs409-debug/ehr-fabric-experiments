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
- `xc/`  two-cluster experiment: cross-cluster read latency vs emulated WAN RTT, functional (tamper/unavailable/token) cases, 1 vs 2 cluster scale-out
- `fhir/` FHIR R4 gateway: HL7 validator result for 90 round-tripped resources, 12 negative/security cases, end-to-end load (10..100 TPS)
- `fhir_smoke_run1/` first FHIR smoke run kept unmodified (3/9 validator errors, cause in NOTE.txt)

Regenerate every figure:  `python3 scripts/make_figures.py data/final data/xc figures`
