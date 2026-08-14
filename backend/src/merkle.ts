// Three-level Merkle system: per-forum post trees, per-post comment trees, and one
// top-level tree (see DEVELOPER_GUIDE.md for the full structure). Subtree roots are
// inserted as raw leaves (not re-hashed) into the tree above, so a full audit proof
// is just the within-subtree proof concatenated with the subtree-to-top proof.
// MerkleTree.verify() applies sibling hashes flatly, so this works with zero
// special-casing regardless of how many levels a proof spans. The top-level tree's
// root is what indexer.ts anchors on-chain via DeRedditCore.anchorDatabaseRoot()
// once per block.

import { ethers } from "ethers";
import { MerkleTree } from "merkletreejs";
import type { PoolClient } from "pg";

/** Which kind of on-chain entity a Merkle leaf represents. */
export type EntityType = "post" | "comment" | "forum";

/** Fields packed into a leaf hash by buildLeaf; contentHash is the entity's IPFS CID digest. */
export interface MerkleLeaf {
  readonly entityType: EntityType;
  readonly id: bigint;
  readonly contentHash: string;
}

/**
 * Shape returned by the getXAuditProof functions and served by server.ts's
 * /api/audit/* routes: the anchored root, the proof path to it, and the leaf
 * data the frontend re-hashes to check against that root.
 */
export interface AuditResult {
  root: string;
  proof: string[];
  leaf: { entityType: EntityType; id: string; contentHash: string };
}

// ─── Leaf builder ────────────────────────────────────────────────────────────

/**
 * Deterministic leaf hash for an entity. Mirrored by computeLeafHash in
 * frontend/src/lib/merkleVerify.ts - the field order/types packed here
 * (entityType, id, contentHash) must match exactly or client-side audit
 * proof verification against the on-chain anchored root will fail.
 */
export function buildLeaf(leaf: MerkleLeaf): Buffer {
  const hash = ethers.solidityPackedKeccak256(
    ["string", "uint256", "bytes32"],
    [leaf.entityType, leaf.id, leaf.contentHash]
  );
  return Buffer.from(hash.slice(2), "hex");
}

// ─── Sub-tree builders ─────────────────────────────────────────────────────

/** Every post in one forum. Returns null if the forum has zero posts (empty trees aren't meaningful leaves). */
export async function buildForumPostsTree(client: PoolClient, forumKey: string): Promise<MerkleTree | null> {
  const { rows } = await client.query<{ id: string; cid: string }>(
    `SELECT post_id::text AS id, ipfs_cid AS cid FROM posts WHERE forum_key = $1 ORDER BY post_id ASC`,
    [forumKey]
  );
  if (rows.length === 0) return null;
  const leaves = rows.map((r) => buildLeaf({ entityType: "post", id: BigInt(r.id), contentHash: r.cid }));
  return new MerkleTree(leaves, ethers.keccak256, { sortPairs: true });
}

/** Every comment on one post. Returns null if the post has zero comments. */
export async function buildPostCommentsTree(client: PoolClient, postId: string): Promise<MerkleTree | null> {
  const { rows } = await client.query<{ id: string; cid: string }>(
    `SELECT comment_id::text AS id, ipfs_cid AS cid FROM comments WHERE post_id = $1 ORDER BY comment_id ASC`,
    [postId]
  );
  if (rows.length === 0) return null;
  const leaves = rows.map((r) => buildLeaf({ entityType: "comment", id: BigInt(r.id), contentHash: r.cid }));
  return new MerkleTree(leaves, ethers.keccak256, { sortPairs: true });
}

/** Forum leaves + every non-empty forum-posts-subtree root + every non-empty post-comments-subtree root. */
export async function buildTopLevelTree(client: PoolClient): Promise<MerkleTree> {
  const { rows: forums } = await client.query<{ forum_key: string; cid: string }>(
    `SELECT forum_key, ipfs_cid AS cid FROM forums ORDER BY forum_key ASC`
  );

  const leaves: Buffer[] = forums.map((f) =>
    buildLeaf({ entityType: "forum", id: BigInt(f.forum_key), contentHash: f.cid })
  );

  for (const f of forums) {
    const subtree = await buildForumPostsTree(client, f.forum_key);
    if (subtree) leaves.push(subtree.getRoot());
  }

  const { rows: postsWithComments } = await client.query<{ post_id: string }>(
    `SELECT DISTINCT post_id::text AS post_id FROM comments`
  );
  for (const p of postsWithComments) {
    const subtree = await buildPostCommentsTree(client, p.post_id);
    if (subtree) leaves.push(subtree.getRoot());
  }

  const buffers = leaves.length === 0 ? [Buffer.alloc(32)] : leaves;
  return new MerkleTree(buffers, ethers.keccak256, { sortPairs: true });
}

// ─── Audit proof assembly (used by server.ts's /api/audit/* routes) ─────────

/** Concatenated proof: leaf -> forum-posts-subtree root -> top-level root. */
export async function getPostAuditProof(client: PoolClient, postId: string): Promise<AuditResult | null> {
  const { rows } = await client.query<{ forum_key: string; ipfs_cid: string }>(
    `SELECT forum_key, ipfs_cid FROM posts WHERE post_id = $1`,
    [postId]
  );
  if (rows.length === 0) return null;
  const { forum_key, ipfs_cid } = rows[0];

  const subtree = await buildForumPostsTree(client, forum_key);
  if (!subtree) return null; // shouldn't happen - the post itself proves the forum has >=1 post

  const leaf: MerkleLeaf = { entityType: "post", id: BigInt(postId), contentHash: ipfs_cid };
  const leafBuf = buildLeaf(leaf);
  const proofWithinForum = subtree.getHexProof(leafBuf);
  const forumSubtreeRoot = subtree.getRoot();

  const topTree = await buildTopLevelTree(client);
  const proofToTop = topTree.getHexProof(forumSubtreeRoot);

  return {
    root: topTree.getHexRoot(),
    proof: [...proofWithinForum, ...proofToTop],
    leaf: { ...leaf, id: String(leaf.id) },
  };
}

/** Concatenated proof: leaf -> post-comments-subtree root -> top-level root. */
export async function getCommentAuditProof(client: PoolClient, commentId: string): Promise<AuditResult | null> {
  const { rows } = await client.query<{ post_id: string; ipfs_cid: string }>(
    `SELECT post_id::text AS post_id, ipfs_cid FROM comments WHERE comment_id = $1`,
    [commentId]
  );
  if (rows.length === 0) return null;
  const { post_id, ipfs_cid } = rows[0];

  const subtree = await buildPostCommentsTree(client, post_id);
  if (!subtree) return null; // shouldn't happen - the comment itself proves the post has >=1 comment

  const leaf: MerkleLeaf = { entityType: "comment", id: BigInt(commentId), contentHash: ipfs_cid };
  const leafBuf = buildLeaf(leaf);
  const proofWithinPost = subtree.getHexProof(leafBuf);
  const postSubtreeRoot = subtree.getRoot();

  const topTree = await buildTopLevelTree(client);
  const proofToTop = topTree.getHexProof(postSubtreeRoot);

  return {
    root: topTree.getHexRoot(),
    proof: [...proofWithinPost, ...proofToTop],
    leaf: { ...leaf, id: String(leaf.id) },
  };
}

/** Forums are direct leaves of the top-level tree, so this is a single-level proof. */
export async function getForumAuditProof(client: PoolClient, forumKey: string): Promise<AuditResult | null> {
  const { rows } = await client.query<{ ipfs_cid: string }>(
    `SELECT ipfs_cid FROM forums WHERE forum_key = $1`,
    [forumKey]
  );
  if (rows.length === 0) return null;

  const forumKeyHex = forumKey.startsWith("0x") ? forumKey : `0x${forumKey}`;
  const leaf: MerkleLeaf = { entityType: "forum", id: BigInt(forumKeyHex), contentHash: rows[0].ipfs_cid };
  const leafBuf = buildLeaf(leaf);

  const topTree = await buildTopLevelTree(client);
  const proof = topTree.getHexProof(leafBuf);

  return {
    root: topTree.getHexRoot(),
    proof,
    leaf: { ...leaf, id: String(leaf.id) },
  };
}