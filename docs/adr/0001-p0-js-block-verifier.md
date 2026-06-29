# ADR 0001: Pure-JS Block Verification Library (P0)

- Status: Proposed
- Date: 2026-04-14
- Relates to: hiero-block-node issue #2323, spike PR #2411
- Deciders: block-node maintainers (sign-off pending)

## Context

HIP-1056 blocks are currently verifiable only via the Java block-node
implementation, which delegates BLS/WRAPS/hinTS verification to native Rust
crypto through `TSS.verifyTSS(...)`. Web3/JS developers have no first-party
path to verify blocks in browsers or Node runtimes, which undermines the
"everyone can verify a block" promise of the block-stream architecture.

A spike in `tools/js-tss-verifier/` has demonstrated that all three proof
paths — Schnorr (genesis), WRAPS (settled, Groth16+KZG on BN254), and hinTS
(BLS12-381, 10/10 pairing & identity checks) — are tractable in pure JS
using `@noble/curves`. See PR #2411.

This ADR defines the shape of the productized library that delivers P0 of
issue #2323: **block verification without TSS (hash-only) and block
verification with TSS (Schnorr / WRAPS / hinTS).**

## What the spike taught us

The decisions below are grounded in concrete findings from the spike in
`tools/js-tss-verifier/` (PR #2411). The most load-bearing learnings:

### Tractability
- **All three proof paths verify in pure JS** on real fixtures: Schnorr
  (genesis), WRAPS (Groth16+KZG on BN254), hinTS (BLS12-381, 10/10
  pairing & identity checks).
- `@noble/curves` is sufficient for both BN254 and BLS12-381 — no WASM
  or native crypto required for correctness. Perf is acceptable for
  per-block verification (order of seconds in Node).
- `snarkjs` is **not usable** for WRAPS: the 704-byte compressed proof
  is a Nova/IVC `ProofData` bundle, not plain Groth16, and packing is
  Hedera-specific. We implement Groth16+KZG verification directly.

### Block parsing
- Decode-and-reencode of `BlockUnparsed` is a trap: canonical encoding
  drift breaks Merkle root reproduction. Shallow parsing (scan wire
  bytes, preserve each `BlockItemUnparsed` as-is, deep-decode only
  control-plane messages) matches the Java block-node approach and is
  the only reliable path. This is why shallow parsing is a
  non-negotiable in this ADR.
- The generated proto bundle in `protobuf-sources/block-node-protobuf/`
  is needed for full deep-decode coverage; `src/main/proto` alone is
  not sufficient.

### ArkWorks / serialization quirks that must be preserved
Any re-implementation must handle these or verification silently fails:
- **G1 compressed (BLS12-381):** 48-byte BE, `buf[0] |= 0x80` always,
  `buf[0] |= 0x20` if `y > (p-1)/2`; point-at-infinity = `0xc0`.
- **G2 compressed:** imaginary part first, real part second (opposite
  of noble's native ordering); flag bits in `buf[0]`.
- **BN254 ArkWorks flags:** bit7 = sign positive, bit6 = infinity.
- **BLS12-381 Fr `TWO_ADIC_ROOT`:**
  `0x16a2a19edfe81f20d09b681922c813b4b63683508c2280b93829971f439f0d2b`
  (ark-ff constant, easy to miscopy).
- **`expand_message_xmd` z_pad = 48**, not RFC 9380's 64 — ark-ff 0.4.2
  deviation. Hashes produce different `r` otherwise.
- **Fp2 component order** in transcripts differs from noble; swap
  required.
- **hinTS sizes:** verification key = 1096 bytes, signature = 1632
  bytes (format-dependent, encoded).

### Fixture freshness matters
Early-stage fixtures produced false negatives on hinTS KZG checks
because the block payload was generated with an older hedera-cryptography
version. The Java verifier had the same issue conceptually. Conformance
tests must pin fixture provenance.

### Java parity
The Java verifier delegates BLS/WRAPS/hinTS to native Rust via
`TSS.verifyTSS(...)`. At the *application* layer Java and JS are in the
same position; JS just lacks a native backend. This means:
- There is no "Java reference implementation of the math" to copy —
  the reference is the Rust crypto in hedera-cryptography.
- Parity testing against Java is about output equivalence, not
  structural equivalence of the verifier code.

### Scope implications
- hinTS is no longer a blocker → target 1.0 (not 0.x).
- WRAPS requires Groth16+KZG on BN254, implemented ourselves → must
  ship our own verifier, not wrap snarkjs.
- Shallow parsing + streaming hasher are already proven → make them
  load-bearing architectural invariants, not implementation details.

## Decision

Build a single npm package **`@hiero-ledger/block-verifier`** with
subpath exports, pure-JS by default, swappable crypto backend, targeting
Node ≥20 and modern browsers.

### Key choices

1. **Single package, subpath exports.** Consumers get one-install DX but
   can tree-shake to just the codec or hasher for minimal bundle size.

   ```
   @hiero-ledger/block-verifier           # orchestrator / top-level API
   @hiero-ledger/block-verifier/codec     # shallow protobuf parser
   @hiero-ledger/block-verifier/hasher    # HIP-1056 Merkle tree (SHA-384)
   @hiero-ledger/block-verifier/crypto    # backend interface + noble default
   ```

2. **Shallow parsing preserved.** Scan wire bytes of `BlockUnparsed`;
   extract raw `BlockItemUnparsed` bytes for hashing; deep-decode only
   control-plane messages (`BlockHeader`, `BlockFooter`, `BlockProof`,
   bootstrap `TransactionBody`). This matches the Java block-node design
   and avoids decode-reencode drift in Merkle root computation.

3. **Pluggable crypto backend.** A `CryptoBackend` interface abstracts
   BLS12-381 / BN254 operations. Default implementation uses
   `@noble/curves`. A future WASM backend (e.g. arkworks-wasm) can be
   dropped in without changing public API.

4. **Pure JS, no native deps.** `@noble/curves`, `@noble/hashes`, and a
   minimal protobuf-reader. Must run in browser (Vite, Next.js,
   Cloudflare Workers) and Node ≥20.

5. **Dual ESM + CJS** build via `tsup`, ships `.d.ts`.
   `"sideEffects": false` for tree-shaking.

6. **Target 1.0 covering full P0** (hash + Schnorr + WRAPS + hinTS) since
   the spike has removed all known blockers.

7. **Fixtures bundled** for tests: genesis, settled WRAPS, hinTS
   (existing `CN_0_73_TSS_WRAPS` set). Provenance documented.

### Public API (P0)

The v1.0 surface is intentionally small: one high-level entry point plus
a handful of composables for advanced users. All functions are
side-effect-free and tree-shakeable.

#### Top-level (`@hiero-ledger/block-verifier`)

```ts
/** Decode + hash + TSS verify a block in one call. */
export function verifyBlock(
  input: Uint8Array | ArrayBuffer,
  options?: VerifyOptions,
): Promise<VerifyResult>;

export interface VerifyOptions {
  /** Custom crypto backend; defaults to bundled noble impl. */
  crypto?: CryptoBackend;
  /** If true, skip TSS verification and only check hashes. */
  hashOnly?: boolean;
  /** Expected block number; if given, mismatch fails verification. */
  expectedBlockNumber?: bigint;
  /** Trust anchor: ledger id / genesis key material (required for
   *  hinTS / WRAPS unless bootstrap is taken from the block itself). */
  trustAnchor?: TrustAnchor;
}

export interface VerifyResult {
  valid: boolean;
  blockNumber: bigint;
  root: Uint8Array;                 // SHA-384 block root
  proofKind: "schnorr" | "wraps" | "hints" | "none";
  checks: Record<string, boolean>;  // per-check booleans (e.g. 10 hinTS checks)
  errors: string[];                 // empty iff valid === true
}
```

#### `/codec`

```ts
/** Gunzips if needed, shallow-parses a block. */
export function parseBlock(input: Uint8Array): ParsedBlock;

export interface ParsedBlock {
  blockNumber: bigint;
  items: ParsedItem[];          // preserves raw wire bytes per item
  header: BlockHeader;
  footer: BlockFooter;
  proof: BlockProof;
  bootstrap?: BootstrapData;    // genesis only
}
```

#### `/hasher`

```ts
/** Computes HIP-1056 Merkle root over raw BlockItemUnparsed bytes. */
export function computeBlockRoot(parsed: ParsedBlock): Promise<Uint8Array>;
```

#### `/crypto`

```ts
export function createNobleBackend(): CryptoBackend;
export interface CryptoBackend { /* see architecture doc */ }
```

#### Errors

All functions throw `BlockVerifierError` (subclasses: `ParseError`,
`HashMismatchError`, `ProofError`, `UnsupportedProofError`) with a
stable `.code` string for programmatic handling. `verifyBlock` never
throws for verification failures — it returns `{ valid: false, errors }`.
It only throws for malformed input or misuse.

#### Stability

Public exports listed above are covered by semver. Internal modules
(deserializers, point codecs, Fiat-Shamir helpers) are not exported and
may change in minor versions.

### Rejected alternatives

- **Multi-package monorepo.** Better boundaries, but worse DX (multiple
  installs, version skew), and modern bundlers tree-shake single packages
  well enough. Rejected.
- **WASM-first (arkworks / blst).** Faster, but adds build complexity,
  hurts browser bundle size, and blocks Cloudflare Workers-style
  deployments. Rejected for v1; kept as future backend option.
- **Full deep-decode of `Block`.** Simpler code, but risks Merkle drift
  from canonical encoding and diverges from block-node architecture.
  Rejected.
- **Reference-only, non-production quality.** The issue says "reference"
  but consumers will `npm install` it. Holding to production bar.
- **Ship 0.x indefinitely.** No blockers remain; holding back creates
  adoption friction. Ship 1.0.

## Consequences

### Positive

- Community and dApps can verify blocks in browser and Node
- Bundle-size-conscious consumers can import just the codec or hasher
- Backend swap enables a later WASM build for perf-sensitive use cases
- Matches Java architecture semantically, easier to reason about parity

### Negative / costs

- Pure-JS pairing is ~10–50× slower than native; acceptable for
  per-block verification, not for batch/indexer workloads
- Ownership of a public npm package: versioning, security disclosures,
  breaking-change discipline
- Fixture regeneration requires coordination with block-node maintainers
  when proof formats evolve

### Risks

- Proof-format evolution (future HIPs) breaking the library —
  mitigated by shallow parsing + versioned proof-kind dispatch
- Bundle bloat from curve code — mitigated by subpath exports
- Spec drift vs. Java — mitigated by documenting conformance fixtures;
  optional CI cross-check added later

## Open items (not blocking this ADR)

- Exact npm scope ownership under `@hiero-ledger`
- Repo carve-out (in-tree → standalone) timing
- P1 / P2 API design (see architecture doc)
