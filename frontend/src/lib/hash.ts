// Every helper here must byte-for-byte mirror the corresponding encoding in
// backend/src/indexer.ts - see each function's comment for why.

import { ethers } from "ethers";
import bs58 from "bs58";

/** keccak256(utf8Bytes(text)) - used to derive a forum's on-chain forumKey from its handle. */
export function keccak256Utf8(text: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(text));
}

function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Convert a CIDv0 base58 string (e.g. "Qm...") into the 32-byte hex digest the
 * contracts store on-chain, by stripping the constant 2-byte sha256 multihash
 * prefix (0x12 0x20). Mirrors bytes32ToIPFS() in backend/src/indexer.ts.
 */
export function ipfsCidToBytes32(cid: string): string {
  const multihash = bs58.decode(cid);
  if (multihash.length !== 34 || multihash[0] !== 0x12 || multihash[1] !== 0x20) {
    throw new Error(`Unsupported CID format for on-chain storage: ${cid}. Expected a CIDv0 sha256 hash ("Qm...").`);
  }
  const digest = multihash.slice(2);
  return bytesToHex(digest);
}

/**
 * The inverse of ipfsCidToBytes32 - reconstructs a CIDv0 base58 string from
 * the 32-byte digest stored on-chain. Needed by the "finish poll setup"
 * flow, which must re-read a post's pollChoices from IPFS using only the
 * ipfs_cid the API already returns (the bytes32 form, not the original CID).
 * Mirrors backend/src/indexer.ts's bytes32ToIPFS() exactly, using Uint8Array
 * instead of Node's Buffer since this runs in the browser.
 */
export function bytes32ToIpfsCid(hex: string): string {
  const digestHex = hex.slice(2);
  const digest = new Uint8Array(digestHex.length / 2);
  for (let i = 0; i < digest.length; i++) {
    digest[i] = parseInt(digestHex.substr(i * 2, 2), 16);
  }
  const multihash = new Uint8Array(34);
  multihash[0] = 0x12;
  multihash[1] = 0x20;
  multihash.set(digest, 2);
  return bs58.encode(multihash);
}

/**
 * Encodes a username as a bytes32 short string, matching what
 * DeRedditCore.registerIdentity expects. Throws if the username exceeds 31
 * bytes (31 chars + null byte).
 */
export function encodeUsernameBytes32(username: string): string {
  return ethers.encodeBytes32String(username);
}

/** Empty bytes32, used as the `profileCID` argument when registering without an IPFS profile document. */
export const ZERO_BYTES32 = "0x" + "0".repeat(64);