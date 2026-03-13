# Mini ZK-Rollup on Aztec (Proof of Concept)

A 4-layer proof compression pipeline that settles on Aztec:

```
Client (UltraHonk ZK) x10  ->  Batch Verifier (Chonk)  ->  Tube (UltraHonk ZK)  ->  Aztec Contract
```

## Architecture

1. **Client circuit** (`circuits/client/`): Proves `y = pedersen_hash(x)` - knowledge of hash preimage
2. **Batch verifier** (`circuits/batch_verifier/`): Verifies 10 client UltraHonk proofs. Proved with **Chonk** for cheap recursive verification via non-native EC ops
3. **Tube circuit** (`circuits/tube/`): Verifies the Chonk proof, produces an UltraHonk proof that Aztec can verify
4. **Aztec contract** (`contract/`): Calls `verify_honk_proof` on the tube output

## Why Chonk?

- UltraHonk proof verification in an UltraHonk circuit: ~700k constraints per proof
- UltraHonk proof verification in a Chonk circuit: dramatically cheaper (native non-native EC ops via MegaHonk/Goblin)
- Chonk proof verification is expensive, so we convert back to UltraHonk via the tube circuit
- Net result: 10 proofs verified much more cheaply than 10x700k constraints

## Build & Run

### Prerequisites

- `nargo` (Noir compiler) - matching Aztec version
- `aztec` CLI for contract compilation
- Node.js 18+

### Compile circuits (in order)

```bash
cd circuits/client && nargo compile
cd ../batch_verifier && nargo compile
cd ../tube && nargo compile
cd ../../contract && aztec compile
```

### Run the proof pipeline

```bash
cd scripts
yarn install
yarn prove
```

## Key Constants

| Proof Type | Proof Length (fields) | VK Length (fields) | Type ID |
|---|---|---|---|
| UltraHonk ZK | 500 | 115 | 6 |
| Chonk | 1632 | 127 | 9 |

## Notes

- The `CHONK_PROOF_LENGTH` (1632) in `tube/src/main.nr` may need adjustment if the actual proof output differs. Check the `chonkProofFields.length` output from the pipeline script.
- The VK hash for the Chonk proof in the tube circuit uses pedersen. The actual backend may hash differently - this may need investigation.
- The Aztec contract follows the exact pattern from the `recursive_verification` example in `aztec-examples`.
