# `@hiero-ledger/block-verifier` — High-Level Architecture

Covers P0 (ships in 1.0), P1 (block-contents inclusion proofs), and P2
(Solidity / smart-contract verifier). See ADR 0001 for P0 decisions.

## Layering

Legend: `[P0]` ships in 1.0, `[P1]` ships in 1.1, `[P2]` TBD.

```
           ┌────────────────────────────────────────────────┐
           │       Public API (orchestrator)          [P0]  │
           │  verifyBlock  |  parseBlock  |  computeRoot    │
           │  verifyInclusion  |  generateInclusionProof    │ [P1]
           │  (Solidity calldata encoders)                  │ [P2]
           └─────────────────┬──────────────────────────────┘
                             │
       ┌────────────┬────────┴─────────┬──────────────┐
       │            │                  │              │
   ┌───▼───┐   ┌────▼───┐        ┌─────▼────┐    ┌────▼────┐
   │ codec │   │ hasher │        │ tss-     │    │ proofs  │
   │ [P0]  │   │ [P0]   │        │ verifier │    │ [P1]    │
   └───┬───┘   └────┬───┘        │ [P0]     │    └────┬────┘
       │            │            └────┬─────┘         │
       │            │                 │               │
       │            │                 ▼               │
       │            │          ┌────────────┐         │
       │            │          │  crypto    │◄────────┘
       │            │          │  backend   │  [P0]
       │            │          │ (noble/…)  │
       │            │          └────────────┘
       │            │
       └────────────┴──── @noble/hashes (SHA-384)   [P0]

                       ┌──────────────────────────┐
                       │  /solidity (TBD)   [P2]  │
                       └──────────────────────────┘
```

Rules:

- **codec** has no crypto dependency (pure wire parser + reader utils).
- **hasher** depends only on a hash primitive (`SHA-384`).
- **tss-verifier** depends on the `CryptoBackend` interface, never
  directly on a curve library.
- **crypto backend** is injected; default is `noble`.
- Public API re-exports composables so advanced users can bypass the
  orchestrator.

## Module map

| Subpath | Purpose | Spike source |
|---|---|---|
| `/codec` | Gzip decode, shallow `BlockUnparsed` scan, item classification, deep-decode of control-plane messages | `parseBlock.ts`, `proto.ts`, `byteReaders.ts`, `extractBootstrap.ts` |
| `/hasher` | HIP-1056 streaming Merkle tree (SHA-384), leaf + internal domain separation, single-child nodes | `computeBlockRoot.ts` |
| `/crypto` | `CryptoBackend` interface, noble impl, BN254 + BLS12-381 point codecs, ArkWorks quirks | `bls12381Points.ts`, `bn254Decompress.ts`, `hintsFieldHash.ts` |
| `/tss` | Schnorr, WRAPS (Groth16+KZG), hinTS verifiers; proof-kind dispatch | `verifySchnorr.ts`, `verifyWrapsProof.ts`, `verifyHints.ts`, `deserialize*.ts` |
| `/proofs` (P1) | Inclusion-proof generation + verification | (new) |
| `/solidity` (P2) | Exported verifier contracts + JS helpers | (new) |
| top-level | `verifyBlock`, `parseBlock`, result types | `index.ts`, `report.ts`, `types.ts` |

## P0 — what ships in 1.0

### Flow
1. `verifyBlock(bytes, opts?)` gunzips and shallow-parses.
2. Streaming Merkle root computed from raw `BlockItemUnparsed` bytes.
3. `BlockProof` is inspected; proof kind is classified (Schnorr / WRAPS /
   hinTS).
4. Appropriate verifier from `/tss` runs against `(root, proof, vk)`.
5. Result aggregated:

```ts
type VerifyResult = {
  valid: boolean;
  blockNumber: bigint;
  root: Uint8Array;
  proofKind: "schnorr" | "wraps" | "hints";
  checks: Record<string, boolean>;   // 10 hinTS checks, etc.
  errors: string[];
};
```

### Crypto backend — what "injected" means

The library never imports `@noble/curves` directly from verifier code.
Instead, every curve / pairing / hash-to-curve call goes through a
`CryptoBackend` object that the caller passes in. A default noble-based
implementation is bundled and used automatically if the caller provides
nothing.

Concretely:

```ts
// Default path — library uses the bundled noble backend
verifyBlock(bytes);

// Injection path — caller supplies a custom backend
import { createNobleBackend } from "@hiero-ledger/block-verifier/crypto";
import { createWasmBackend } from "some-wasm-pairing-lib";

verifyBlock(bytes, { crypto: createWasmBackend() });
```

Why it matters:
- Future WASM / native backends drop in without touching verifier code
  or bumping a major version.
- Tests can inject deterministic / mock backends.
- Consumers in constrained environments (Workers, RN) can swap in a
  smaller or platform-specific impl.

The interface surface (shape, not final signatures):

```ts
interface CryptoBackend {
  bls12_381: {
    pairing(a, b): Fp12;
    hashToG2(msg, dst): G2;
    G1: { fromCompressed, toCompressed, ... };
    G2: { fromCompressed, toCompressed, ... };
    Fr: { /* …incl. TWO_ADIC_ROOT fix */ };
  };
  bn254: {
    pairing(a, b): Fp12;
    G1: { ... };
    G2: { ... };
  };
  kzg: { verify(commitment, opening, point, value): boolean };
}
```

## P1 — block contents proofs

**Delta from P0:** keep the Merkle tree (not just root) during hashing,
expose proof generation + verification.

### Additions
- `hasher` grows a retention mode:
  `buildBlockTree(items) → { root, levels, indexOf(item) }`.
- New subpath `/proofs`:
  ```ts
  generateInclusionProof(block, itemIndex): InclusionProof;
  verifyInclusion(proof, expectedRoot): boolean;

  type InclusionProof = {
    leaf: Uint8Array;        // encoded BlockItemUnparsed
    path: Uint8Array[];      // sibling hashes bottom-up
    index: number;           // leaf position
    root: Uint8Array;        // block root
  };
  ```
- Inclusion proof is self-contained: verifier only needs `(proof,
  expectedRoot)` — typically the root is carried by a verified block
  proof, chaining P0 + P1 end-to-end.

### Out of scope for P1 v1
- Field-level proofs inside an item (e.g. prove a specific transaction
  output). Requires item-kind-specific sub-tree knowledge. Candidate for
  1.1.

### Estimated effort
2–3 days on top of a stable P0 (see conversation for breakdown).

## P2 — smart-contract verification

**TBD.** Design deferred; to be specified in a follow-up ADR once P0 and
P1 have shipped and the required on-chain primitives (EIP-2537 rollout,
commitment choice for inclusion proofs) are clearer.

## Non-functional requirements

- **Runtime:** Node ≥ 20, modern browsers, Cloudflare Workers (no native
  deps)
- **Bundle:** hasher-only path ≤ ~20 KB gzipped; full verifier ≤ ~200 KB
  gzipped (noble curves dominate)
- **Perf:** full block verify < 2 s in Node on commodity hardware;
  browser best-effort
- **Deps:** `@noble/curves`, `@noble/hashes`, nothing else runtime
- **License:** Apache-2.0 (match block-node)

## Versioning & release

- `1.0.0` — full P0
- `1.1.0` — P1 inclusion proofs
- `1.2.0` — P2 Solidity verifier (WRAPS)
- Breaking changes only on major bumps; proof-kind additions are minor.

## Open questions

- npm scope ownership (`@hiero-ledger`)
- Repo carve-out timing (in-tree vs. standalone repo)
- Does P1 need field-level proofs in v1, or is item-level enough?
- EVM target for P2 — mainnet + which L2s?
- Conformance strategy: bundle Java-cross-check fixtures, or formal
  vector spec?
