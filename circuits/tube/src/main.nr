use ivc_types::{CHONK_PROOF_LENGTH, MEGA_VK_LENGTH_IN_FIELDS, PROOF_TYPE_CHONK};

/// Tube circuit: verifies a Chonk proof and re-exposes batch_hash as a public output.
/// This produces an UltraHonk proof that can be verified by an Aztec contract.
fn main(
    verification_key: [Field; MEGA_VK_LENGTH_IN_FIELDS],
    proof: [Field; CHONK_PROOF_LENGTH],
    chonk_public_inputs: [Field; 1],
    key_hash: Field,
    batch_hash: pub Field,
) {
    std::verify_proof_with_type(
        verification_key, proof, chonk_public_inputs, key_hash, PROOF_TYPE_CHONK,
    );
    assert(batch_hash == chonk_public_inputs[0]);
}
