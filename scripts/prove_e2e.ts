/**
 * Mini ZK-Rollup Proof Pipeline
 *
 * Two proving modes:
 *   ivc   – 4-circuit IVC chain proved with Chonk, then UltraHonk tube (default)
 *   direct – Direct recursive verification in a single UltraHonk circuit
 *
 * Usage: yarn prove [ivc|direct]
 *
 * Wrap with `/usr/bin/time -l` for accurate peak RSS and CPU usage —
 * Node.js process.memoryUsage() cannot see WASM memory.
 */

import { Noir } from '@aztec/noir-noir_js';
import {
  Barretenberg,
  UltraHonkBackend,
  AztecClientBackend,
  deflattenFields,
} from '@aztec/bb.js';
import { ungzip } from 'pako';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cpus, totalmem, platform, arch, hostname } from 'os';
import { Contract } from '@aztec/aztec.js/contracts';
import { loadContractArtifact } from '@aztec/aztec.js/abi';
import { createAztecNodeClient, waitForNode } from '@aztec/aztec.js/node';
import { NodeEmbeddedWallet } from '@aztec/wallets/embedded';
import {
  registerInitialLocalNetworkAccountsInWallet,
} from '@aztec/wallets/testing';

const __dirname = dirname(fileURLToPath(import.meta.url));

type Mode = 'ivc' | 'direct';

interface ProofResult {
  vkFields: string[];
  vkHash: string;
  proofFields: string[];
  publicInputs: string[];
}

const SANDBOX_URL = 'http://localhost:8080';

// ─── Helpers ───────────────────────────────────────────────────────────

function loadCircuit(dir: string, name: string) {
  const p = resolve(__dirname, `../circuits/${dir}/target/${name}.json`);
  return JSON.parse(readFileSync(p, 'utf-8'));
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

// ─── Telemetry ────────────────────────────────────────────────────────

interface PhaseEntry {
  phase: string;
  durationMs: number;
}

interface SystemInfo {
  platform: string;
  arch: string;
  hostname: string;
  cpuModel: string;
  cpuCores: number;
  totalMemMb: number;
  nodeVersion: string;
}

function getSystemInfo(): SystemInfo {
  const cpuList = cpus();
  return {
    platform: platform(),
    arch: arch(),
    hostname: hostname(),
    cpuModel: cpuList[0]?.model ?? 'unknown',
    cpuCores: cpuList.length,
    totalMemMb: Math.round(totalmem() / (1024 * 1024)),
    nodeVersion: process.version,
  };
}

const phases: PhaseEntry[] = [];

async function timed<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  const elapsed = performance.now() - t0;
  phases.push({ phase, durationMs: elapsed });
  console.log(`  [${fmtDur(elapsed)}] ${phase}`);
  return result;
}

function fmtB(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = ((ms % 60_000) / 1000).toFixed(1);
  return `${min}m ${sec}s`;
}

function printSummary(mode: Mode, sysInfo: SystemInfo) {
  const totalMs = phases.reduce((s, p) => s + p.durationMs, 0);

  const W = 64;
  const sep = '='.repeat(W);
  const dash = '-'.repeat(W - 4);

  console.log(`\n${sep}`);
  console.log(`  Benchmark Summary (${mode.toUpperCase()} mode)`);
  console.log(
    `  ${sysInfo.platform}/${sysInfo.arch} | ${sysInfo.cpuModel.trim()}` +
    ` (${sysInfo.cpuCores} cores) | ${fmtB(sysInfo.totalMemMb * 1024 * 1024)} RAM` +
    ` | ${sysInfo.nodeVersion}`,
  );
  console.log(sep);
  console.log(`  ${'Phase'.padEnd(40)} ${'Duration'.padStart(12)}`);
  console.log(`  ${dash}`);

  for (const p of phases) {
    console.log(
      `  ${p.phase.padEnd(40)} ${fmtDur(p.durationMs).padStart(12)}`,
    );
  }

  console.log(`  ${dash}`);
  console.log(`  ${'TOTAL'.padEnd(40)} ${fmtDur(totalMs).padStart(12)}`);
  console.log(sep);
  console.log(
    '\n  NOTE: Wrap with `/usr/bin/time -l` for accurate peak RSS and CPU.',
  );
  console.log('  Node.js cannot measure WASM memory.\n');
}

function writeJsonReport(mode: Mode, sysInfo: SystemInfo) {
  const totalMs = phases.reduce((s, p) => s + p.durationMs, 0);

  const report = {
    mode,
    timestamp: new Date().toISOString(),
    system: sysInfo,
    phases: phases.map(p => ({
      phase: p.phase,
      durationMs: Math.round(p.durationMs),
    })),
    totals: {
      wallMs: Math.round(totalMs),
    },
  };

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = resolve(__dirname, `bench-${mode}-${ts}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Benchmark results written to ${outPath}`);
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    console.log('Usage: yarn prove [ivc|direct]');
    console.log('  ivc    IVC/Chonk path (default)');
    console.log('  direct Direct recursive UltraHonk verification');
    process.exit(0);
  }

  const mode: Mode = arg === 'direct' ? 'direct' : 'ivc';
  const sysInfo = getSystemInfo();

  console.log(`=== Mini ZK-Rollup Proof Pipeline (${mode.toUpperCase()}) ===`);
  console.log(
    `  ${sysInfo.platform}/${sysInfo.arch} | ${sysInfo.cpuModel.trim()}` +
    ` (${sysInfo.cpuCores} cores) | ${fmtB(sysInfo.totalMemMb * 1024 * 1024)} RAM\n`,
  );

  // ─── Common: Initialize ──────────────────────────────────────────

  const api = await timed('Initialize Barretenberg', () =>
    Barretenberg.new({ threads: 4 }),
  );

  // ─── Common: Generate 10 client proofs ───────────────────────────

  console.log('\nGenerating 10 client proofs (UltraHonk ZK)...');
  const clientCircuit = loadCircuit('client', 'client_circuit');
  const clientNoir = new Noir(clientCircuit as any);
  const clientBackend = new UltraHonkBackend(clientCircuit.bytecode, api);

  const { vkAsFields, vkHash } = await timed(
    'Client VK generation',
    async () => {
      const a = await clientBackend.generateRecursiveProofArtifacts(
        new Uint8Array(0), 0, { verifierTarget: 'noir-recursive' },
      );
      console.log(
        `    VK: ${a.vkAsFields.length} fields, hash: ${a.vkHash.slice(0, 20)}...`,
      );
      return { vkAsFields: a.vkAsFields, vkHash: a.vkHash };
    },
  );

  const proofs: string[][] = [];
  const publicInputs: string[][] = [];

  await timed('Generate 10 client proofs', async () => {
    for (let i = 0; i < 10; i++) {
      const x = BigInt(i + 1);
      const xBytes = hexToBytes(x.toString(16));
      const yResult = await api.pedersenHash(
        { inputs: [xBytes], hashIndex: 0 },
      );
      const yHex = fieldToHex(yResult.hash);

      const { witness } = await clientNoir.execute({
        x: '0x' + x.toString(16),
        y: yHex,
      });

      const proofData = await clientBackend.generateProof(witness, {
        verifierTarget: 'noir-recursive',
      });

      proofs.push(
        deflattenFields(proofData.proof).map(f => f.toString()),
      );
      publicInputs.push(proofData.publicInputs);
      console.log(`    Proof ${i + 1}/10 done`);
    }
  });

  // ─── Common: Compute batch hash ─────────────────────────────────

  const batchHashHex = await timed('Compute batch hash', async () => {
    const inputs = publicInputs.map(pi => hexToBytes(pi[0]));
    const result = await api.pedersenHash({ inputs, hashIndex: 0 });
    const hex = fieldToHex(result.hash);
    console.log(`    Batch hash: ${hex.slice(0, 20)}...`);
    return hex;
  });

  // ─── Branch ──────────────────────────────────────────────────────

  let proofResult: ProofResult;
  if (mode === 'ivc') {
    proofResult = await runIvcPath(
      api, vkAsFields, vkHash, proofs, publicInputs, batchHashHex,
    );
  } else {
    proofResult = await runDirectPath(
      api, vkAsFields, vkHash, proofs, publicInputs, batchHashHex,
    );
  }

  // ─── Contract Interaction ───────────────────────────────────────

  await deployAndVerifyOnChain(proofResult);

  // ─── Summary ─────────────────────────────────────────────────────

  printSummary(mode, sysInfo);
  writeJsonReport(mode, sysInfo);

  await api.destroy();
  process.exit(0);
}

// ─── IVC Path ──────────────────────────────────────────────────────────

async function runIvcPath(
  api: Barretenberg,
  vkAsFields: string[],
  vkHash: string,
  proofs: string[][],
  publicInputs: string[][],
  batchHashHex: string,
): Promise<ProofResult> {
  console.log('\n--- IVC Path ---\n');

  const batchAppCircuit = loadCircuit('batch_app', 'batch_app');
  const initKernelCircuit = loadCircuit('init_kernel', 'init_kernel');
  const tailKernelCircuit = loadCircuit('tail_kernel', 'tail_kernel');
  const hidingKernelCircuit = loadCircuit('hiding_kernel', 'hiding_kernel');
  const tubeCircuit = loadCircuit('tube', 'tube_circuit');

  async function loadVkAsFields(circuitName: string) {
    const vkPath = resolve(
      __dirname, `../circuits/${circuitName}/target/vk`,
    );
    const vkBytes = readFileSync(vkPath);
    const fields: string[] = [];
    for (let i = 0; i < vkBytes.length; i += 32) {
      fields.push(fieldToHex(new Uint8Array(vkBytes.slice(i, i + 32))));
    }
    const fieldBytes = fields.map(f => hexToBytes(f));
    const hashResult = await api.poseidon2Hash({ inputs: fieldBytes });
    return { key: fields, hash: fieldToHex(hashResult.hash) };
  }

  const witnesses = await timed('IVC witness generation', async () => {
    const batchAppVk = await loadVkAsFields('batch_app');
    const initKernelVk = await loadVkAsFields('init_kernel');
    const tailKernelVk = await loadVkAsFields('tail_kernel');

    const batchAppNoir = new Noir(batchAppCircuit as any);
    const { witness: appW, returnValue: appRV } =
      await batchAppNoir.execute({
        verification_key: vkAsFields,
        key_hash: vkHash,
        proofs,
        public_inputs: publicInputs.map(pi => [pi[0]]),
        batch_hash: batchHashHex,
      });
    console.log('    batch_app witness done');

    const initNoir = new Noir(initKernelCircuit as any);
    const { witness: initW } = await initNoir.execute({
      app_inputs: appRV,
      app_vk: batchAppVk,
    });
    console.log('    init_kernel witness done');

    const tailNoir = new Noir(tailKernelCircuit as any);
    const { witness: tailW } = await tailNoir.execute({
      prev_kernel_inputs: appRV,
      kernel_vk: initKernelVk,
    });
    console.log('    tail_kernel witness done');

    const hidingNoir = new Noir(hidingKernelCircuit as any);
    const { witness: hidingW } = await hidingNoir.execute({
      prev_kernel_inputs: appRV,
      kernel_vk: tailKernelVk,
    });
    console.log('    hiding_kernel witness done');

    return { app: appW, init: initW, tail: tailW, hiding: hidingW };
  });

  const { chonkProofFields, chonkVk } = await timed(
    'Chonk proving',
    async () => {
      const bytecodes = [
        batchAppCircuit,
        initKernelCircuit,
        tailKernelCircuit,
        hidingKernelCircuit,
      ].map(c => ungzip(Buffer.from(c.bytecode, 'base64')));

      const witArr = [
        witnesses.app, witnesses.init, witnesses.tail, witnesses.hiding,
      ].map(w => ungzip(w));

      const circuitNames = [
        'batch_app', 'init_kernel', 'tail_kernel', 'hiding_kernel',
      ];
      const vks = circuitNames.map(name => {
        const vkPath = resolve(
          __dirname, `../circuits/${name}/target/vk`,
        );
        return new Uint8Array(readFileSync(vkPath));
      });

      const chonkApi = await Barretenberg.new({ threads: 4 });
      const backend = new AztecClientBackend(
        bytecodes, chonkApi, circuitNames,
      );
      const [proofFields, proof, vk] = await backend.prove(witArr, vks);

      const valid = await backend.verify(proof, vk);
      console.log(
        `    Chonk proof: ${proofFields.length} fields, ` +
        `VK: ${vk.length} bytes`,
      );
      console.log(
        `    Chonk verification: ${valid ? 'PASS' : 'FAIL'}`,
      );

      await chonkApi.destroy();
      return { chonkProofFields: proofFields, chonkVk: vk };
    },
  );

  const chonkProofHex = chonkProofFields.map(f => fieldToHex(f));
  const chonkUserPub = chonkProofHex.slice(0, 1);
  const chonkProofBody = chonkProofHex.slice(1);

  const chonkVkFields: string[] = [];
  for (let i = 0; i < chonkVk.length; i += 32) {
    chonkVkFields.push(fieldToHex(chonkVk.slice(i, i + 32)));
  }
  const vkFieldBytes = chonkVkFields.map(f => hexToBytes(f));
  const keyHashResult = await api.poseidon2Hash({ inputs: vkFieldBytes });
  const keyHashHex = fieldToHex(keyHashResult.hash);

  const tubeNoir = new Noir(tubeCircuit as any);
  const { witness: tubeWitness } = await tubeNoir.execute({
    verification_key: chonkVkFields,
    proof: chonkProofBody,
    chonk_public_inputs: chonkUserPub,
    key_hash: keyHashHex,
    batch_hash: batchHashHex,
  });

  const tubeBackend = new UltraHonkBackend(tubeCircuit.bytecode, api);

  const { proofFields, publicInputsOut } = await timed(
    'Tube proving',
    async () => {
      const tubeProof = await tubeBackend.generateProof(tubeWitness, {
        verifierTarget: 'noir-rollup',
      });

      const valid = await tubeBackend.verifyProof(tubeProof, {
        verifierTarget: 'noir-rollup',
      });
      console.log(
        `    Tube proof: ${deflattenFields(tubeProof.proof).length} fields`,
      );
      console.log(
        `    Tube verification: ${valid ? 'PASS' : 'FAIL'}`,
      );

      return {
        proofFields: deflattenFields(tubeProof.proof).map(
          f => f.toString(),
        ),
        publicInputsOut: tubeProof.publicInputs,
      };
    },
  );

  return await timed('Generate tube VK artifacts', async () => {
    const vkArt = await tubeBackend.generateRecursiveProofArtifacts(
      new Uint8Array(0), 0, { verifierTarget: 'noir-rollup' },
    );
    console.log(`    Tube VK hash (contract arg): ${vkArt.vkHash}`);
    return {
      vkFields: vkArt.vkAsFields,
      vkHash: vkArt.vkHash,
      proofFields,
      publicInputs: publicInputsOut,
    };
  });
}

// ─── Direct Path ───────────────────────────────────────────────────────

async function runDirectPath(
  api: Barretenberg,
  vkAsFields: string[],
  vkHash: string,
  proofs: string[][],
  publicInputs: string[][],
  batchHashHex: string,
): Promise<ProofResult> {
  console.log('\n--- Direct Path (Recursive UltraHonk Verification) ---');
  console.log('  Verifies 10 proofs directly in a single UltraHonk circuit.\n');

  const circuit = loadCircuit('direct_verifier', 'direct_verifier');

  const batchWitness = await timed(
    'Direct verifier execution',
    async () => {
      const noir = new Noir(circuit as any);
      const { witness } = await noir.execute({
        verification_key: vkAsFields,
        key_hash: vkHash,
        proofs,
        public_inputs: publicInputs.map(pi => [pi[0]]),
        batch_hash: batchHashHex,
      });
      return witness;
    },
  );

  const backend = new UltraHonkBackend(circuit.bytecode, api);

  const { proofFields, publicInputsOut } = await timed(
    'Direct verifier proving (UltraHonk)',
    async () => {
      const proof = await backend.generateProof(batchWitness, {
        verifierTarget: 'noir-recursive',
      });

      const fields = deflattenFields(proof.proof);
      console.log(`    Proof: ${fields.length} fields`);
      console.log(`    Public inputs: ${proof.publicInputs}`);

      const valid = await backend.verifyProof(proof, {
        verifierTarget: 'noir-recursive',
      });
      console.log(`    Verification: ${valid ? 'PASS' : 'FAIL'}`);

      return {
        proofFields: fields.map(f => f.toString()),
        publicInputsOut: proof.publicInputs,
      };
    },
  );

  return await timed('Generate VK artifacts', async () => {
    const vkArt = await backend.generateRecursiveProofArtifacts(
      new Uint8Array(0), 0, { verifierTarget: 'noir-recursive' },
    );
    console.log(`    VK hash (contract arg): ${vkArt.vkHash}`);
    return {
      vkFields: vkArt.vkAsFields,
      vkHash: vkArt.vkHash,
      proofFields,
      publicInputs: publicInputsOut,
    };
  });
}

// ─── Contract Interaction ──────────────────────────────────────────────

async function deployAndVerifyOnChain(proof: ProofResult) {
  console.log('\n--- On-Chain Verification ---\n');

  const { wallet, account } = await timed(
    'Connect to sandbox',
    async () => {
      const node = createAztecNodeClient(SANDBOX_URL);
      await waitForNode(node);
      const w = await NodeEmbeddedWallet.create(SANDBOX_URL);
      const accounts =
        await registerInitialLocalNetworkAccountsInWallet(w);
      const addr = accounts[0];
      console.log(`    Connected to ${SANDBOX_URL}`);
      console.log(`    Account: ${addr}`);
      return { wallet: w, account: addr };
    },
  );

  const contractArtifactPath = resolve(
    __dirname, '../contract/target/MiniRollup-MiniRollup.json',
  );
  const artifact = loadContractArtifact(
    JSON.parse(readFileSync(contractArtifactPath, 'utf-8')),
  );

  const contract = await timed(
    'Deploy MiniRollup contract',
    async () => {
      const deployer = Contract.deploy(
        wallet as any, artifact, [proof.vkHash],
      );
      await deployer.simulate({ from: account });
      await deployer.send({
        from: account,
        wait: { timeout: 120 },
      });
      const addr = deployer.address!;
      console.log(`    Deployed at: ${addr}`);
      return await Contract.at(addr, artifact, wallet as any);
    },
  );

  await timed('Call verify_batch', async () => {
    const tx = contract.methods.verify_batch(
      proof.vkFields,
      proof.proofFields,
      proof.publicInputs,
    );
    await tx.simulate({ from: account });
    const receipt = await tx.send({
      from: account,
      wait: { timeout: 120 },
    });
    console.log(`    TX hash: ${receipt.txHash}`);
    console.log(`    Status: ${receipt.status}`);
  });

  await timed('Sanity check: invalid proof rejection', async () => {
    const corrupted = [...proof.proofFields];
    const indices = [
      0,
      Math.floor(corrupted.length / 2),
      corrupted.length - 1,
    ];
    for (const idx of indices) {
      corrupted[idx] = '0xff' + corrupted[idx].slice(4);
    }

    const tx = contract.methods.verify_batch(
      proof.vkFields, corrupted, proof.publicInputs,
    );

    let simPassed = false;
    try {
      await tx.simulate({ from: account });
      simPassed = true;
      console.log(
        '    Simulate with corrupted proof: passed' +
        ' (expected -- PXE does not run verifier)',
      );
    } catch {
      console.log('    Simulate with corrupted proof: rejected');
    }

    if (simPassed) {
      try {
        const receipt = await tx.send({
          from: account, wait: { timeout: 120 },
        });
        console.log(
          `    WARNING: corrupted proof ACCEPTED on-chain` +
          ` (status: ${receipt.status})`,
        );
        console.log(
          '    This suggests verify_honk_proof may not be executing.',
        );
      } catch {
        console.log('    Corrupted proof rejected on-chain: PASS');
      }
    } else {
      console.log('    Corrupted proof rejected at simulation: PASS');
    }
  });
}

// ─── Entry ─────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
