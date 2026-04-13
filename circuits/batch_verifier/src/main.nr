use bb_proof_verification::{
    UltraHonkVerificationKey, UltraHonkZKProof, verify_honk_proof,
};
use std::hash::pedersen_hash;

/// Naive batch verifier: verifies 10 UltraHonk ZK proofs directly in a single
/// UltraHonk circuit. Outputs batch_hash as a public output.
///
/// This is the simple/naive approach -- contrast with the IVC path (batch_app +
/// kernel chain + tube) which uses Chonk for cheaper recursive verification.
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
