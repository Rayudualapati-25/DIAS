# Local Fabric metrics monitoring

This Prometheus service collects resource and operational metrics from the
orderer and all five Fabric peers while a Caliper test is running. It does not
run Caliper and does not generate benchmark results by itself.

## Prerequisite

Start the Crime Records Fabric network first. Its external Docker network,
`crimenet`, and all six Fabric nodes must already exist.

## Start monitoring

From the `crime-records-network` project directory, run:

```bash
docker compose -f benchmarks/caliper/monitoring/compose.yaml up -d
```

Prometheus is available locally at <http://127.0.0.1:9090>. Its target status
page is <http://127.0.0.1:9090/targets>.

## Check monitoring

After Prometheus has had time to perform its first scrape, run:

```bash
node benchmarks/caliper/scripts/check-monitoring.js
```

The check succeeds only when Prometheus is ready and the orderer plus all five
peer targets report `up`. If it reports a missing or down target, confirm that
the Fabric network is still running, then retry the check after another scrape
interval.

## Stop monitoring

```bash
docker compose -f benchmarks/caliper/monitoring/compose.yaml down
```

The named `caliper-prometheus-data` volume keeps at most three days of metrics
across ordinary container restarts and `docker compose down`. Its port is bound
to localhost because this setup is intended only for controlled local research;
do not expose it to a public or untrusted network.

Prometheus measurements must be saved and interpreted alongside the matching
Caliper run artifacts. This configuration contains no benchmark numbers and
does not provide evidence for performance claims until an experiment is run.
