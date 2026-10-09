# 20261009_step19_repository — repository preparation evidence

- **Plan:** `experiments/plans/20261009_step19_repository.md`
- **Machine:** cloud Linux container, Node 22.22.0, Python 3.13.
- **Path placeholders:** in the captured logs, this container's absolute paths
  were replaced at capture time by `<repo>` (repository root), `<out>` (rebuild
  output directory) and `<venv>` (analysis virtual environment). Nothing else
  in the logs was changed.

## Files

| File | What it shows |
|---|---|
| `archive-dependency-check.json` | dependency check run before moving legacy content to `archive/` |
| `pip-freeze.txt` | the resolved Python packages behind `testbed/analysis/requirements.txt` |
| `python-analysis-tests.log` | `pytest` of `testbed/analysis` and `testbed/scripts/test_capture_manifest.py` in that environment: 20 passed |
| `archived-analysis-rebuild/rebuild.log` | `testbed/analysis/rebuild_archived.sh` output: steps that could not be rebuilt and the comparison summary |
| `archived-analysis-rebuild/comparison.json` | per-file comparison with `experiments/runs/20260924_testbed_multivm/analysis/` |
| `archived-analysis-rebuild/*.err` | why E3, E5, E6 (Prometheus not available) and the capacity figure (needs E3) failed |
| `clean-clone/` | `make install`, `make test`, validator, Python tests and the offline integrity run from a fresh clone |
