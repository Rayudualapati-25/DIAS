### Live Fabric vs paper simulation (SEBA-XAI Section IV-F)

| Quantity | Paper (local simulation) | This work (live Fabric, 5 orgs) |
|---|---|---|
| Audit build latency p50, end to end | 11.1 ms | 2072.69 ms |
| — of which orderer batch wait (config) | n/a | 2000 ms |
| — marginal processing cost | 11.1 ms | 72.69 ms |
| Verification latency p50 | 2.5 ms | 3.99 ms |
| Storage per audit event | 353.5 B | 857 B |

Workload: 10 requests per seed over seeds {7, 21, 42, 99, 123} = 50 timed submissions; verification measured 50 times.

**Reading the build latency.** The end-to-end figure is dominated by the
orderer's `BatchTimeout` of 2000 ms, not by the audit design: the p50 is
2072.69 ms with a min–max spread of only 82.4 ms,
which is the signature of a fixed batch wait rather than variable computation.
The comparable quantity against the simulation's 11.1 ms is the
marginal cost of ~72.69 ms (policy evaluation, XAI artifact construction,
endorsement by 3 of 5 organizations, validation, and commit). `BatchTimeout` is a
throughput/latency tuning parameter; lowering it lowers this figure directly.

**Storage is not like-for-like.** This implementation commits the full explanation
artifact inline (857 B) whereas the paper's 353.5 B
figure covers a leaner blockchain-style audit record. The gap reflects a richer
record schema, not per-byte overhead introduced by Fabric.

### Attack replay on the live network

| Attack | Defended by | Outcome |
|---|---|---|
| explanation-hash substitution | on-chain explanation hash recomputation | blocked / detected |
| off-chain record tampering | payload hash vs on-chain commitment | blocked / detected |
| unauthorized audit-record injection | chaincode clientIdentity MSP check (not endorsement policy alone) | blocked / detected |
| request backdating | schema allow-list + chaincode uses stub.getDateTimestamp() | blocked / detected |
| approval-token exposure (replay precondition) | chaincode stores only sha256(token) | blocked / detected |

Every attack above is blocked by a mechanism that the paper's threat model names.
Note the scope limit: these are integrity, authorization, and metadata-exposure
attacks. The paper's compromised-signer attack is NOT replayed here — on a real
Fabric network it requires a compromised MSP admin key, a strictly stronger
assumption than in the simulation, and it remains future work.
