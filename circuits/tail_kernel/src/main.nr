use ivc_types::{BatchOutput, PROOF_TYPE_HN_TAIL, VerificationKey};

/// Tail kernel: verifies the init kernel's HN proof and passes batch_hash through.
fn main(
    prev_kernel_inputs: call_data(0) BatchOutput,
    kernel_vk: VerificationKey,
) -> return_data BatchOutput {
    std::verify_proof_with_type(kernel_vk.key, [], [], kernel_vk.hash, PROOF_TYPE_HN_TAIL);

    prev_kernel_inputs
}
