use bb_proof_verification::{UltraHonkVerificationKey, UltraHonkZKProof, verify_honk_proof};
use std::hash::pedersen_hash;
use ivc_types::BatchOutput;

/// App circuit: verifies 10 UltraHonk ZK proofs and outputs a hash of all verified public inputs.
/// This is the first circuit in the IVC chain, proved with Chonk via AztecClientBackend.
fn main(
    verification_key: UltraHonkVerificationKey,
    key_hash: Field,
    proofs: [UltraHonkZKProof; 10],
    public_inputs: [[Field; 1]; 10],
    batch_hash: Field,
) -> return_data BatchOutput {
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

    BatchOutput { batch_hash }
}
