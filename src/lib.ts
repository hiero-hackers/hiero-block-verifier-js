// SPDX-License-Identifier: Apache-2.0
// Public library entry point — `import { verifyBlock } from "hiero-block-verifier-js"`.
// The CLI (src/index.ts) is separate; importing this module runs nothing.
import { parseBlock } from "./parseBlock.js";
import { computeBlockRoot } from "./computeBlockRoot.js";
import { extractBootstrapPublication } from "./extractBootstrap.js";
import { attemptNobleVerification } from "./attemptNobleVerify.js";
import { assessSnarkjsTractability, attemptWrapsDeserialization } from "./assessWrapsSnarkjs.js";
import { verifySchnorrSignature } from "./verifySchnorr.js";
import { verifyWrapsProof } from "./verifyWrapsProof.js";
import { verifyHintsSignature } from "./verifyHints.js";
import { buildVerificationReport } from "./report.js";
import type { BootstrapPublicationSummary, VerificationReport } from "./types.js";

export { parseBlock, parseBlockFixture } from "./parseBlock.js";
export { buildVerificationReport, formatVerificationReports } from "./report.js";
export type { ParsedBlockFixture, VerificationReport } from "./types.js";

/**
 * Verify a Hedera block proof (HIP-1056 / HIP-1200) from in-memory bytes.
 *
 * @param blockBytes      the block file — gzip/zstd-compressed or raw.
 * @param bootstrapBytes  the genesis block, required for non-genesis blocks
 *                        (genesis carries its own ledger-ID publication).
 * @returns the full {@link VerificationReport}, including a top-level `valid`.
 */
export async function verifyBlock(
  blockBytes: Buffer,
  bootstrapBytes?: Buffer,
): Promise<VerificationReport> {
  let bootstrap: BootstrapPublicationSummary | null = null;
  if (bootstrapBytes) {
    bootstrap = (await extractBootstrapPublication(await parseBlock(bootstrapBytes))) ?? null;
  }

  const parsedBlock = await parseBlock(blockBytes);
  const blockRoot = await computeBlockRoot(parsedBlock);
  const bootstrapPublication = (await extractBootstrapPublication(parsedBlock)) ?? bootstrap;

  return buildVerificationReport({
    parsedBlock,
    blockRoot,
    bootstrapPublication,
    nobleAttempt: attemptNobleVerification(parsedBlock.proofLayout),
    snarkjsAssessment: assessSnarkjsTractability(parsedBlock.proofLayout),
    wrapsDeserialization: attemptWrapsDeserialization(parsedBlock.proofLayout, bootstrapPublication),
    schnorrVerification: verifySchnorrSignature(parsedBlock.proofLayout, bootstrapPublication),
    wrapsVerification: verifyWrapsProof(parsedBlock.proofLayout, bootstrapPublication),
    hintsVerification: verifyHintsSignature(parsedBlock.proofLayout, bootstrapPublication, blockRoot),
  });
}
