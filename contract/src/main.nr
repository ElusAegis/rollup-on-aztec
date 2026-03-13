use aztec::macros::aztec;

#[aztec]
pub contract MiniRollup {
    use aztec::{
        macros::{functions::{external, initializer, view}, storage::storage},
        state_vars::PublicImmutable,
    };
    use bb_proof_verification::{UltraHonkVerificationKey, UltraHonkZKProof, verify_honk_proof};

    #[storage]
    struct Storage<Context> {
        vk_hash: PublicImmutable<Field, Context>,
    }

    #[initializer]
    #[external("public")]
    fn constructor(vk_hash: Field) {
        self.storage.vk_hash.initialize(vk_hash);
    }

    /// Verifies a batch proof from the mini-rollup tube circuit.
    /// The proof attests that 10 client preimage proofs were valid.
    /// public_inputs[0] = batch_hash (poseidon2 hash of all 10 y-values)
    #[external("private")]
    fn verify_batch(
        verification_key: UltraHonkVerificationKey,
        proof: UltraHonkZKProof,
        public_inputs: [Field; 1],
    ) {
        let vk_hash = self.storage.vk_hash.read();
        verify_honk_proof(verification_key, proof, public_inputs, vk_hash);
    }

    #[view]
    #[external("public")]
    fn get_vk_hash() -> Field {
        self.storage.vk_hash.read()
    }
}
