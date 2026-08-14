// Deliberately reimplemented from scratch rather than pulling in
// merkletreejs as a frontend dependency, since only two small operations are
// needed: recompute a leaf hash, and walk a flat proof array applying
// sibling hashes with the same sortPairs convention backend/src/merkle.ts
// uses. Because subtree roots are folded directly into the top tree (see
// DEVELOPER_GUIDE.md), a concatenated cross-tree proof verifies with the
// exact same flat-array walk as a single-level proof would - no special
// casing needed here for proof depth.

import { ethers } from "ethers";

/** Matches backend/src/merkle.ts's buildLeaf(): keccak256(entityType, id, contentHash). */
export function computeLeafHash(entityType: string, id: string, contentHash: string): string {
  return ethers.solidityPackedKeccak256(["string", "uint256", "bytes32"], [entityType, BigInt(id), contentHash]);
}

function combine(a: string, b: string): string {
  // sortPairs: lexicographic sort of two equal-length 0x-prefixed hex
  // strings matches numeric ordering, same as merkletreejs's default.
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return ethers.keccak256(ethers.concat([x, y]));
}

/** Walks the proof array from `leaf`, applying each sibling hash in order, and checks the result equals `root`. */
export function verifyMerkleProof(leaf: string, proof: string[], root: string): boolean {
  let computed = leaf;
  for (const sibling of proof) {
    computed = combine(computed, sibling);
  }
  return computed.toLowerCase() === root.toLowerCase();
}