use ivc_types::{BatchOutput, PROOF_TYPE_OINK, VerificationKey};

/// Init kernel: verifies the app circuit's OINK proof and passes batch_hash through.
fn main(
    app_inputs: call_data(1) BatchOutput,
    app_vk: VerificationKey,
) -> return_data BatchOutput {
    std::verify_proof_with_type(app_vk.key, [], [], app_vk.hash, PROOF_TYPE_OINK);

    app_inputs
}
