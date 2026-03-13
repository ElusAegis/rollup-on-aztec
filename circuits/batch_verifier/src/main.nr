use bb_proof_verification::{
    UltraHonkVerificationKey, UltraHonkZKProof, verify_honk_proof,
};
use std::hash::pedersen_hash;

/// Batch verifier circuit: verifies 10 UltraHonk ZK proofs from the client circuit
/// and outputs a hash of all verified public inputs.
///
/// This circuit is intended to be proved with Chonk (via AztecClientBackend),
/// which makes the recursive UltraHonk verification dramatically cheaper
/// due to native non-native EC group operations in MegaHonk.
fn main(
    // All 10 proofs use the same VK (same circuit), so we only need one copy
    verification_key: UltraHonkVerificationKey,
    key_hash: Field,
    proofs: [UltraHonkZKProof; 10],
    public_inputs: [[Field; 1]; 10],
    // Public output: hash of all 10 y-values
    batch_hash: pub Field,
) {
    // Verify each client proof
    for i in 0..10 {
        verify_honk_proof(verification_key, proofs[i], public_inputs[i], key_hash);
    }

    // Compute batch hash from all public inputs
    let mut y_values: [Field; 10] = [0; 10];
    for i in 0..10 {
        y_values[i] = public_inputs[i][0];
    }
    let computed_hash = pedersen_hash(y_values);
    assert(batch_hash == computed_hash);
}
