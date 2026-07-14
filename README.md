# hiero-block-verifier-js

A pure JavaScript/TypeScript implementation that independently verifies Hiero/Hedera block proofs
(HIP-1056 / HIP-1200) using only `@noble/curves` — no native binaries or WASM required.

## What It Verifies

All three proof paths are fully implemented and working:

| Verification | Curve | Status |
|---|---|---|
| **Schnorr** aggregate signature (genesis/pre-settled blocks) | BabyJubjub over BN254 | Working |
| **WRAPS** Nova IVC proof (Groth16 + KZG) | BN254 | Working |
| **hinTS** BLS threshold signature (10 pairing checks) | BLS12-381 | Working |
| Block root recomputation (SHA-384 Merkle tree) | — | Working |
| Bootstrap extraction from block 0 | — | Working |

## Quick Start

```bash
git clone https://github.com/hiero-hackers/hiero-block-verifier-js.git
cd hiero-block-verifier-js
npm install
```

Run the default verification (block 0 + block 467):

```bash
npm run verify
```

## Available Scripts

```bash
npm run verify           # Default: block 0 (Schnorr) + block 467 (WRAPS)
npm run verify:block0    # Genesis block only (Schnorr path)
npm run verify:block467  # Block 0 + 467 (Schnorr + WRAPS paths)
npm run verify:all       # All 7 fixtures (blocks 0-4, 466, 467)
```

Run any fixture by path:

```bash
npx tsx src/index.ts path/to/block.blk.gz
```

JSON output:

```bash
npx tsx src/index.ts --json
```

## Expected Output

### Block 0 (genesis-schnorr, 2920 bytes)

```
Schnorr verification: VERIFIED — Schnorr aggregate signature verified successfully (2/3 signers).
hinTS verification:   VERIFIED — 10/10 checks pass
```

### Block 467 (WRAPS, 3432 bytes)

```
WRAPS verification:   VERIFIED — Groth16 valid, KZG valid, ledger ID match (7/7 checks)
hinTS verification:   VERIFIED — 10/10 checks pass
```

## Test Fixtures

The verifier ships with fixtures vendored from the `hiero-block-node` repo
(`CN_0_73_TSS_WRAPS` corpus), located at:

```
fixtures/CN_0_73_TSS_WRAPS/
```

| File | Block | Proof Path | Proof Size |
|---|---|---|---|
| `0.blk.gz` | 0 | genesis-schnorr | 2920 bytes |
| `1.blk.gz` | 1 | genesis-schnorr | 2920 bytes |
| `2.blk.gz` | 2 | genesis-schnorr | 2920 bytes |
| `3.blk.gz` | 3 | genesis-schnorr | 2920 bytes |
| `4.blk.gz` | 4 | genesis-schnorr | 2920 bytes |
| `466.blk.gz` | 466 | wraps | 3432 bytes |
| `467.blk.gz` | 467 | wraps | 3432 bytes |

Block 0 contains the `LedgerIdPublicationTransactionBody` bootstrap transaction, which provides
the public keys and ledger ID needed to verify all subsequent blocks. When verifying non-genesis
blocks, always include block 0 first (or pass it before the target block).

## Architecture

### Shallow Parsing

The parser works at the protobuf wire level — it scans `BlockUnparsed` bytes directly, extracts
each `BlockItemUnparsed` without full deserialization, and preserves original encoded bytes for
hashing. Only control-plane messages (BlockHeader, BlockFooter, BlockProof, bootstrap transactions)
are deeply decoded.

### Proof Layout

The `blockSignature` field in the BlockProof contains:

| Segment | Size | Content |
|---|---|---|
| hinTS verification key | 1096 bytes | BLS12-381 points + polynomial commitments |
| hinTS signature | 1632 bytes | BLS aggregate signature + KZG proofs + bitmap |
| Suffix | 192 or 704 bytes | Schnorr signature (192) or WRAPS proof (704) |

- **2920-byte proofs** = genesis/Schnorr path (192-byte suffix)
- **3432-byte proofs** = settled/WRAPS path (704-byte suffix)

### Verification Details

**Schnorr** (genesis blocks): BabyJubjub curve, Blake2s challenge, Poseidon hash over BN254 for
public key aggregation.

**WRAPS** (settled blocks): The 704-byte suffix is a Nova IVC `ProofData` bundle containing a
Groth16 decider proof and 2 KZG opening proofs, all on BN254. Verification checks: ledger ID match,
hinTS VK hash match, iteration guard, commitment zero-check, Groth16 pairing, and both KZG pairings.

**hinTS** (all blocks): BLS12-381 threshold signature with 10 checks — BLS pairing, merged/parsum
KZG validity, B-SK identity, parsum accumulation/constraint, bitmap well-formedness/constraint, and
degree check. Uses a Fiat-Shamir challenge derived from the block root and proof data.

### Serialization

All cryptographic points use ArkWorks serialization conventions:
- BN254: little-endian, compressed, flag byte has bit7=positive, bit6=infinity
- BLS12-381: big-endian Fp, Fp2 components in (c1, c0) order relative to noble

## Dependencies

- `@noble/curves` — elliptic curve arithmetic (BN254, BLS12-381, BabyJubjub)
- `protobufjs` — protobuf decoding for control-plane messages
- `fzstd` — zstandard decompression (legacy `.blk.zstd` support)

All pure JavaScript, no native or WASM dependencies.

## Proto Setup

The proto definitions are vendored into this repo under `proto/`:

- `proto/local/` — block-node internal protos (e.g. `internal/unparsed.proto`)
- `proto/generated/` — the combined `block-node-protobuf` bundle

No generation step is required. These were produced from the `hiero-block-node` repo with:

```bash
cd protobuf-sources
./scripts/build-bn-proto.sh -t v0.72.0-rc.3 -v local -o "$PWD/block-node-protobuf" -i true -b "$PWD/src/main/proto"
```

To refresh them against a newer block-node release, regenerate with that script and copy the
output into `proto/generated/` (and `src/main/proto` into `proto/local/`).

## Releasing (maintainers)

Publishing to npm is automated by [`.github/workflows/release.yml`](.github/workflows/release.yml):
it runs on a version tag, so the publish token stays in CI and never on a laptop.

**One-time setup:** add the org-owned npm publish token as the repository secret
**`TOKEN_BLOCK_VERIFIER_JS`** (Settings → Secrets and variables → Actions).

**To cut a release:**

1. Bump `version` in `package.json` and merge to `main`.
2. Tag that commit and push it:

   ```bash
   git tag -s v0.2.0
   git push origin v0.2.0
   ```

3. The Release workflow builds (`prepublishOnly` → `tsc`) and runs
   `npm publish --provenance --access public`. The tag **must** match the
   `package.json` version, or the run fails fast.

The published tarball contains only the compiled `dist/` (`files: ["dist"]`) and
carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
cryptographically linking it to the workflow run and commit.
