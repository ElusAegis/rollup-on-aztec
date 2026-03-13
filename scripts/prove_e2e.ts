/**
 * Mini ZK-Rollup Proof Pipeline (IVC Chain)
 *
 * 4-circuit IVC chain proved with Chonk, then verified in UltraHonk tube:
 * 1. batch_app: verifies 10 UltraHonk client proofs (app circuit)
 * 2. init_kernel: OINK verification (IVC kernel)
 * 3. tail_kernel: HN_TAIL verification (IVC kernel)
 * 4. hiding_kernel: HN_FINAL verification (IVC kernel)
 * 5. tube: verifies Chonk proof → UltraHonk (for Aztec contract)
 *
 * Usage: cd scripts && yarn install && yarn prove
 */

import { Noir } from '@aztec/noir-noir_js';
import {
  Barretenberg,
  UltraHonkBackend,
  AztecClientBackend,
  deflattenFields,
} from '@aztec/bb.js';
import { ungzip } from 'pako';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Helpers ───────────────────────────────────────────────────────────

function loadCircuit(dir: string, name: string) {
  const circuitPath = resolve(__dirname, `../circuits/${dir}/target/${name}.json`);
  return JSON.parse(readFileSync(circuitPath, 'utf-8'));
}

function fieldToHex(field: Uint8Array): string {
  return '0x' + Buffer.from(field).toString('hex').padStart(64, '0');
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = cleaned.padStart(64, '0');
  const bytes = new Uint8Array(32);
  for (let j = 0; j < 32; j++) {
    bytes[j] = parseInt(padded.slice(j * 2, j * 2 + 2), 16);
  }
  return bytes;
}

// ─── Main Pipeline ─────────────────────────────────────────────────────

async function main() {
  console.log('=== Mini ZK-Rollup Proof Pipeline (IVC Chain) ===\n');

  // Initialize Barretenberg
  console.log('[1/6] Initializing Barretenberg...');
  const api = await Barretenberg.new({ threads: 4 });

  // Load compiled circuits
  console.log('[2/6] Loading compiled circuits...');
  const clientCircuit = loadCircuit('client', 'client_circuit');
  const batchAppCircuit = loadCircuit('batch_app', 'batch_app');
  const initKernelCircuit = loadCircuit('init_kernel', 'init_kernel');
  const tailKernelCircuit = loadCircuit('tail_kernel', 'tail_kernel');
  const hidingKernelCircuit = loadCircuit('hiding_kernel', 'hiding_kernel');
  const tubeCircuit = loadCircuit('tube', 'tube_circuit');

  // ─── Step 1: Generate 10 client proofs (UltraHonk ZK) ─────────────

  console.log('\n[3/6] Generating 10 client proofs (UltraHonk ZK)...');

  const clientNoir = new Noir(clientCircuit as any);
  const clientBackend = new UltraHonkBackend(clientCircuit.bytecode, api);

  // Generate VK and VK hash once (same circuit for all proofs)
  const vkArtifacts = await clientBackend.generateRecursiveProofArtifacts(
    new Uint8Array(0), 0, { verifierTarget: 'noir-recursive' }
  );
  const vkAsFields = vkArtifacts.vkAsFields;
  const vkHash = vkArtifacts.vkHash;

  console.log(`  VK size: ${vkAsFields.length} fields`);
  console.log(`  VK hash: ${vkHash}`);

  const proofs: string[][] = [];
  const publicInputs: string[][] = [];

  for (let i = 0; i < 10; i++) {
    const x = BigInt(i + 1);

    // Compute y = pedersen_hash([x])
    const xBytes = hexToBytes(x.toString(16));
    const yResult = await api.pedersenHash({ inputs: [xBytes], hashIndex: 0 });
    const yHex = fieldToHex(yResult.hash);

    // Execute and prove
    const { witness } = await clientNoir.execute({
      x: '0x' + x.toString(16),
      y: yHex,
    });

    const proofData = await clientBackend.generateProof(witness, {
      verifierTarget: 'noir-recursive',
    });

    const proofFields = deflattenFields(proofData.proof).map(f => f.toString());
    proofs.push(proofFields);
    publicInputs.push(proofData.publicInputs);

    console.log(`  Proof ${i + 1}/10: ${proofFields.length} fields`);
  }

  console.log(`  All 10 client proofs generated.`);

  // ─── Step 2: Compute batch hash ────────────────────────────────────

  console.log('\n[4/6] Preparing IVC chain...');

  const yValues = publicInputs.map(pi => pi[0]);
  const pedersenInputs = yValues.map(y => hexToBytes(y));
  const batchHashResult = await api.pedersenHash({ inputs: pedersenInputs, hashIndex: 0 });
  const batchHashHex = fieldToHex(batchHashResult.hash);
  console.log(`  Batch hash: ${batchHashHex.slice(0, 20)}...`);

  // ─── Step 3: Execute IVC chain witness generation ──────────────────

  // Helper: load a precomputed VK file and convert to { key: string[], hash: string }
  async function loadVkAsFields(circuitName: string): Promise<{ key: string[]; hash: string }> {
    const vkPath = resolve(__dirname, `../circuits/${circuitName}/target/vk`);
    const vkBytes = readFileSync(vkPath);
    const fields: string[] = [];
    for (let i = 0; i < vkBytes.length; i += 32) {
      const chunk = vkBytes.slice(i, i + 32);
      fields.push(fieldToHex(new Uint8Array(chunk)));
    }
    // Compute VK hash = poseidon2_hash(fields) — matches barretenberg flavor hash
    const fieldBytes = fields.map(f => hexToBytes(f));
    const hashResult = await api.poseidon2Hash({ inputs: fieldBytes });
    const hash = fieldToHex(hashResult.hash);
    console.log(`  Loaded VK for ${circuitName}: ${fields.length} fields, hash=${hash.slice(0, 20)}...`);
    return { key: fields, hash };
  }

  // Load real VKs for kernel witness generation
  console.log('  Loading precomputed VKs for witness generation...');
  const batchAppVk = await loadVkAsFields('batch_app');
  const initKernelVk = await loadVkAsFields('init_kernel');
  const tailKernelVk = await loadVkAsFields('tail_kernel');

  // Execute batch_app (app circuit)
  console.log('  Executing batch_app circuit...');
  const batchAppNoir = new Noir(batchAppCircuit as any);
  const { witness: appWitness, returnValue: appReturnValue } = await batchAppNoir.execute({
    verification_key: vkAsFields,
    key_hash: vkHash,
    proofs: proofs,
    public_inputs: publicInputs.map(pi => [pi[0]]),
    batch_hash: batchHashHex,
  });
  console.log(`  batch_app witness generated. Return value:`, appReturnValue);

  // Execute init_kernel (verifies batch_app's OINK proof)
  console.log('  Executing init_kernel circuit...');
  const initKernelNoir = new Noir(initKernelCircuit as any);
  const { witness: initWitness } = await initKernelNoir.execute({
    app_inputs: appReturnValue,
    app_vk: batchAppVk,
  });
  console.log(`  init_kernel witness generated.`);

  // Execute tail_kernel (verifies init_kernel's HN_TAIL proof)
  console.log('  Executing tail_kernel circuit...');
  const tailKernelNoir = new Noir(tailKernelCircuit as any);
  const { witness: tailWitness } = await tailKernelNoir.execute({
    prev_kernel_inputs: appReturnValue,
    kernel_vk: initKernelVk,
  });
  console.log(`  tail_kernel witness generated.`);

  // Execute hiding_kernel (verifies tail_kernel's HN_FINAL proof)
  console.log('  Executing hiding_kernel circuit...');
  const hidingKernelNoir = new Noir(hidingKernelCircuit as any);
  const { witness: hidingWitness } = await hidingKernelNoir.execute({
    prev_kernel_inputs: appReturnValue,
    kernel_vk: tailKernelVk,
  });
  console.log(`  hiding_kernel witness generated.`);

  // ─── Step 4: Prove IVC chain with Chonk ────────────────────────────

  console.log('\n[5/6] Proving IVC chain with Chonk...');

  // Decompress bytecodes
  const bytecodes = [
    batchAppCircuit, initKernelCircuit, tailKernelCircuit, hidingKernelCircuit,
  ].map(c => ungzip(Buffer.from(c.bytecode, 'base64')));

  // Decompress witnesses
  const witnesses = [appWitness, initWitness, tailWitness, hidingWitness].map(w => ungzip(w));

  // Load VKs pre-computed by `bb write_vk --scheme chonk`
  // These VKs are IVC-aware (include AppIO/KernelIO public inputs)
  console.log('  Loading pre-computed VKs...');
  const circuitNames = ['batch_app', 'init_kernel', 'tail_kernel', 'hiding_kernel'];
  const vks: Uint8Array[] = circuitNames.map(name => {
    const vkPath = resolve(__dirname, `../circuits/${name}/target/vk`);
    const vkData = readFileSync(vkPath);
    console.log(`  VK ${name}: ${vkData.length} bytes`);
    return new Uint8Array(vkData);
  });

  // Prove with Chonk
  console.log('  Proving with Chonk (this may take a while)...');
  const chonkApi = await Barretenberg.new({ threads: 4 });
  const chonkBackend = new AztecClientBackend(bytecodes, chonkApi, circuitNames);
  const [chonkProofFields, chonkProof, chonkVk] = await chonkBackend.prove(witnesses, vks);

  console.log(`  Chonk proof: ${chonkProofFields.length} fields`);
  console.log(`  Chonk VK: ${chonkVk.length} bytes`);

  // Verify the Chonk proof
  const chonkValid = await chonkBackend.verify(chonkProof, chonkVk);
  console.log(`  Chonk verification: ${chonkValid ? 'PASS' : 'FAIL'}`);

  // ─── Step 5: Tube circuit (Chonk -> UltraHonk) ────────────────────

  console.log('\n[6/6] Converting Chonk proof to UltraHonk via tube circuit...');

  // Convert chonk proof fields to hex strings
  const chonkProofAsFields = chonkProofFields.map(f => fieldToHex(f));
  console.log(`  Chonk proof total fields: ${chonkProofAsFields.length}`);

  // Split proof: first field is user public input (batch_hash), rest is proof
  const chonkUserPubInputs = chonkProofAsFields.slice(0, 1);
  const chonkProofForTube = chonkProofAsFields.slice(1);
  console.log(`  Chonk user public inputs: ${chonkUserPubInputs.length}, proof: ${chonkProofForTube.length}`);

  // Convert chonk VK bytes to field array
  const chonkVkFields: string[] = [];
  for (let i = 0; i < chonkVk.length; i += 32) {
    const chunk = chonkVk.slice(i, i + 32);
    chonkVkFields.push(fieldToHex(chunk));
  }
  console.log(`  Chonk VK as fields: ${chonkVkFields.length}`);

  // Compute chonk VK hash using poseidon2 (matches barretenberg flavor hash)
  const chonkVkFieldBytes = chonkVkFields.map(f => hexToBytes(f));
  const chonkKeyHashResult = await api.poseidon2Hash({ inputs: chonkVkFieldBytes });
  const chonkKeyHashHex = fieldToHex(chonkKeyHashResult.hash);

  // Prepare tube circuit inputs
  const tubeInputs = {
    verification_key: chonkVkFields,
    proof: chonkProofForTube,
    chonk_public_inputs: chonkUserPubInputs,
    key_hash: chonkKeyHashHex,
    batch_hash: batchHashHex,
  };

  // Execute tube circuit
  console.log('  Executing tube circuit...');
  const tubeNoir = new Noir(tubeCircuit as any);
  const { witness: tubeWitness } = await tubeNoir.execute(tubeInputs);

  // Prove with UltraHonk ZK (rollup target for IPA accumulation from Chonk verifier)
  console.log('  Proving tube with UltraHonk ZK...');
  const tubeBackend = new UltraHonkBackend(tubeCircuit.bytecode, api);
  const tubeProofData = await tubeBackend.generateProof(tubeWitness, {
    verifierTarget: 'noir-rollup',
  });

  console.log(`  Tube proof: ${deflattenFields(tubeProofData.proof).length} fields`);
  console.log(`  Tube public inputs: ${tubeProofData.publicInputs}`);

  // Verify tube proof
  const tubeValid = await tubeBackend.verifyProof(tubeProofData, {
    verifierTarget: 'noir-rollup',
  });
  console.log(`  Tube verification: ${tubeValid ? 'PASS' : 'FAIL'}`);

  // Get tube VK for the Aztec contract
  const tubeVkArtifacts = await tubeBackend.generateRecursiveProofArtifacts(
    new Uint8Array(0), 0, { verifierTarget: 'noir-rollup' }
  );
  console.log(`  Tube VK hash (for Aztec contract constructor): ${tubeVkArtifacts.vkHash}`);

  // ─── Summary ──────────────────────────────────────────────────────

  console.log('\n=== Pipeline Complete ===');
  console.log(`  10 client proofs -> Chonk IVC (4 circuits) -> UltraHonk tube proof`);
  console.log(`  Tube proof can be verified by MiniRollup Aztec contract`);
  console.log(`  Contract constructor arg (vk_hash): ${tubeVkArtifacts.vkHash}`);

  // Cleanup
  await api.destroy();
  await chonkApi.destroy();
  console.log('\nDone!');
  process.exit(0);
}

main().catch(err => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
