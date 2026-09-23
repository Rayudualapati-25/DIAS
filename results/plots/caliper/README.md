# Caliper graph status

The five figures in this directory are methodology figures generated from the
configured Caliper inputs. Every figure is visibly marked **configured input,
not measured performance**. They may be used to explain experimental design,
but they must not appear in the Results section as throughput, latency,
scalability, stability, CPU, or memory evidence.

No performance-result graph exists yet because the repository contains no
completed Caliper report or `caliper-summary.json`. The two retained smoke
attempts both failed before a workload transaction was submitted.

After valid repeated runs exist, produce these evidence-backed result figures:

1. Read test: achieved throughput and average latency across repetitions, with
   uncertainty and failed-transaction rate.
2. Write test: achieved throughput and average latency across repetitions, with
   uncertainty and failed-transaction rate.
3. Increasing-load test: achieved throughput, latency, and failure rate against
   offered TPS, with one point per load step and uncertainty across repetitions.
4. Mixed test: throughput and latency across repetitions plus the observed
   read/write counts from `CALIPER_MIXED_WORKLOAD_SUMMARY` log records.
5. Endurance test: time-aligned throughput, failures, process memory, and CPU;
   one aggregate peak is not sufficient evidence of a memory leak.

Populate graphs only from retained completed runs. Exclude rows tagged
`warmup` or `connectivity`, retain negative runs, and show the exact repetition
count and aggregation method in each caption.
