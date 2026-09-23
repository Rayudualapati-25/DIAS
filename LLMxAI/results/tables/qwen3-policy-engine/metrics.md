# Qwen3-14B policy-engine evaluation

All rows use the retained held-out synthetic policy suite. False allow is measured only among oracle non-allow cases.

| Arm | n | Schema valid | Decision | Decision macro-F1 | Reason | Reason macro-F1 | Joint | False allow | Adversarial joint | Median latency | p95 latency |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Untuned, no rules (Ollama) | 60 | 50.00% | 31.67% | 29.21% | 28.33% | 30.37% | 28.33% | 10/50 (20.00%) | 8.33% | 2939.2 ms | 3154.3 ms |
| Untuned, rules prompt (Ollama) | 60 | 90.00% | 61.67% | 47.46% | 40.00% | 40.40% | 40.00% | 7/50 (14.00%) | 16.67% | 3015.0 ms | 3292.4 ms |
| Untuned, no rules (prod decoding) | 60 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0/50 (0.00%) | 0.00% | 2150.1 ms | 2311.5 ms |
| Untuned, rules prompt (prod decoding) | 60 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0/50 (0.00%) | 0.00% | 1851.3 ms | 2061.8 ms |
| Fine-tuned V3 (proposed) | 60 | 93.33% | 80.00% | 76.41% | 75.00% | 75.66% | 75.00% | 0/50 (0.00%) | 70.83% | 2302.0 ms | 2521.7 ms |
| Fine-tuned V3, no subject attributes | 60 | 98.33% | 75.00% | 65.16% | 51.67% | 47.14% | 51.67% | 1/50 (2.00%) | 54.17% | 2173.2 ms | 2387.7 ms |
