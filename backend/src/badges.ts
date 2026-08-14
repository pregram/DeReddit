// All functions here are designed to run INSIDE an already-open transaction
// (the caller's `client`), so awarding a badge is atomic with the event
// that triggered it. Awarding is idempotent via the (wallet_address, badge_id)
// primary key on user_badges combined with ON CONFLICT DO NOTHING.

import type { PoolClient } from "pg";

// Idempotent via ON CONFLICT DO NOTHING. Returns true only when this call is the
// one that actually inserted the row, so awardAndNotify can tell "newly earned"
// apart from "already had it" and notify exactly once per wallet+badge.
async function awardBadge(
  client: PoolClient,
  wallet: string,
  badgeKey: string
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO user_badges (wallet_address, badge_id)
     SELECT $1, bd.badge_id
     FROM badge_definitions bd
     WHERE bd.badge_key = $2
     ON CONFLICT (wallet_address, badge_id) DO NOTHING
     RETURNING wallet_address`,
    [wallet, badgeKey]
  );
  return (result.rowCount ?? 0) > 0;
}

// Unconditional insert - relies on the caller (awardAndNotify) to only invoke this
// for a newly earned badge, since this function does no earned-check itself.
async function insertBadgeNotification(
  client: PoolClient,
  wallet: string,
  badgeKey: string
): Promise<void> {
  await client.query(
    `INSERT INTO notifications (recipient_wallet, type, badge_id, badge_key, badge_name)
     SELECT $1, 'badge', bd.badge_id, bd.badge_key, bd.name
     FROM badge_definitions bd
     WHERE bd.badge_key = $2`,
    [wallet, badgeKey]
  );
}

async function awardAndNotify(
  client: PoolClient,
  wallet: string,
  badgeKey: string
): Promise<void> {
  if (await awardBadge(client, wallet, badgeKey)) {
    await insertBadgeNotification(client, wallet, badgeKey);
  }
}

/**
 * Genesis badges - awarded to the first 10 / 100 / 1000 registered users.
 * Called right after a new user row is inserted, so COUNT(*) already
 * includes the just-registered wallet. A wallet that already holds any
 * genesis badge is skipped entirely, since the tiers are mutually exclusive
 * milestones tied to registration order, not something to re-earn.
 */
export async function checkGenesisBadge(
  client: PoolClient,
  wallet: string
): Promise<void> {
  const { rows: existing } = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM user_badges ub
     JOIN badge_definitions bd ON bd.badge_id = ub.badge_id
     WHERE ub.wallet_address = $1 AND bd.category = 'genesis'`,
    [wallet]
  );
  if (parseInt(existing[0]?.count ?? "0", 10) > 0) return;

  const { rows } = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM users`
  );
  const totalUsers = parseInt(rows[0]?.count ?? "0", 10);

  if (totalUsers <= 10) await awardAndNotify(client, wallet, "genesis_10");
  else if (totalUsers <= 100) await awardAndNotify(client, wallet, "genesis_100");
  else if (totalUsers <= 1000) await awardAndNotify(client, wallet, "genesis_1000");
}

/** Karma milestone badges - awarded to the wallet when its karma crosses 10 / 100 / 1000. */
export async function checkKarmaBadges(
  client: PoolClient,
  wallet: string,
  karma: bigint
): Promise<void> {
  if (karma >= 1000n) await awardAndNotify(client, wallet, "karma_1000");
  if (karma >= 100n) await awardAndNotify(client, wallet, "karma_100");
  if (karma >= 10n) await awardAndNotify(client, wallet, "karma_10");
}

/** Post-count milestone badges - awarded to the wallet when its post count crosses 1 / 10 / 100. */
export async function checkPostCountBadges(
  client: PoolClient,
  wallet: string,
  postCount: number
): Promise<void> {
  if (postCount >= 100) await awardAndNotify(client, wallet, "post_100");
  if (postCount >= 10) await awardAndNotify(client, wallet, "post_10");
  if (postCount >= 1) await awardAndNotify(client, wallet, "post_1st");
}

/** Comment-count milestone badges - awarded to the wallet when its comment count crosses 1 / 10 / 100 / 1000. */
export async function checkCommentCountBadges(
  client: PoolClient,
  wallet: string,
  commentCount: number
): Promise<void> {
  if (commentCount >= 1000) await awardAndNotify(client, wallet, "comment_1000");
  if (commentCount >= 100) await awardAndNotify(client, wallet, "comment_100");
  if (commentCount >= 10) await awardAndNotify(client, wallet, "comment_10");
  if (commentCount >= 1) await awardAndNotify(client, wallet, "comment_1st");
}

/** Forum-count milestone badges - awarded to the wallet when its forum count crosses 1 / 10. */
export async function checkForumCountBadges(
  client: PoolClient,
  wallet: string,
  forumCount: number
): Promise<void> {
  if (forumCount >= 10) await awardAndNotify(client, wallet, "forum_10");
  if (forumCount >= 1) await awardAndNotify(client, wallet, "forum_1st");
}

/**
 * Post-upvote milestone badges - awarded to the post's author when one of
 * their posts reaches 10 / 100 / 1000 upvotes.
 */
export async function checkPostUpvoteBadges(
  client: PoolClient,
  authorWallet: string,
  upvotes: number
): Promise<void> {
  if (upvotes >= 1000) await awardAndNotify(client, authorWallet, "post_upvotes_1000");
  if (upvotes >= 100) await awardAndNotify(client, authorWallet, "post_upvotes_100");
  if (upvotes >= 10) await awardAndNotify(client, authorWallet, "post_upvotes_10");
}

/**
 * Comment-upvote milestone badges - awarded to the comment's author when
 * one of their comments reaches 10 / 100 / 1000 upvotes.
 */
export async function checkCommentUpvoteBadges(
  client: PoolClient,
  authorWallet: string,
  upvotes: number
): Promise<void> {
  if (upvotes >= 1000) await awardAndNotify(client, authorWallet, "comment_upvotes_1000");
  if (upvotes >= 100) await awardAndNotify(client, authorWallet, "comment_upvotes_100");
  if (upvotes >= 10) await awardAndNotify(client, authorWallet, "comment_upvotes_10");
}

/**
 * Forum member-count milestone badges - awarded to the forum's creator
 * when their forum reaches 10 / 100 / 1000 / 10000 members.
 */
export async function checkForumMemberBadges(
  client: PoolClient,
  creatorWallet: string,
  memberCount: number
): Promise<void> {
  if (memberCount >= 10000) await awardAndNotify(client, creatorWallet, "forum_members_10000");
  if (memberCount >= 1000) await awardAndNotify(client, creatorWallet, "forum_members_1000");
  if (memberCount >= 100) await awardAndNotify(client, creatorWallet, "forum_members_100");
  if (memberCount >= 10) await awardAndNotify(client, creatorWallet, "forum_members_10");
}