# Qwen3-14B policy-engine evaluation

All rows use the retained held-out synthetic policy suite. False allow is measured only among oracle non-allow cases.

| Arm | n | Schema valid | Decision | Decision macro-F1 | Reason | Reason macro-F1 | Joint | False allow | Adversarial joint | Median latency | p95 latency |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Untuned, no rules (Ollama) | 60 | 100.00% | 48.33% | 46.21% | 41.67% | 39.63% | 41.67% | 20/50 (40.00%) | 20.83% | 2939.2 ms | 3154.3 ms |
| Untuned, rules prompt (Ollama) | 60 | 100.00% | 68.33% | 60.16% | 46.67% | 48.18% | 46.67% | 7/50 (14.00%) | 20.83% | 3015.0 ms | 3292.4 ms |
| Untuned, no rules (prod decoding) | 60 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0/50 (0.00%) | 0.00% | 2150.1 ms | 2311.5 ms |
| Untuned, rules prompt (prod decoding) | 60 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0/50 (0.00%) | 0.00% | 1851.3 ms | 2061.8 ms |
| Fine-tuned V3 | 60 | 100.00% | 86.67% | 84.03% | 81.67% | 82.01% | 81.67% | 0/50 (0.00%) | 70.83% | 2302.0 ms | 2521.7 ms |
| Fine-tuned V4 (proposed) | 60 | 100.00% | 93.33% | 92.52% | 90.00% | 90.34% | 90.00% | 1/50 (2.00%) | 75.00% | 2302.3 ms | 2494.3 ms |
| Fine-tuned V4, no subject attributes | 60 | 100.00% | 66.67% | 61.73% | 46.67% | 43.03% | 46.67% | 2/50 (4.00%) | 54.17% | 2391.9 ms | 2804.0 ms |
