pub global MEGA_VK_LENGTH_IN_FIELDS: u32 = 127;

pub global PROOF_TYPE_OINK: u32 = 1;
pub global PROOF_TYPE_HN_TAIL: u32 = 8;
pub global PROOF_TYPE_HN_FINAL: u32 = 7;
pub global PROOF_TYPE_CHONK: u32 = 9;
pub global CHONK_PROOF_LENGTH: u32 = 1935;

pub struct VerificationKey {
    pub key: [Field; MEGA_VK_LENGTH_IN_FIELDS],
    pub hash: Field,
}

/// Data passed through the IVC kernel chain
pub struct BatchOutput {
    pub batch_hash: Field,
}

impl BatchOutput {
    pub fn serialize(self) -> [Field; 1] {
        [self.batch_hash]
    }
}
