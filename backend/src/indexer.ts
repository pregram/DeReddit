// See DEVELOPER_GUIDE.md for the indexer's overall architecture (polling model,
// per-block transaction/SAVEPOINT handling, Merkle anchoring, event flow).
//
// Local mechanics worth knowing:
//  - Every insert into a chronologically ordered table stores both the
//    originating block's timestamp and its log index, so rows created in
//    the same block can still be sorted in true on-chain event order.
//  - fetchJsonFromIPFS enforces a 3s AbortController timeout and never
//    throws/returns null - a slow or down gateway degrades to a fixed
//    "[Metadata Unavailable]" placeholder so the event still indexes.
//  - HARDENING: username bytes32 decoding is wrapped in try/catch. A
//    non-UTF-8 byte sequence in a registered username (reachable by calling
//    registerIdentity directly, bypassing the frontend's
//    encodeBytes32String) used to throw uncaught inside the block's
//    transaction, making processBlock retry the SAME block forever - a
//    poison-block DoS that permanently halted the indexer. Malformed
//    usernames now fall back to a placeholder instead of aborting the
//    block; the per-event SAVEPOINT + indexer_errors table generalize this
//    guard to any handler that throws.

import "dotenv/config";
import { ethers } from "ethers";
import { z } from "zod";
import bs58 from "bs58";
import pool from "./db.js";
import { CORE_ABI, ESCROW_ABI, POST_TYPE } from "./abis.js";
import { runInTransaction } from "./utils/tx.js";
import { buildTopLevelTree } from "./merkle.js";
import {
  checkGenesisBadge,
  checkKarmaBadges,
  checkPostCountBadges,
  checkCommentCountBadges,
  checkForumCountBadges,
  checkPostUpvoteBadges,
  checkCommentUpvoteBadges,
  checkForumMemberBadges,
} from "./badges.js";
import type { PoolClient } from "pg";

// =============================================================================
// CONFIG
// =============================================================================

const RPC_URL     = process.env.RPC_URL!;
const CORE_ADDR   = process.env.CORE_CONTRACT_ADDRESS!;
const ESCROW_ADDR = process.env.ESCROW_CONTRACT_ADDRESS!;
const IPFS_GATEWAY = process.env.IPFS_GATEWAY ?? "https://ipfs.io/ipfs/";

const DEPLOYMENT_BLOCK = BigInt(process.env.DEPLOYMENT_BLOCK || "0");

// eth_getLogs range caps vary a lot by provider/plan - e.g. Alchemy's free tier
// caps this at just 10 blocks per call (error code -32600, "Under the Free tier
// plan, you can make eth_getLogs requests with up to a 10 block range"), not the
// thousands you might expect. 2000 is a reasonable default for a paid tier or a
// provider without a tight cap, but set INDEXER_BATCH_SIZE in .env to match
// whatever your actual provider/plan allows (see backend/.env.sepolia's value).
const CATCHUP_BATCH_SIZE = Number(process.env.INDEXER_BATCH_SIZE ?? "2000");

// While catching up, the loop otherwise fires the next batch the instant the
// previous one resolves - fine against a local Hardhat node, but on Sepolia
// (Alchemy) this bursts past the provider's compute-units-per-second cap and
// triggers a 429 storm (distinct from the eth_getLogs block-range cap that
// CATCHUP_BATCH_SIZE handles). A small fixed gap between batches keeps normal
// catch-up under that cap; set INDEXER_BATCH_DELAY_MS=0 to disable.
const CATCHUP_BATCH_DELAY_MS = Number(process.env.INDEXER_BATCH_DELAY_MS ?? "300");

// When a batch still fails (429 or otherwise), back off exponentially instead
// of hammering the same range every 5s - each successive failure waits longer,
// capped at MAX_RETRY_DELAY_MS, and it resets to the base delay as soon as a
// batch succeeds again.
const BASE_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 60_000;

const provider    = new ethers.JsonRpcProvider(RPC_URL);
const coreIface   = new ethers.Interface(CORE_ABI);
const escrowIface = new ethers.Interface(ESCROW_ABI);

const oracleWallet           = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY!, provider);
const coreContractWithOracle = new ethers.Contract(CORE_ADDR, CORE_ABI, oracleWallet);

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const zAddr    = z.string().transform((s) => s.toLowerCase());
const zB32     = z.string();
const zBigint  = z.union([z.bigint(), z.string()]).transform(BigInt);
const zUint8   = z.union([z.number(), z.bigint()]).transform(Number);
const zUint32  = z.union([z.number(), z.bigint()]).transform(Number);
const zInt8    = z.union([z.number(), z.bigint()]).transform((v) => Number(v) as -2 | -1 | 0 | 1);

const UserRegisteredSchema = z.tuple([zAddr, zB32, zB32]);
const ProfileCIDUpdatedSchema = z.tuple([zAddr, zB32]);
const ForumCreatedSchema   = z.tuple([zB32, zAddr, zBigint, zB32]);
const MemberJoinedSchema   = z.tuple([zB32, zAddr]);
const MemberLeftSchema     = z.tuple([zB32, zAddr]);
const PostCreatedSchema    = z.tuple([zBigint, zAddr, zB32, zUint8, zUint32, zB32]);
const PollConfiguredSchema = z.tuple([zBigint, zUint8, zUint32]);
const CommentCreatedSchema = z.tuple([zBigint, zBigint, zBigint, zAddr, zUint8, zB32]);
const PostVotedSchema      = z.tuple([zBigint, zAddr, zInt8, zBigint]);
const CommentVotedSchema   = z.tuple([zBigint, zAddr, zInt8, zBigint]);
const PostFlaggedSchema    = z.tuple([zBigint, zAddr, zUint32]);
const CommentFlaggedSchema = z.tuple([zBigint, zBigint, zAddr, zUint32]);
const TipPostSentSchema    = z.tuple([zAddr, zAddr, zBigint, zBigint]);
const TipCommentSentSchema = z.tuple([zAddr, zAddr, zBigint, zBigint]);
const PollVoteCastSchema   = z.tuple([zBigint, zAddr, zUint8]);
const DbRootAnchoredSchema = z.tuple([zBigint, zB32]);

const CrowdfundLaunchedSchema     = z.tuple([zBigint, zBigint, zUint32]);
const CrowdfundContributionSchema = z.tuple([zBigint, zAddr, zBigint, zBigint]);
const CrowdfundPayoutSchema       = z.tuple([zBigint, zAddr, zBigint]);
const CrowdfundRefundSchema       = z.tuple([zBigint, zAddr, zBigint]);

let lastSentAnchorRoot: string | null = null;

// =============================================================================
// SHARED HELPERS
// =============================================================================

// Decode a bytes32 hex string to a UTF-8 label, stripping null bytes.
// Returns a safe placeholder instead of throwing when the bytes aren't
// valid UTF-8 (e.g. a malformed registerIdentity call made directly
// against the contract, bypassing the frontend's encodeBytes32String) -
// see the HARDENING note in the file header.
function b32str(hex: string): string {
  try {
    return ethers.toUtf8String(ethers.getBytes(hex).filter((b) => b !== 0));
  } catch {
    console.warn(`[Indexer] Could not decode username bytes32 as UTF-8: ${hex}. Using placeholder.`);
    return `invalid_${hex.slice(2, 10)}`;
  }
}

const tsToDate = (ts: number): Date | null =>
  ts === 0 ? null : new Date(ts * 1000);

// Assumes CIDv0 sha256 (reattaches the 0x12 0x20 multihash prefix the contracts
// strip before storing as bytes32). Mirrored by bytes32ToIpfsCid in
// frontend/src/lib/hash.ts - both sides must be updated together if the IPFS
// client ever switches to producing CIDv1.
function bytes32ToIPFS(hex: string): string {
  const digest = Buffer.from(hex.slice(2), "hex");
  const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), digest]);
  return bs58.encode(multihash);
}

// True when `hex` is a bytes32 hex string that is all zero bits (the "no CID set" sentinel).
function isZeroBytes32(hex: string): boolean {
  return hex.toLowerCase().replace(/0|x/g, "") === "";
}

// True when `cid` is a syntactically valid CIDv0 sha256 string (base58btc,
// decodes to the 0x12 0x20 multihash prefix + 32-byte digest). Off-chain
// IPFS JSON metadata (forum icon/banner, post images) is attacker-controlled
// input that ends up rendered as <img src> across the app, unlike the
// on-chain ipfs_cid which is already constrained to bytes32 - so it must be
// validated the same way ipfsCidToBytes32 validates on the frontend before
// being stored.
function isValidCidV0(cid: unknown): cid is string {
  if (typeof cid !== "string" || !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    return false;
  }
  try {
    const decoded = bs58.decode(cid);
    return decoded.length === 34 && decoded[0] === 0x12 && decoded[1] === 0x20;
  } catch {
    return false;
  }
}

interface ForumMetadata {
  name?: string;
  description?: string;
  category?: string;
  rules?: string;
  tags?: string[];
  iconCid?: string;
  bannerCid?: string;
}

interface PostMetadata {
  title?: string;
  body?: string;
  pollChoices?: string[];
  images?: string[];
}

// Keep in sync with MAX_POST_MEDIA in frontend/src/pages/CreatePostPage.tsx -
// frontend and backend are separate packages with no shared module, so this
// cap is hand-mirrored on both sides (like hash.ts's CID helpers).
const MAX_POST_MEDIA = 6;

const FORUM_CATEGORIES = new Set([
  "Technology", "Gaming", "Science", "Art", "Music", "Sports", "Finance", "General",
]);

const IPFS_FETCH_TIMEOUT_MS = 3000;

const IPFS_UNAVAILABLE_METADATA = {
  title: "[Metadata Unavailable]",
  body: "Content could not be retrieved from IPFS gateway.",
} as const;

async function fetchJsonFromIPFS<T>(cidString: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IPFS_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${IPFS_GATEWAY}${cidString}`, { signal: controller.signal });
    if (!response.ok) {
      console.error(`[IPFS] Non-200 response for ${cidString}: ${response.status}`);
      return IPFS_UNAVAILABLE_METADATA as unknown as T;
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error(`[IPFS] Failed to fetch metadata for ${cidString}:`, error);
    return IPFS_UNAVAILABLE_METADATA as unknown as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function getLastBlock(): Promise<bigint> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM indexer_state WHERE key = 'last_indexed_block'`
  );
  return BigInt(rows[0]?.value ?? "0");
}

async function saveLastBlock(client: PoolClient, blockNumber: bigint): Promise<void> {
  await client.query(
    `INSERT INTO indexer_state (key, value, updated_at)
     VALUES ('last_indexed_block', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [String(blockNumber)]
  );
}

async function ensureUser(client: PoolClient, wallet: string): Promise<void> {
  await client.query(
    `INSERT INTO users (wallet_address)
     VALUES ($1)
     ON CONFLICT (wallet_address) DO NOTHING`,
    [wallet]
  );
  await checkGenesisBadge(client, wallet);
}

// =============================================================================
// CORE EVENT HANDLERS
// =============================================================================

async function handleUserRegistered(
  client: PoolClient,
  raw: ethers.Result,
  blockTs: number,
  logIndex: number
): Promise<void> {
  const [walletRaw, usernameB32, profileCIDRaw] = UserRegisteredSchema.parse([...raw]);
  const wallet = walletRaw.toLowerCase();
  const username = b32str(usernameB32);
  const joinedAt = new Date(blockTs * 1000);
  const profileCID = isZeroBytes32(profileCIDRaw) ? null : profileCIDRaw;

  await client.query(
    `INSERT INTO users (wallet_address, username, profile_cid, joined_at, log_index)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (wallet_address)
     DO UPDATE SET
       username = EXCLUDED.username,
       profile_cid = EXCLUDED.profile_cid`,
    [wallet, username, profileCID, joinedAt, logIndex]
  );
  await checkGenesisBadge(client, wallet);
  console.log(`[UserRegistered] ${username} → ${wallet}`);
}

async function handleProfileCIDUpdated(
  client: PoolClient,
  raw: ethers.Result
): Promise<void> {
  const [walletRaw, profileCIDRaw] = ProfileCIDUpdatedSchema.parse([...raw]);
  const wallet = walletRaw.toLowerCase();
  const profileCID = isZeroBytes32(profileCIDRaw) ? null : profileCIDRaw;

  await client.query(
    `UPDATE users SET profile_cid = $1 WHERE wallet_address = $2`,
    [profileCID, wallet]
  );
  console.log(`[ProfileCIDUpdated] ${wallet}`);
}

async function handleForumCreated(
  client: PoolClient,
  raw: ethers.Result,
  blockTs: number,
  logIndex: number
): Promise<void> {
  const [forumKeyRaw, creatorRaw, minKarmaToFlag, forumCID] = ForumCreatedSchema.parse([...raw]);
  const forumKey = forumKeyRaw.toLowerCase();
  const creator = creatorRaw.toLowerCase();
  const createdAt = new Date(blockTs * 1000);

  const metadata = isZeroBytes32(forumCID)
    ? null
    : await fetchJsonFromIPFS<ForumMetadata>(bytes32ToIPFS(forumCID));

  const forumName = metadata?.name || `Forum ${forumKey.slice(0, 10)}`;
  const forumDescription = metadata?.description ?? null;
  const forumRules = metadata?.rules ?? null;
  const forumTags = (metadata?.tags ?? []).slice(0, 10);
  const forumCategory = metadata?.category && FORUM_CATEGORIES.has(metadata.category)
    ? metadata.category
    : "General";
  const iconCid = isValidCidV0(metadata?.iconCid) ? metadata.iconCid : null;
  const bannerCid = isValidCidV0(metadata?.bannerCid) ? metadata.bannerCid : null;

  await ensureUser(client, creator);
  await client.query(
    `INSERT INTO forums
       (forum_key, name, description, category, rules, tags, creator_wallet,
        min_karma_to_flag, ipfs_cid, icon_cid, banner_cid, member_count, created_at, log_index)
     VALUES ($1, $2, $3, $4::forum_category, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13)
     ON CONFLICT (forum_key) DO NOTHING`,
    [
      forumKey, forumName, forumDescription, forumCategory, forumRules, forumTags,
      creator, String(minKarmaToFlag), forumCID, iconCid, bannerCid, createdAt, logIndex,
    ]
  );
  if (forumTags.length > 0) {
    await client.query(
      `INSERT INTO forum_tags (forum_key, tag)
       SELECT $1, t FROM unnest($2::text[]) AS t
       ON CONFLICT DO NOTHING`,
      [forumKey, forumTags]
    );
  }
  await client.query(
    `INSERT INTO forum_memberships (forum_key, wallet_address, joined_at, log_index)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [forumKey, creator, createdAt, logIndex]
  );
  const { rows } = await client.query<{ forum_count: number }>(
    `UPDATE users SET forum_count = forum_count + 1
     WHERE wallet_address = $1 RETURNING forum_count`,
    [creator]
  );
  await checkForumCountBadges(client, creator, rows[0]?.forum_count ?? 1);
  console.log(`[ForumCreated] key=${forumKey} creator=${creator} name=${forumName}`);
}

async function handleMemberJoined(
  client: PoolClient,
  raw: ethers.Result,
  blockTs: number,
  logIndex: number
): Promise<void> {
  const [forumKeyRaw, memberRaw] = MemberJoinedSchema.parse([...raw]);
  const forumKey = forumKeyRaw.toLowerCase();
  const member = memberRaw.toLowerCase();
  const joinedAt = new Date(blockTs * 1000);

  await ensureUser(client, member);
  await client.query(
    `INSERT INTO forum_memberships (forum_key, wallet_address, joined_at, log_index)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [forumKey, member, joinedAt, logIndex]
  );
  const { rows } = await client.query<{ member_count: number; creator_wallet: string }>(
    `UPDATE forums SET member_count = member_count + 1
     WHERE forum_key = $1 RETURNING member_count, creator_wallet`,
    [forumKey]
  );
  if (rows.length > 0) {
    await checkForumMemberBadges(client, rows[0].creator_wallet, rows[0].member_count);
  }
  console.log(`[MemberJoined] forum=${forumKey} member=${member}`);
}

async function handleMemberLeft(client: PoolClient, raw: ethers.Result): Promise<void> {
  const [forumKeyRaw, memberRaw] = MemberLeftSchema.parse([...raw]);
  const forumKey = forumKeyRaw.toLowerCase();
  const member = memberRaw.toLowerCase();
  await client.query(
    `DELETE FROM forum_memberships WHERE forum_key = $1 AND wallet_address = $2`,
    [forumKey, member]
  );
  await client.query(
    `UPDATE forums SET member_count = GREATEST(member_count - 1, 0) WHERE forum_key = $1`,
    [forumKey]
  );
  console.log(`[MemberLeft] forum=${forumKey} member=${member}`);
}

async function handlePostCreated(
  client: PoolClient,
  raw: ethers.Result,
  blockTs: number,
  logIndex: number
): Promise<void> {
  const [postId, authorRaw, forumKeyRaw, postTypeNum, visAfter, ipfsCID] =
    PostCreatedSchema.parse([...raw]);
  const forumKey = forumKeyRaw.toLowerCase();
  const author = authorRaw.toLowerCase();

  const postTypeStr  = POST_TYPE[postTypeNum] ?? "Standard";
  const createdAt    = new Date(blockTs * 1000);
  const visibleAfter = postTypeStr === "TimeCapsule" ? tsToDate(visAfter) : null;

  const metadata = isZeroBytes32(ipfsCID)
    ? null
    : await fetchJsonFromIPFS<PostMetadata>(bytes32ToIPFS(ipfsCID));
  const title = metadata?.title ?? null;
  const body  = metadata?.body ?? null;
  const mediaCids = (Array.isArray(metadata?.images) ? metadata.images : [])
    .filter(isValidCidV0)
    .slice(0, MAX_POST_MEDIA);

  await ensureUser(client, author);
  await client.query(
    `INSERT INTO posts
       (post_id, forum_key, author_wallet, post_type, ipfs_cid, title, body, media_cids, visible_after, created_at, log_index)
     VALUES ($1, $2, $3, $4::post_type, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (post_id) DO NOTHING`,
    [String(postId), forumKey, author, postTypeStr, ipfsCID, title, body, mediaCids, visibleAfter, createdAt, logIndex]
  );
  const { rows } = await client.query<{ post_count: number }>(
    `UPDATE users SET post_count = post_count + 1
     WHERE wallet_address = $1 RETURNING post_count`,
    [author]
  );
  await client.query(
    `UPDATE forums SET post_count = post_count + 1 WHERE forum_key = $1`,
    [forumKey]
  );
  await checkPostCountBadges(client, author, rows[0]?.post_count ?? 1);
  console.log(`[PostCreated] postId=${postId} type=${postTypeStr} author=${author}`);
}

async function handlePollConfigured(client: PoolClient, raw: ethers.Result): Promise<void> {
  const [postId, optionCount, deadlineTs] = PollConfiguredSchema.parse([...raw]);
  const deadline = tsToDate(deadlineTs);
  const postIdStr = String(postId);

  await client.query(
    `UPDATE posts SET poll_option_count = $1, poll_deadline = $2 WHERE post_id = $3`,
    [optionCount, deadline, postIdStr]
  );

  const { rows } = await client.query<{ ipfs_cid: string }>(
    `SELECT ipfs_cid FROM posts WHERE post_id = $1`,
    [postIdStr]
  );
  if (rows.length > 0) {
    const metadata = isZeroBytes32(rows[0].ipfs_cid)
      ? null
      : await fetchJsonFromIPFS<PostMetadata>(bytes32ToIPFS(rows[0].ipfs_cid));
    const choices = metadata?.pollChoices ?? [];
    for (let i = 1; i <= optionCount; i++) {
      const choiceText = choices[i - 1] || `Option ${i}`;
      await client.query(
        `INSERT INTO poll_options (post_id, option_id, choice_text)
         VALUES ($1, $2, $3)
         ON CONFLICT (post_id, option_id) DO UPDATE SET choice_text = EXCLUDED.choice_text`,
        [postIdStr, i, choiceText]
      );
    }
  }
  console.log(`[PollConfigured] postId=${postId} options=${optionCount}`);
}

async function handleCommentCreated(
  client: PoolClient,
  raw: ethers.Result,
  blockTs: number,
  logIndex: number
): Promise<void> {
  const [commentId, postId, parentId, authorRaw, tier, ipfsCID] =
    CommentCreatedSchema.parse([...raw]);
  const author = authorRaw.toLowerCase();
  const createdAt = new Date(blockTs * 1000);

  const metadata = isZeroBytes32(ipfsCID)
    ? null
    : await fetchJsonFromIPFS<{ body?: string }>(bytes32ToIPFS(ipfsCID));
  const body = metadata?.body ?? null;

  await ensureUser(client, author);
  await client.query(
    `INSERT INTO comments
       (comment_id, post_id, parent_id, author_wallet, tier, ipfs_cid, body, created_at, log_index)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (comment_id) DO NOTHING`,
    [
      String(commentId),
      String(postId),
      parentId === 0n ? null : String(parentId),
      author,
      tier,
      ipfsCID,
      body,
      createdAt,
      logIndex,
    ]
  );
  const { rows: postRows } = await client.query<{ forum_key: string }>(
    `SELECT forum_key FROM posts WHERE post_id = $1`,
    [String(postId)]
  );
  if (postRows.length > 0) {
    await client.query(
      `UPDATE forums SET comment_count = comment_count + 1 WHERE forum_key = $1`,
      [postRows[0].forum_key]
    );
  }
  const { rows } = await client.query<{ comment_count: number }>(
    `UPDATE users SET comment_count = comment_count + 1
     WHERE wallet_address = $1 RETURNING comment_count`,
    [author]
  );
  await checkCommentCountBadges(client, author, rows[0]?.comment_count ?? 1);
  console.log(`[CommentCreated] commentId=${commentId} postId=${postId} tier=${tier}`);
}

async function handlePostVoted(client: PoolClient, raw: ethers.Result): Promise<void> {
  const [postId, voterRaw, direction, newKarma] = PostVotedSchema.parse([...raw]);
  const postIdStr = String(postId);
  const voter = voterRaw.toLowerCase();

  await ensureUser(client, voter);

  const { rows: beforeRows } = await client.query<{ upvotes: number }>(
    `SELECT upvotes FROM posts WHERE post_id = $1`,
    [postIdStr]
  );
  const oldUpvotes = beforeRows[0]?.upvotes ?? 0;

  await client.query(
    `INSERT INTO post_votes (post_id, voter_wallet, vote_state)
     VALUES ($1, $2, $3)
     ON CONFLICT (post_id, voter_wallet) DO UPDATE SET vote_state = EXCLUDED.vote_state`,
    [postIdStr, voter, direction]
  );
  await client.query(
    `UPDATE posts SET
    upvotes   = (SELECT COUNT(*) FROM post_votes WHERE post_id = $1 AND vote_state = 1),
    downvotes = (SELECT COUNT(*) FROM post_votes WHERE post_id = $1 AND vote_state IN (-1,-2))
    WHERE post_id = $1`,
    [postIdStr]
  );
  const { rows } = await client.query<{ author_wallet: string; upvotes: number; forum_key: string }>(
    `SELECT author_wallet, upvotes, forum_key FROM posts WHERE post_id = $1`,
    [postIdStr]
  );
  if (rows.length > 0) {
    const { author_wallet, upvotes, forum_key } = rows[0];
    const upvoteDelta = upvotes - oldUpvotes;
    if (upvoteDelta !== 0) {
      await client.query(
        `UPDATE forums SET total_upvotes = GREATEST(total_upvotes + $1, 0) WHERE forum_key = $2`,
        [upvoteDelta, forum_key]
      );
    }
    await client.query(
      `UPDATE users SET karma = $1 WHERE wallet_address = $2`,
      [String(newKarma), author_wallet]
    );
    await checkKarmaBadges(client, author_wallet, newKarma);
    await checkPostUpvoteBadges(client, author_wallet, upvotes);
  }
  console.log(`[PostVoted] postId=${postId} voter=${voter} dir=${direction}`);
}

async function handleCommentVoted(client: PoolClient, raw: ethers.Result): Promise<void> {
  const [commentId, voterRaw, direction, newKarma] = CommentVotedSchema.parse([...raw]);
  const commentIdStr = String(commentId);
  const voter = voterRaw.toLowerCase();

  await ensureUser(client, voter);

  const { rows: beforeRows } = await client.query<{ upvotes: number }>(
    `SELECT upvotes FROM comments WHERE comment_id = $1`,
    [commentIdStr]
  );
  const oldUpvotes = beforeRows[0]?.upvotes ?? 0;

  await client.query(
    `INSERT INTO comment_votes (comment_id, voter_wallet, vote_state)
    VALUES ($1, $2, $3)
     ON CONFLICT (comment_id, voter_wallet) DO UPDATE SET vote_state = EXCLUDED.vote_state`,
    [commentIdStr, voter, direction]
  );
  await client.query(
    `UPDATE comments SET
       upvotes   = (SELECT COUNT(*) FROM comment_votes WHERE comment_id = $1 AND vote_state = 1),
       downvotes = (SELECT COUNT(*) FROM comment_votes WHERE comment_id = $1 AND vote_state IN (-1,-2))
     WHERE comment_id = $1`,
    [commentIdStr]
  );
  const { rows } = await client.query<{ author_wallet: string; upvotes: number; post_id: string }>(
    `SELECT author_wallet, upvotes, post_id FROM comments WHERE comment_id = $1`,
    [commentIdStr]
  );
  if (rows.length > 0) {
    const { author_wallet, upvotes, post_id } = rows[0];
    const upvoteDelta = upvotes - oldUpvotes;
    if (upvoteDelta !== 0) {
      const { rows: postRows } = await client.query<{ forum_key: string }>(
        `SELECT forum_key FROM posts WHERE post_id = $1`,
        [post_id]
      );
      if (postRows.length > 0) {
        await client.query(
          `UPDATE forums SET total_upvotes = GREATEST(total_upvotes + $1, 0) WHERE forum_key = $2`,
          [upvoteDelta, postRows[0].forum_key]
        );
      }
    }
    await client.query(
      `UPDATE users SET karma = $1 WHERE wallet_address = $2`,
      [String(newKarma), author_wallet]
    );
    await checkKarmaBadges(client, author_wallet, newKarma);
    await checkCommentUpvoteBadges(client, author_wallet, upvotes);
  }
  console.log(`[CommentVoted] commentId=${commentId} voter=${voter} dir=${direction}`);
}

async function handlePostFlagged(client: PoolClient, raw: ethers.Result): Promise<void> {
  const [postId, flaggerRaw, newTally] = PostFlaggedSchema.parse([...raw]);
  const flagger = flaggerRaw.toLowerCase();

  await ensureUser(client, flagger);
  await client.query(
    `INSERT INTO post_flags (post_id, flagger_wallet) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [String(postId), flagger]
  );
  await client.query(
    `UPDATE posts SET flag_tally = $1 WHERE post_id = $2`,
    [newTally, String(postId)]
  );
  console.log(`[PostFlagged] postId=${postId} tally=${newTally}`);
}

async function handleCommentFlagged(client: PoolClient, raw: ethers.Result): Promise<void> {
  const [_postId, commentId, flaggerRaw, newTally] = CommentFlaggedSchema.parse([...raw]);
  const flagger = flaggerRaw.toLowerCase();

  await ensureUser(client, flagger);
  await client.query(
    `INSERT INTO comment_flags (comment_id, flagger_wallet) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [String(commentId), flagger]
  );
  await client.query(
    `UPDATE comments SET flag_tally = $1 WHERE comment_id = $2`,
    [newTally, String(commentId)]
  );
  console.log(`[CommentFlagged] commentId=${commentId} tally=${newTally}`);
}

async function handleTipPostSent(
  client: PoolClient,
  raw: ethers.Result,
  blockTs: number,
  logIndex: number,
  txHash: string
): Promise<void> {
  const [senderRaw, recipientRaw, postId, amount] = TipPostSentSchema.parse([...raw]);
  const tippedAt = new Date(blockTs * 1000);
  const sender = senderRaw.toLowerCase();
  const recipient = recipientRaw.toLowerCase();

  await ensureUser(client, sender);
  // tipDirect() reuses this same event with postId=0, so `recipient` can be
  // an address the indexer has never seen (no post/comment/registration) -
  // without this, the notifications insert below (recipient_wallet
  // REFERENCES users) would FK-violate and roll back/poison the block.
  await ensureUser(client, recipient);
  const { rows } = await client.query<{ tip_id: string }>(
    `INSERT INTO tips (sender_wallet, recipient_wallet, post_id, amount_wei, tipped_at, log_index, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tx_hash, log_index) DO NOTHING
     RETURNING tip_id`,
    [sender, recipient, postId > 0n ? String(postId) : null, String(amount), tippedAt, logIndex, txHash]
  );
  if (rows.length === 0) {
    console.log(`[TipPostSent] duplicate log (tx=${txHash} idx=${logIndex}), skipping`);
    return;
  }
  const tipId = rows[0].tip_id;
  if (postId > 0n) {
    await client.query(
      `UPDATE posts SET total_tips_wei = total_tips_wei + $1 WHERE post_id = $2`,
      [String(amount), String(postId)]
    );
  }
  await client.query(
    `INSERT INTO notifications (recipient_wallet, type, tip_id, sender_wallet, amount_wei, post_id)
     VALUES ($1, 'tip', $2, $3, $4, $5)`,
    [recipient, tipId, sender, String(amount), postId > 0n ? String(postId) : null]
  );
  console.log(`[TipPostSent] ${sender} → ${recipient} ${amount} wei (postId=${postId})`);
}

async function handleTipCommentSent(
  client: PoolClient,
  raw: ethers.Result,
  blockTs: number,
  logIndex: number,
  txHash: string
): Promise<void> {
  const [senderRaw, recipientRaw, commentId, amount] = TipCommentSentSchema.parse([...raw]);
  const tippedAt = new Date(blockTs * 1000);
  const sender = senderRaw.toLowerCase();
  const recipient = recipientRaw.toLowerCase();

  await ensureUser(client, sender);
  // Comment recipients are already covered indirectly (a comment's author is
  // ensureUser'd when the comment is created), but this is idempotent and
  // keeps this handler defensively symmetric with handleTipPostSent above.
  await ensureUser(client, recipient);
  const { rows } = await client.query<{ tip_id: string }>(
    `INSERT INTO tips (sender_wallet, recipient_wallet, comment_id, amount_wei, tipped_at, log_index, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tx_hash, log_index) DO NOTHING
     RETURNING tip_id`,
    [sender, recipient, String(commentId), String(amount), tippedAt, logIndex, txHash]
  );
  if (rows.length === 0) {
    console.log(`[TipCommentSent] duplicate log (tx=${txHash} idx=${logIndex}), skipping`);
    return;
  }
  const tipId = rows[0].tip_id;
  await client.query(
    `UPDATE comments SET total_tips_wei = total_tips_wei + $1 WHERE comment_id = $2`,
    [String(amount), String(commentId)]
  );
  await client.query(
    `INSERT INTO notifications (recipient_wallet, type, tip_id, sender_wallet, amount_wei, comment_id)
     VALUES ($1, 'tip', $2, $3, $4, $5)`,
    [recipient, tipId, sender, String(amount), String(commentId)]
  );
  console.log(`[TipCommentSent] ${sender} → ${recipient} ${amount} wei (commentId=${commentId})`);
}

// PATCH: handlePollVoteCast - previously the fresh-insert branch of this
// upsert never supplied `choice_text`, which is NOT NULL. If a poll_options
// row for (post_id, option_id) wasn't already present for any reason at
// vote time, this threw, rolled back the whole block, and permanently
// wedged the indexer (identical failure mode to the crowdfund constraint
// bug - the retry loop just kept failing on the same block forever). Now
// always supplies a fallback 'Option N' text on first insert, matching the
// same fallback handleCommentCreated/handlePollConfigured already use, so
// this constraint can never be violated regardless of event ordering.
async function handlePollVoteCast(client: PoolClient, raw: ethers.Result): Promise<void> {
  const [postId, voterRaw, optionId] = PollVoteCastSchema.parse([...raw]);
  const postIdStr = String(postId);
  const voter = voterRaw.toLowerCase();

  const { rows } = await client.query<{ option_id: number }>(
    `SELECT option_id FROM poll_votes WHERE post_id = $1 AND voter_wallet = $2`,
    [postIdStr, voter]
  );
  if (rows.length > 0 && rows[0].option_id !== optionId) {
    await client.query(
      `UPDATE poll_options SET vote_count = GREATEST(vote_count - 1, 0)
       WHERE post_id = $1 AND option_id = $2`,
      [postIdStr, rows[0].option_id]
    );
  }
  await client.query(
    `INSERT INTO poll_votes (post_id, voter_wallet, option_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (post_id, voter_wallet) DO UPDATE SET option_id = EXCLUDED.option_id`,
    [postIdStr, voter, optionId]
  );
  await client.query(
    `INSERT INTO poll_options (post_id, option_id, choice_text, vote_count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (post_id, option_id) DO UPDATE SET vote_count = poll_options.vote_count + 1`,
    [postIdStr, optionId, `Option ${optionId}`]
  );
  console.log(`[PollVoteCast] postId=${postId} voter=${voter} option=${optionId}`);
}

async function handleDatabaseRootAnchored(client: PoolClient, raw: ethers.Result): Promise<void> {
  const [blockNumber, merkleRoot] = DbRootAnchoredSchema.parse([...raw]);

  await client.query(
    `INSERT INTO merkle_anchors (block_number, merkle_root)
     VALUES ($1, $2)
     ON CONFLICT (block_number) DO UPDATE SET merkle_root = EXCLUDED.merkle_root`,
    [String(blockNumber), merkleRoot]
  );
  console.log(`[DatabaseRootAnchored] block=${blockNumber} root=${merkleRoot}`);
}

// =============================================================================
// ESCROW EVENT HANDLERS
// =============================================================================

async function handleCrowdfundLaunched(client: PoolClient, raw: ethers.Result): Promise<void> {
  const [postId, goal, deadlineTs] = CrowdfundLaunchedSchema.parse([...raw]);
  const deadline = tsToDate(deadlineTs);

  await client.query(
    `UPDATE posts SET cf_target_goal = $1, cf_deadline = $2 WHERE post_id = $3`,
    [String(goal), deadline, String(postId)]
  );
  console.log(`[CrowdfundLaunched] postId=${postId} goal=${goal}`);
}

async function handleCrowdfundContribution(
  client: PoolClient,
  raw: ethers.Result,
  blockTs: number,
  logIndex: number
): Promise<void> {
  const [postId, backerRaw, amount, total] = CrowdfundContributionSchema.parse([...raw]);
  const postIdStr = String(postId);
  const contributedAt = new Date(blockTs * 1000);
  const backer = backerRaw.toLowerCase();

  await ensureUser(client, backer);
  await client.query(
    `INSERT INTO crowdfund_contributions (post_id, backer_wallet, amount_wei, contributed_at, log_index)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (post_id, backer_wallet) DO UPDATE
       SET amount_wei = crowdfund_contributions.amount_wei + $3`,
    [postIdStr, backer, String(amount), contributedAt, logIndex]
  );
  await client.query(
    `UPDATE posts SET
       cf_funds_raised = $1,
       cf_backer_count = (SELECT COUNT(*) FROM crowdfund_contributions WHERE post_id = $2)
     WHERE post_id = $2`,
    [String(total), postIdStr]
  );
  console.log(`[CrowdfundContribution] postId=${postId} backer=${backer} total=${total}`);
}

async function handleCrowdfundPayout(client: PoolClient, raw: ethers.Result): Promise<void> {
  const [postId] = CrowdfundPayoutSchema.parse([...raw]);

  await client.query(
    `UPDATE posts SET cf_claimed = TRUE WHERE post_id = $1`,
    [String(postId)]
  );
  console.log(`[CrowdfundPayout] postId=${postId}`);
}

async function handleCrowdfundRefund(client: PoolClient, raw: ethers.Result): Promise<void> {
  const [postId, backerRaw, amount] = CrowdfundRefundSchema.parse([...raw]);
  const postIdStr = String(postId);
  const backer = backerRaw.toLowerCase();

  await client.query(
    `UPDATE crowdfund_contributions
     SET amount_wei = GREATEST(amount_wei - $1, 0)
     WHERE post_id = $2 AND backer_wallet = $3`,
    [String(amount), postIdStr, backer]
  );
  // cf_funds_raised is intentionally left untouched here - it should keep
  // showing the total raised at deadline even as individual backers refund.
  console.log(`[CrowdfundRefund] postId=${postId} backer=${backer}`);
}

// =============================================================================
// DISPATCH
// =============================================================================

/**
 * Routes one parsed Core-contract log to its event handler. Exported (rather
 * than kept module-private) so backend/test/indexer.test.ts can drive
 * individual handlers with synthetic {name, args} log descriptions and no
 * live RPC provider. In production this is called once per log from
 * processSingleBlock, already wrapped in that function's per-event SAVEPOINT.
 *
 * @param client - open transaction/savepoint connection the handler writes through
 * @param parsed - decoded log; `name` selects the handler, `args` are passed through untouched
 * @param blockTs - block timestamp (seconds) to stamp on any row the handler inserts
 * @param logIndex - log's position within the block, used for tie-breaking same-block ordering
 * @param txHash - originating transaction hash, needed by handlers that record tip provenance
 * @returns resolves once the matched handler's writes complete; unknown event names are a no-op (warning logged)
 */
export async function dispatchCoreEvent(
  client: PoolClient,
  parsed: ethers.LogDescription,
  blockTs: number,
  logIndex: number,
  txHash: string
): Promise<void> {
  const { name, args } = parsed;
  switch (name) {
    case "UserRegistered":       return handleUserRegistered(client, args, blockTs, logIndex);
    case "ProfileCIDUpdated":    return handleProfileCIDUpdated(client, args);
    case "ForumCreated":         return handleForumCreated(client, args, blockTs, logIndex);
    case "MemberJoined":         return handleMemberJoined(client, args, blockTs, logIndex);
    case "MemberLeft":           return handleMemberLeft(client, args);
    case "PostCreated":          return handlePostCreated(client, args, blockTs, logIndex);
    case "PollConfigured":       return handlePollConfigured(client, args);
    case "CommentCreated":       return handleCommentCreated(client, args, blockTs, logIndex);
    case "PostVoted":            return handlePostVoted(client, args);
    case "CommentVoted":         return handleCommentVoted(client, args);
    case "PostFlagged":          return handlePostFlagged(client, args);
    case "CommentFlagged":       return handleCommentFlagged(client, args);
    case "TipPostSent":          return handleTipPostSent(client, args, blockTs, logIndex, txHash);
    case "TipCommentSent":       return handleTipCommentSent(client, args, blockTs, logIndex, txHash);
    case "PollVoteCast":         return handlePollVoteCast(client, args);
    case "DatabaseRootAnchored": return handleDatabaseRootAnchored(client, args);
    default: console.warn(`[Core] Unknown event: ${name}`);
  }
}

/**
 * Escrow-contract counterpart to {@link dispatchCoreEvent} - same routing and test-export rationale.
 *
 * @param client - open transaction/savepoint connection the handler writes through
 * @param parsed - decoded log; `name` selects the handler, `args` are passed through untouched
 * @param blockTs - block timestamp (seconds) to stamp on any row the handler inserts
 * @param logIndex - log's position within the block, used for tie-breaking same-block ordering
 * @returns resolves once the matched handler's writes complete; unknown event names are a no-op (warning logged)
 */
export async function dispatchEscrowEvent(
  client: PoolClient,
  parsed: ethers.LogDescription,
  blockTs: number,
  logIndex: number
): Promise<void> {
  const { name, args } = parsed;
  switch (name) {
    case "CrowdfundLaunched":     return handleCrowdfundLaunched(client, args);
    case "CrowdfundContribution": return handleCrowdfundContribution(client, args, blockTs, logIndex);
    case "CrowdfundPayout":       return handleCrowdfundPayout(client, args);
    case "CrowdfundRefund":       return handleCrowdfundRefund(client, args);
    default: console.warn(`[Escrow] Unknown event: ${name}`);
  }
}

// =============================================================================
// FETCH LOGS FOR A BLOCK RANGE
// =============================================================================

type IndexedLog = ReturnType<typeof coreLogWithContract> | ReturnType<typeof escrowLogWithContract>;
function coreLogWithContract(l: ethers.Log)   { return { ...l, contract: "core" as const }; }
function escrowLogWithContract(l: ethers.Log) { return { ...l, contract: "escrow" as const }; }

// Fetches logs for [fromBlock, toBlock] in 2 range-wide getLogs calls (Core + Escrow)
// instead of one call pair per block, then only fetches block timestamps for blocks
// that actually contain a matching event - the empty blocks that dominate any long
// catch-up (offline stretch, restarted stack) cost nothing beyond the two getLogs calls.
async function fetchBlockRangeData(fromBlock: bigint, toBlock: bigint) {
  const [coreLogs, escrowLogs] = await Promise.all([
    provider.getLogs({ address: CORE_ADDR,   fromBlock: Number(fromBlock), toBlock: Number(toBlock) }),
    provider.getLogs({ address: ESCROW_ADDR, fromBlock: Number(fromBlock), toBlock: Number(toBlock) }),
  ]);
  const allLogs: IndexedLog[] = [
    ...coreLogs.map(coreLogWithContract),
    ...escrowLogs.map(escrowLogWithContract),
  ];

  const logsByBlock = new Map<number, IndexedLog[]>();
  for (const log of allLogs) {
    const arr = logsByBlock.get(log.blockNumber) ?? [];
    arr.push(log);
    logsByBlock.set(log.blockNumber, arr);
  }
  for (const arr of logsByBlock.values()) arr.sort((a, b) => a.index - b.index);

  const blocksWithEvents = [...logsByBlock.keys()];
  const blocks = await Promise.all(blocksWithEvents.map((bn) => provider.getBlock(bn)));
  const blockTsByNumber = new Map<number, number>();
  blocks.forEach((b, i) => {
    if (!b) {
      throw new Error(`RPC provider returned empty payload for block height: ${blocksWithEvents[i]}`);
    }
    blockTsByNumber.set(blocksWithEvents[i], b.timestamp);
  });

  return { logsByBlock, blockTsByNumber };
}

// =============================================================================
// PROCESS A SINGLE BLOCK
// =============================================================================

async function processSingleBlock(
  blockNumber: bigint,
  allLogs: IndexedLog[],
  blockTs: number,
  cachedLatestBlock: bigint
): Promise<void> {
  let topLevelRoot: string | null = null;

  await runInTransaction(async (client) => {
    for (const log of allLogs) {
      let eventName: string | null = null;
      // A SAVEPOINT here is required, not optional: once any query inside a
      // Postgres transaction errors, the whole transaction is marked aborted
      // and every subsequent query on it fails until a ROLLBACK - a bare
      // try/catch around dispatch would silently turn the first bad event
      // into a poison block again (see HARDENING note above), just one
      // layer up. Rolling back to a per-event savepoint undoes only that
      // event's writes and leaves the transaction usable for the rest of
      // the block.
      await client.query("SAVEPOINT event_sp");
      try {
        if (log.contract === "core") {
          const parsed = coreIface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed) {
            eventName = parsed.name;
            await dispatchCoreEvent(client, parsed, blockTs, log.index, log.transactionHash);
          }
        } else {
          const parsed = escrowIface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed) {
            eventName = parsed.name;
            await dispatchEscrowEvent(client, parsed, blockTs, log.index);
          }
        }
        await client.query("RELEASE SAVEPOINT event_sp");
      } catch (err) {
        console.error(
          `[Indexer] Error processing log at block ${blockNumber} (tx ${log.transactionHash}, index ${log.index}):`,
          err
        );
        await client.query("ROLLBACK TO SAVEPOINT event_sp");
        await client.query("RELEASE SAVEPOINT event_sp");
        await client.query(
          `INSERT INTO indexer_errors (block_number, tx_hash, event_name, error_message)
           VALUES ($1, $2, $3, $4)`,
          [Number(blockNumber), log.transactionHash, eventName, err instanceof Error ? err.message : String(err)]
        );
      }
    }

    // Rebuilding the top-level tree scans the whole DB, so only do it once caught
    // up to chain tip - during a long catch-up (offline stretch, fresh sync) every
    // intermediate block's root would be immediately stale anyway.
    if (blockNumber >= cachedLatestBlock) {
      const topTree = await buildTopLevelTree(client);
      topLevelRoot = topTree.getHexRoot();
    }

    await saveLastBlock(client, blockNumber);
  });

  // lastSentAnchorRoot is an in-process cache to skip the DB roundtrip on the
  // common case (root unchanged since the last block). The DB check below is
  // still needed on top of it: it catches the root already being anchored by
  // a previous process run (e.g. after a restart, when the in-memory cache
  // has reset to null but the chain/DB state hasn't).
  if (topLevelRoot && topLevelRoot !== lastSentAnchorRoot) {
    try {
      const { rows: lastAnchorRows } = await pool.query<{ merkle_root: string }>(
        `SELECT merkle_root FROM merkle_anchors ORDER BY block_number DESC LIMIT 1`
      );
      if (lastAnchorRows[0]?.merkle_root !== topLevelRoot) {
        const tx = await coreContractWithOracle.anchorDatabaseRoot(blockNumber, topLevelRoot);
        await tx.wait();
        lastSentAnchorRoot = topLevelRoot;
        console.log(`[Indexer] Anchored root ${topLevelRoot} for block ${blockNumber}`);
      }
    } catch (err) {
      console.error(`[Indexer] Failed to anchor database root for block ${blockNumber}:`, err);
    }
  }
}

// =============================================================================
// SEQUENTIAL SYNC LOOP
// =============================================================================

async function startSyncLoop(): Promise<void> {
  let cachedLatestBlock = 0n;
  let retryDelayMs = BASE_RETRY_DELAY_MS;
  while (true) {
    try {
      let lastBlock = await getLastBlock();
      if (lastBlock === 0n) {
        lastBlock = DEPLOYMENT_BLOCK > 0n ? DEPLOYMENT_BLOCK - 1n : 0n;
      }
      if (lastBlock >= cachedLatestBlock) {
        cachedLatestBlock = BigInt(await provider.getBlockNumber());
      }
      if (lastBlock < cachedLatestBlock) {
        const fromBlock = lastBlock + 1n;
        const toBlock = cachedLatestBlock < fromBlock + BigInt(CATCHUP_BATCH_SIZE) - 1n
          ? cachedLatestBlock
          : fromBlock + BigInt(CATCHUP_BATCH_SIZE) - 1n;

        const { logsByBlock, blockTsByNumber } = await fetchBlockRangeData(fromBlock, toBlock);

        for (let bn = fromBlock; bn <= toBlock; bn++) {
          const logsForBlock = logsByBlock.get(Number(bn)) ?? [];
          const blockTs = blockTsByNumber.get(Number(bn)) ?? 0; // unused when logsForBlock is empty
          await processSingleBlock(bn, logsForBlock, blockTs, cachedLatestBlock);
        }

        retryDelayMs = BASE_RETRY_DELAY_MS;
        if (CATCHUP_BATCH_DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, CATCHUP_BATCH_DELAY_MS));
        }
      } else {
        retryDelayMs = BASE_RETRY_DELAY_MS;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } catch (err) {
      console.error(`[Indexer] Sync error, retrying in ${retryDelayMs}ms...`, err);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("[Indexer] Starting DeReddit indexer...");
  console.log(`[Indexer] RPC:    ${RPC_URL}`);
  console.log(`[Indexer] Core:   ${CORE_ADDR}`);
  console.log(`[Indexer] Escrow: ${ESCROW_ADDR}`);

  await pool.query("SELECT 1");
  console.log("[Indexer] Database connection verified.");

  await startSyncLoop();
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    console.error("[Indexer] Fatal error:", err);
    process.exit(1);
  });
}