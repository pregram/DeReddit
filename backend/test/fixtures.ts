// Shared fixture helpers for the API (Supertest) test files - inserts rows
// directly via SQL rather than through the indexer, since these tests are
// about the REST API's own filtering/pagination/visibility contract, not
// event ingestion (that's indexer.test.ts's job).
import { ethers } from "ethers";
import pool from "../src/db.js";

export function fakeAddr(seed: string): string {
  return ethers.getAddress(ethers.keccak256(ethers.toUtf8Bytes(seed)).slice(0, 42)).toLowerCase();
}

export function fakeB32(seed: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(seed));
}

export async function insertUser(wallet: string, overrides: Partial<{ username: string; karma: number }> = {}) {
  await pool.query(
    `INSERT INTO users (wallet_address, username, karma) VALUES ($1, $2, $3)
     ON CONFLICT (wallet_address) DO UPDATE SET username = EXCLUDED.username, karma = EXCLUDED.karma`,
    [wallet, overrides.username ?? null, overrides.karma ?? 0]
  );
}

export async function insertForum(
  forumKey: string,
  creatorWallet: string,
  overrides: Partial<{
    name: string;
    category: string;
    tags: string[];
    memberCount: number;
    postCount: number;
    commentCount: number;
    totalUpvotes: number;
  }> = {}
) {
  await pool.query(
    `INSERT INTO forums
       (forum_key, name, description, category, tags, creator_wallet, ipfs_cid,
        member_count, post_count, comment_count, total_upvotes)
     VALUES ($1, $2, $3, $4::forum_category, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (forum_key) DO NOTHING`,
    [
      forumKey,
      overrides.name ?? `Forum ${forumKey.slice(0, 8)}`,
      "a test forum",
      overrides.category ?? "General",
      overrides.tags ?? [],
      creatorWallet,
      fakeB32("forum-cid"),
      overrides.memberCount ?? 1,
      overrides.postCount ?? 0,
      overrides.commentCount ?? 0,
      overrides.totalUpvotes ?? 0,
    ]
  );
  if (overrides.tags && overrides.tags.length > 0) {
    await pool.query(
      `INSERT INTO forum_tags (forum_key, tag) SELECT $1, t FROM unnest($2::text[]) AS t ON CONFLICT DO NOTHING`,
      [forumKey, overrides.tags]
    );
  }
}

export async function insertPost(
  postId: bigint | number,
  forumKey: string,
  authorWallet: string,
  overrides: Partial<{
    postType: "Standard" | "TimeCapsule" | "Poll" | "Crowdfund";
    title: string;
    body: string;
    visibleAfter: Date | null;
    upvotes: number;
    pollOptionCount: number | null;
    cfTargetGoal: string | null;
  }> = {}
) {
  await pool.query(
    `INSERT INTO posts
       (post_id, forum_key, author_wallet, post_type, ipfs_cid, title, body,
        visible_after, upvotes, poll_option_count, cf_target_goal)
     VALUES ($1, $2, $3, $4::post_type, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (post_id) DO NOTHING`,
    [
      String(postId),
      forumKey,
      authorWallet,
      overrides.postType ?? "Standard",
      fakeB32("post-cid"),
      overrides.title ?? `Post ${postId}`,
      overrides.body ?? "body text",
      overrides.visibleAfter ?? null,
      overrides.upvotes ?? 0,
      overrides.pollOptionCount ?? null,
      overrides.cfTargetGoal ?? null,
    ]
  );
}

export async function insertNotification(
  recipientWallet: string,
  overrides: Partial<{
    type: "tip" | "badge";
    senderWallet: string | null;
    amountWei: string | null;
    badgeKey: string | null;
    badgeName: string | null;
    readAt: Date | null;
  }> = {}
) {
  await pool.query(
    `INSERT INTO notifications (recipient_wallet, type, sender_wallet, amount_wei, badge_key, badge_name, read_at)
     VALUES ($1, $2::notification_type, $3, $4, $5, $6, $7)`,
    [
      recipientWallet,
      overrides.type ?? "badge",
      overrides.senderWallet ?? null,
      overrides.amountWei ?? null,
      overrides.badgeKey ?? "genesis_10",
      overrides.badgeName ?? "Genesis Pioneer",
      overrides.readAt ?? null,
    ]
  );
}
