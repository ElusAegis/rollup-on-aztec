use ivc_types::{BatchOutput, PROOF_TYPE_HN_FINAL, VerificationKey};

/// Hiding kernel: final circuit in IVC chain. Verifies the tail kernel's HN_FINAL proof.
/// Outputs batch_hash as a public output (included in the Chonk proof's custom public inputs).
fn main(
    prev_kernel_inputs: call_data(0) BatchOutput,
    kernel_vk: VerificationKey,
) -> pub BatchOutput {
    std::verify_proof_with_type(kernel_vk.key, [], [], kernel_vk.hash, PROOF_TYPE_HN_FINAL);

    prev_kernel_inputs
}
