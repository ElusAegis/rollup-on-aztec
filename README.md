# Mini ZK-Rollup on Aztec (Proof of Concept)

A proof compression pipeline that batches 10 client proofs and settles on Aztec.
This fork compares two approaches: the IVC/Chonk pipeline and direct recursive
UltraHonk verification.

## Architecture

### IVC/Chonk/Tube Pipeline

```
per-tx UltraHonk (x10)
       |
   batch_app          <- verifies 10 UltraHonk proofs
       |
   init_kernel        <- verify_proof(batch_app, OINK), thread BatchOutput
       |
   tail_kernel        <- verify_proof(init_kernel, HN_TAIL), thread BatchOutput
       |
   hiding_kernel      <- verify_proof(tail_kernel, HN_FINAL), expose pub outputs
       |
   Chonk compress     <- AztecClientBackend.prove() compresses IVC chain
       |
   tube               <- verify_proof(chonk, CHONK), re-assert public outputs
       |
   L2 contract        <- verify_honk_proof(tube_vk, tube_proof)
```

### Alternative: Direct Recursive Verification

```
per-tx UltraHonk (x10)
       |
   direct_verifier    <- verifies 10 UltraHonk proofs directly
       |
   L2 contract        <- verify_honk_proof(direct_vk, direct_proof)
```

Direct recursive verification skips the IVC chain entirely. The
`direct_verifier` circuit is structurally identical to `batch_app` --
it verifies the same 10 client proofs and computes the same batch hash --
but it is proved with `UltraHonkBackend` instead of being fed into the
Chonk/IVC pipeline. The resulting UltraHonk proof can be verified on-chain
with the same `verify_honk_proof` call, no tube conversion needed.

The tradeoff is performance: UltraHonk proof verification inside an UltraHonk
circuit costs ~700k constraints per proof, while the Chonk backend handles
the same operations with native non-native EC support (Goblin/MegaHonk),
making it dramatically cheaper.

## Benchmark: IVC vs Direct

Measured on Apple M1 Pro (10 cores, 32 GB RAM), Node v24.13.0.
Both paths: generate 10 client proofs, batch-prove, deploy MiniRollup contract,
call `verify_batch` on-chain. Wrapped with `/usr/bin/time -l` for accurate
kernel-level resource measurement.

| Metric | IVC (Chonk + Tube) | Direct (UltraHonk) |
|---|---|---|
| **Total wall time** | **1m 15s** | 3m 37s |
| **Batch proving** | 10s (Chonk) + 41s (Tube) = **51s** | **2m 45s** |
| **VK artifact generation** | 10s | 38s |
| **Contract deploy + verify** | 10s | 10s |
| **verify_batch TX status** | checkpointed | checkpointed |
| **Peak RSS (kernel)** | **4.9 GB** | 8.9 GB |
| **CPU time (kernel user)** | 202s | 542s |

IVC is **2.9x faster** end-to-end and uses **1.8x less RAM**, despite requiring
7 circuits vs 1. The Chonk backend's native EC operations make recursive
verification cheap enough that the IVC overhead (3 kernel circuits + tube
conversion) is worth it.

The direct path uses more RAM because the UltraHonk prover must hold the full
~7M constraint system in WASM memory. Both transactions were accepted by the
Aztec sandbox sequencer (`revertCode: 0`).

### Phase Breakdown

**IVC path:**

| Phase | Duration |
|---|---|
| Initialize Barretenberg | 3ms |
| Client VK generation | 211ms |
| Generate 10 client proofs | 2.8s |
| IVC witness generation | 96ms |
| Chonk proving | 10.2s |
| Tube proving | 41.3s |
| Generate tube VK artifacts | 10.1s |
| Deploy + verify_batch | 10.1s |

**Direct path:**

| Phase | Duration |
|---|---|
| Initialize Barretenberg | 3ms |
| Client VK generation | 161ms |
| Generate 10 client proofs | 3.0s |
| Direct verifier execution | 86ms |
| Direct verifier proving | 2m 45s |
| Generate VK artifacts | 37.9s |
| Deploy + verify_batch | 10.2s |

### Measurement Notes

- Node.js `process.memoryUsage()` cannot see WASM memory. All RSS and CPU numbers
  come from `/usr/bin/time -l` (kernel `maxrss` and `getrusage`).
- The script's built-in telemetry tracks wall-clock time per phase. Wrap with
  `/usr/bin/time -l yarn prove:ivc` for the full picture.

## Circuits

| Circuit | Purpose | Proof Type |
|---|---|---|
| `client` | Proves `y = pedersen_hash(x)` | UltraHonk ZK |
| `batch_app` | Verifies 10 client proofs (IVC entry) | Chonk (via IVC) |
| `direct_verifier` | Verifies 10 client proofs (direct) | UltraHonk |
| `init_kernel` | IVC kernel #1 (OINK verify) | Chonk |
| `tail_kernel` | IVC kernel #2 (HN_TAIL verify) | Chonk |
| `hiding_kernel` | IVC kernel #3 (HN_FINAL verify) | Chonk |
| `tube` | Chonk -> UltraHonk conversion | UltraHonk |
| `contract` | On-chain verification | Aztec L2 |

## Build & Run

### Prerequisites

- `nargo` (Noir compiler) -- matching Aztec version
- `aztec` CLI for contract compilation
- `bb` (Barretenberg) for VK generation
- Node.js 18+

### Compile all circuits

```bash
# Noir circuits
for dir in client batch_app direct_verifier init_kernel tail_kernel hiding_kernel tube; do
  (cd circuits/$dir && nargo compile)
done

# Generate Chonk VKs for IVC circuits
for name in batch_app init_kernel tail_kernel hiding_kernel; do
  bb write_vk --scheme chonk \
    -b circuits/$name/target/$name.json \
    -o circuits/$name/target/vk_dir
  mv circuits/$name/target/vk_dir/vk circuits/$name/target/vk
  rmdir circuits/$name/target/vk_dir
done

# Aztec contract
cd contract && aztec compile
```

### Run the proof pipeline

```bash
cd scripts
yarn install

# IVC/Chonk path (default)
yarn prove ivc

# Direct recursive verification path
yarn prove direct

# With accurate resource measurement
/usr/bin/time -l yarn prove ivc
/usr/bin/time -l yarn prove direct
```

Requires a running Aztec sandbox for on-chain verification:

```bash
aztec start --local-network
```

## Key Constants

| Proof Type | Proof Length (fields) | VK Length (fields) | Type ID |
|---|---|---|---|
| UltraHonk ZK | 500 | 115 | 6 |
| Chonk | 1935 | 127 | 9 |
