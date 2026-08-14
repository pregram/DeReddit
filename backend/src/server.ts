// See DEVELOPER_GUIDE.md for the API's overall architecture (routes, Merkle
// audit delegation, UNCONFIGURED_FILTER, TimeCapsule gating, notification auth).
//
// Local mechanics worth knowing:
//  - Forum browse/recommendation queries read the v_forums_by_score view
//    instead of stored columns, since the indexer no longer hand-maintains
//    engagement_ratio/velocity_score on every mutating event.
//  - All entity IDs are handled as string-serialised bigints - no parseInt().
//  - "Configured" for Poll/Crowdfund posts is inferred from existing columns
//    (poll_option_count > 0, cf_target_goal IS NOT NULL) rather than a new DB
//    field, mirroring how the Solidity contract itself treats
//    pollOptionCount==0 / no launched campaign as "not yet usable".

import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import type { ParsedQs } from "qs";
import cors from "cors";
import { ethers } from "ethers";
import pool from "./db.js";
import { getPostAuditProof, getCommentAuditProof, getForumAuditProof } from "./merkle.js";

const app  = express();
const PORT = parseInt(process.env.API_PORT ?? "3001", 10);

app.use(cors());
app.use(express.json());

// =============================================================================
// HELPERS
// =============================================================================

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

// Express types req.params/req.query values as possibly an array or a
// nested ParsedQs object (repeated query keys, e.g. ?tag=a&tag=b) - narrow
// down to the single string every route handler here actually expects.
function getSingleParam(value: string | string[] | ParsedQs | (string | ParsedQs)[] | undefined): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

// Parses ?page=/?limit= into safe, in-range integers - falls back to the
// given default instead of propagating NaN into a SQL LIMIT/OFFSET (e.g. ?page=abc).
function parsePageLimit(page: string | undefined, limit: string | undefined, defaultLimit = 20, maxLimit = 100) {
  const pageNum = Math.max(1, Number.isFinite(Number(page)) && page ? Number(page) : 1);
  const limitNum = Math.min(maxLimit, Math.max(1, Number.isFinite(Number(limit)) && limit ? Number(limit) : defaultLimit));
  const offset = (pageNum - 1) * limitNum;
  return { pageNum, limitNum, offset };
}

// SQL fragment excluding Poll/Crowdfund posts that haven't finished on-chain
// configuration yet. Applied only to the general feed query - direct-by-ID
// lookups (GET /api/posts/:postId) intentionally skip this so the author
// (or anyone with the direct link, e.g. right after creation) can still see
// and finish setting the post up.
const UNCONFIGURED_FILTER = `
  AND NOT (p.post_type = 'Poll' AND (p.poll_option_count IS NULL OR p.poll_option_count = 0))
  AND NOT (p.post_type = 'Crowdfund' AND p.cf_target_goal IS NULL)
`;

// How much the viewer ($2 = userWallet) has personally tipped a given
// post/comment - shared by every query that embeds a per-item
// "user_tipped_wei" column, backed by idx_tips_post_sender/idx_tips_comment_sender.
const USER_TIPPED_POST_SUBQUERY =
  `(SELECT COALESCE(SUM(t.amount_wei), 0)::text FROM tips t WHERE t.post_id = p.post_id AND t.sender_wallet = $2)`;
const USER_TIPPED_COMMENT_SUBQUERY =
  `(SELECT COALESCE(SUM(t.amount_wei), 0)::text FROM tips t WHERE t.comment_id = c.comment_id AND t.sender_wallet = $2)`;

// =============================================================================
// HEALTH
// =============================================================================

app.get("/health", async (_req: Request, res: Response) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: "db_unavailable" });
  }
});

// =============================================================================
// USERS
// =============================================================================

app.get("/api/users/:wallet", async (req: Request, res: Response) => {
  const wallet = getSingleParam(req.params.wallet)?.toLowerCase();
  if (!wallet) return sendError(res, 400, "Wallet is required");
  try {
    const { rows: userRows } = await pool.query(
      `SELECT wallet_address, username, karma, profile_cid,
              joined_at, post_count, comment_count, forum_count
       FROM users WHERE wallet_address = $1`,
      [wallet]
    );
    if (userRows.length === 0) return sendError(res, 404, "User not found");
    const { rows: tipRows } = await pool.query(
      `SELECT
         (SELECT COALESCE(SUM(amount_wei), 0)::text FROM tips WHERE recipient_wallet = $1) AS total_tips_received_wei,
         (SELECT COALESCE(SUM(amount_wei), 0)::text FROM tips WHERE sender_wallet = $1)    AS total_tips_given_wei`,
      [wallet]
    );
    const { rows: badgeRows } = await pool.query(
      `SELECT bd.badge_key, bd.name, bd.description, bd.category, ub.awarded_at
       FROM user_badges ub
       JOIN badge_definitions bd ON bd.badge_id = ub.badge_id
       WHERE ub.wallet_address = $1 ORDER BY ub.awarded_at ASC`,
      [wallet]
    );

    const { rows: forumRows } = await pool.query(
      `SELECT f.forum_key, f.name, f.category, f.member_count, fm.joined_at
       FROM forum_memberships fm
       JOIN forums f ON f.forum_key = fm.forum_key
       WHERE fm.wallet_address = $1 ORDER BY fm.joined_at DESC, fm.log_index DESC`,
      [wallet]
    );

    res.json({ user: { ...userRows[0], ...tipRows[0] }, badges: badgeRows, forums: forumRows });
  } catch (err) {
    console.error("[GET /users/:wallet]", err);
    sendError(res, 500, "Internal server error");
  }
});

app.get("/api/users/:wallet/posts", async (req: Request, res: Response) => {
  const wallet = getSingleParam(req.params.wallet)?.toLowerCase();
  if (!wallet) return sendError(res, 400, "Wallet is required");
  try {
    const { rows } = await pool.query(
      `SELECT p.post_id, p.forum_key, f.name AS forum_name, p.post_type,
              CASE WHEN p.post_type = 'TimeCapsule' AND p.visible_after > NOW() THEN NULL ELSE p.title END AS title,
              p.upvotes, p.downvotes, p.visible_after, p.created_at
       FROM posts p JOIN forums f ON f.forum_key = p.forum_key
       WHERE p.author_wallet = $1
       ORDER BY p.created_at DESC, p.log_index DESC
       LIMIT 50`,
      [wallet]
    );
    res.json({ posts: rows });
  } catch (err) {
    console.error("[GET /users/:wallet/posts]", err);
    sendError(res, 500, "Internal server error");
  }
});

app.get("/api/users/:wallet/comments", async (req: Request, res: Response) => {
  const wallet = getSingleParam(req.params.wallet)?.toLowerCase();
  if (!wallet) return sendError(res, 400, "Wallet is required");
  try {
    const { rows } = await pool.query(
      `SELECT c.comment_id, c.post_id, c.tier, c.body, c.upvotes, c.downvotes, c.created_at,
              CASE WHEN p.post_type = 'TimeCapsule' AND p.visible_after > NOW() THEN NULL ELSE p.title END AS post_title,
              p.forum_key
       FROM comments c JOIN posts p ON p.post_id = c.post_id
       WHERE c.author_wallet = $1
       ORDER BY c.created_at DESC, c.log_index DESC
       LIMIT 50`,
      [wallet]
    );
    res.json({ comments: rows });
  } catch (err) {
    console.error("[GET /users/:wallet/comments]", err);
    sendError(res, 500, "Internal server error");
  }
});

app.get("/api/users/:wallet/contributions", async (req: Request, res: Response) => {
  const wallet = getSingleParam(req.params.wallet)?.toLowerCase();
  if (!wallet) return sendError(res, 400, "Wallet is required");
  try {
    const { rows } = await pool.query(
      `SELECT cc.post_id, cc.amount_wei, cc.contributed_at,
              p.title AS post_title, p.forum_key, p.cf_target_goal, p.cf_funds_raised,
              p.cf_deadline, p.cf_claimed
       FROM crowdfund_contributions cc JOIN posts p ON p.post_id = cc.post_id
       WHERE cc.backer_wallet = $1
       ORDER BY cc.contributed_at DESC
       LIMIT 50`,
      [wallet]
    );
    res.json({ contributions: rows });
  } catch (err) {
    console.error("[GET /users/:wallet/contributions]", err);
    sendError(res, 500, "Internal server error");
  }
});

// How much ETH the ?from= wallet has personally tipped to :wallet (direct +
// post + comment tips combined) - viewer-specific, not an all-senders total.
// Returns "0" (not an error) when ?from= is missing/not a real address, since
// the viewer may simply not be connected yet.
app.get("/api/users/:wallet/tips-received", async (req: Request, res: Response) => {
  const wallet = getSingleParam(req.params.wallet)?.toLowerCase();
  const from = getSingleParam(req.query.from)?.toLowerCase();
  if (!wallet) return sendError(res, 400, "Wallet is required");
  if (!from) return res.json({ totalWei: "0" });
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount_wei), 0)::text AS total_wei
       FROM tips
       WHERE recipient_wallet = $1 AND sender_wallet = $2`,
      [wallet, from]
    );
    res.json({ totalWei: rows[0].total_wei as string });
  } catch (err) {
    console.error("[GET /users/:wallet/tips-received]", err);
    sendError(res, 500, "Internal server error");
  }
});

// =============================================================================
// FORUMS
// =============================================================================
app.get("/api/forums", async (req: Request, res: Response) => {
  const search = getSingleParam(req.query.search);
  const category = getSingleParam(req.query.category);
  const tag = getSingleParam(req.query.tag);
  const sort = getSingleParam(req.query.sort) ?? "score";
  const { limitNum, offset } = parsePageLimit(getSingleParam(req.query.page), getSingleParam(req.query.limit));

  const params: unknown[] = [];
  const conditions: string[] = [];

  if (search) {
    params.push(search);
    conditions.push(`v.name ILIKE '%' || $${params.length} || '%'`);
  }
  if (category) {
    params.push(category);
    conditions.push(`v.category = $${params.length}::forum_category`);
  }
  if (tag) {
    // Partial/case-insensitive match (e.g. "a" or "ab" matches a forum
    // tagged "ABC") rather than exact array-element overlap, so tag search
    // behaves like the existing forum-name search above.
    const tagPatterns = tag.split(",").map((t) => `%${t.trim()}%`);
    params.push(tagPatterns);
    conditions.push(`EXISTS (SELECT 1 FROM unnest(v.tags) t WHERE t ILIKE ANY($${params.length}::text[]))`);
  }
  const tagsParam = getSingleParam(req.query.tags);
  if (tagsParam) {
    // Multi-tag pill filter (Discover page): AND logic, exact
    // (case-insensitive) match per tag - a forum must carry every selected
    // chip, unlike the OR/substring `tag` param above.
    const tagList = tagsParam.split(",").map((t) => t.trim()).filter(Boolean);
    for (const t of tagList) {
      params.push(t);
      conditions.push(`EXISTS (SELECT 1 FROM unnest(v.tags) tg WHERE tg ILIKE $${params.length})`);
    }
  }

  const WHERE = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const ORDER_MAP: Record<string, string> = {
    score:   "v.forum_popularity_score DESC NULLS LAST",
    members: "v.member_count DESC",
    newest:  "v.created_at DESC",
  };
  const ORDER = ORDER_MAP[sort ?? "score"] ?? ORDER_MAP["score"];
  params.push(limitNum, offset);
  try {
    const { rows } = await pool.query(
      `SELECT forum_key, name, description, category, tags,
              creator_wallet, icon_cid, banner_cid, member_count, post_count, comment_count,
              created_at, forum_popularity_score
       FROM v_forums_by_score v ${WHERE}
       ORDER BY ${ORDER}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ forums: rows, count: rows.length });
  } catch (err) {
    console.error("[GET /forums]", err);
    sendError(res, 500, "Internal server error");
  }
});

// Distinct tags (across ALL forums, not just the current page/view) matching
// a substring - backs the tag-search suggestions dropdown on the Discover
// page. Case-insensitive, ordered by how many forums use the tag.
app.get("/api/forums/tags", async (req: Request, res: Response) => {
  const q = getSingleParam(req.query.q) ?? "";
  try {
    const { rows } = await pool.query<{ tag: string }>(
      `SELECT tag, COUNT(*) AS cnt
       FROM forum_tags
       WHERE tag ILIKE '%' || $1 || '%'
       GROUP BY tag
       ORDER BY cnt DESC, tag ASC
       LIMIT 20`,
      [q]
    );
    res.json({ tags: rows.map((r) => r.tag) });
  } catch (err) {
    console.error("[GET /forums/tags]", err);
    sendError(res, 500, "Internal server error");
  }
});

// Two independent lists: byScore is the global top-forums ranking (always
// returned), byTagOverlap is personalized to the caller's own forums' tags
// and only computed when a wallet is given and has memberships to draw tags
// from - forums the wallet already belongs to are excluded from that list.
app.get("/api/forums/recommended", async (req: Request, res: Response) => {
  const wallet = getSingleParam(req.query.wallet)?.toLowerCase();
  let client;
  try {
    client = await pool.connect();
    const { rows: byScore } = await client.query(
      `SELECT forum_key, name, description, category, tags,
              creator_wallet, icon_cid, banner_cid, member_count, post_count, comment_count,
              created_at, forum_popularity_score
       FROM v_forums_by_score LIMIT 10`
    );

    let byTagOverlap: unknown[] = [];
    if (wallet) {
      const { rows: tagRows } = await client.query<{ tags: string[] }>(
        `SELECT f.tags FROM forums f
         JOIN forum_memberships fm ON fm.forum_key = f.forum_key
         WHERE fm.wallet_address = $1`,
        [wallet]
      );
      const userTags = [...new Set(tagRows.flatMap((r) => r.tags))];
      if (userTags.length > 0) {
        const { rows } = await client.query(
          `SELECT f.forum_key, f.name, f.category, f.member_count, f.tags,
                  f.icon_cid, f.banner_cid,
                  (SELECT count(*)::int FROM unnest(f.tags) t WHERE t = ANY($1)) AS overlap_count
           FROM forums f
           WHERE NOT EXISTS (
             SELECT 1 FROM forum_memberships fm
             WHERE fm.forum_key = f.forum_key AND fm.wallet_address = $2
           )
           AND f.tags && $1::text[]
           ORDER BY overlap_count DESC, f.member_count DESC
           LIMIT 10`,
          [userTags, wallet]
        );
        byTagOverlap = rows;
      }
    }

    res.json({ byScore, byTagOverlap });
  } catch (err) {
    console.error("[GET /forums/recommended]", err);
    sendError(res, 500, "Internal server error");
  } finally {
    if (client) client.release();
  }
});

app.get("/api/forums/:forumKey", async (req: Request, res: Response) => {
  const forumKey = getSingleParam(req.params.forumKey)?.toLowerCase();
  const wallet = getSingleParam(req.query.wallet)?.toLowerCase() ?? null;
  if (!forumKey) return sendError(res, 400, "Forum key is required");
  try {
    const { rows } = await pool.query(
      `SELECT f.*, u.username AS creator_username, u.profile_cid AS creator_profile_cid,
              (fm.wallet_address IS NOT NULL) AS is_member
       FROM forums f
       JOIN users u ON u.wallet_address = f.creator_wallet
       LEFT JOIN forum_memberships fm ON fm.forum_key = f.forum_key AND fm.wallet_address = $2
       WHERE f.forum_key = $1`,
      [forumKey, wallet]
    );
    if (rows.length === 0) return sendError(res, 404, "Forum not found");
    res.json(rows[0]);
  } catch (err) {
    console.error("[GET /forums/:forumKey]", err);
    sendError(res, 500, "Internal server error");
  }
});

// =============================================================================
// POSTS
// =============================================================================

// NOTE: unconfigured Poll/Crowdfund posts are excluded here via
// UNCONFIGURED_FILTER. ?userWallet= is now optional here too - embeds each
// post's user_vote via LEFT JOIN so the feed can render vote buttons
// directly on the card without opening the post detail page.
app.get("/api/forums/:forumKey/posts", async (req: Request, res: Response) => {
  const forumKey = getSingleParam(req.params.forumKey)?.toLowerCase();
  const userWallet = getSingleParam(req.query.userWallet)?.toLowerCase() ?? null;
  const {
    type,
    title,
    sort    = "newest",
    page,
    limit,
  } = req.query as Record<string, string | undefined>;

  const { limitNum, offset } = parsePageLimit(page, limit);

  try {
    const params: unknown[] = [forumKey, userWallet];
    const conditions = ["p.forum_key = $1"];

    if (type) {
      params.push(type);
      conditions.push(`p.post_type = $${params.length}::post_type`);
    }
    if (title) {
      params.push(title);
      conditions.push(`p.title ILIKE '%' || $${params.length} || '%'`);
    }

    const ORDER_MAP: Record<string, string> = {
      top:      "p.upvotes DESC, p.created_at DESC, p.log_index DESC",
      deadline: "COALESCE(p.poll_deadline, p.cf_deadline) ASC NULLS LAST",
      newest:   "p.created_at DESC, p.log_index DESC",
    };
    const ORDER = ORDER_MAP[sort ?? "newest"] ?? ORDER_MAP["newest"];

    params.push(limitNum, offset);
    const { rows: posts } = await pool.query(
      `SELECT p.post_id, p.post_type,
              CASE WHEN p.post_type = 'TimeCapsule' AND p.visible_after > NOW() AND p.author_wallet IS DISTINCT FROM $2
                   THEN NULL ELSE p.ipfs_cid END AS ipfs_cid,
              CASE WHEN p.post_type = 'TimeCapsule' AND p.visible_after > NOW() AND p.author_wallet IS DISTINCT FROM $2
                   THEN NULL ELSE p.title END AS title,
              CASE WHEN p.post_type = 'TimeCapsule' AND p.visible_after > NOW() AND p.author_wallet IS DISTINCT FROM $2
                   THEN NULL ELSE p.body END AS body,
              CASE WHEN p.post_type = 'TimeCapsule' AND p.visible_after > NOW() AND p.author_wallet IS DISTINCT FROM $2
                   THEN NULL ELSE p.media_cids END AS media_cids,
              p.upvotes, p.downvotes, p.flag_tally, p.visible_after,
              p.poll_option_count, p.poll_deadline,
              p.cf_target_goal, p.cf_funds_raised, p.cf_deadline,
              p.cf_claimed, p.cf_backer_count, p.total_tips_wei,
              p.created_at, p.log_index,
              u.username AS author_username, p.author_wallet, u.profile_cid AS author_profile_cid,
              COALESCE(pv.vote_state, 0) AS user_vote,
              (pf.flagger_wallet IS NOT NULL) AS user_flagged,
              ${USER_TIPPED_POST_SUBQUERY} AS user_tipped_wei,
              (SELECT json_agg(json_build_object('option_id', po.option_id, 'choice_text', po.choice_text, 'vote_count', po.vote_count) ORDER BY po.option_id)
               FROM poll_options po WHERE po.post_id = p.post_id) AS poll_options
       FROM posts p
       JOIN users u ON u.wallet_address = p.author_wallet
       LEFT JOIN post_votes pv ON pv.post_id = p.post_id AND pv.voter_wallet = $2
       LEFT JOIN post_flags pf ON pf.post_id = p.post_id AND pf.flagger_wallet = $2
       WHERE ${conditions.join(" AND ")}
       ${UNCONFIGURED_FILTER}
       ORDER BY ${ORDER}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ posts, count: posts.length });
  } catch (err) {
    console.error("[GET /forums/:forumKey/posts]", err);
    sendError(res, 500, "Internal server error");
  }
});

// ?userWallet= is optional. Embeds the caller's prior post vote, poll
// choice, and crowdfund contribution via LEFT JOINs - no per-item calls.
// Intentionally NOT subject to UNCONFIGURED_FILTER: the author (and anyone
// with the direct link) must still be able to reach an unconfigured post to
// finish setting it up.
app.get("/api/posts/:postId", async (req: Request, res: Response) => {
  const postIdStr = getSingleParam(req.params.postId);
  const userWallet = getSingleParam(req.query.userWallet)?.toLowerCase() ?? null;
  if (!postIdStr) return sendError(res, 400, "Post id is required");
  try {
    const { rows: postRows } = await pool.query(
      `SELECT p.post_id, p.forum_key, p.author_wallet, p.post_type,
              CASE WHEN p.post_type = 'TimeCapsule' AND p.visible_after > NOW() AND p.author_wallet IS DISTINCT FROM $2
                   THEN NULL ELSE p.ipfs_cid END AS ipfs_cid,
              CASE WHEN p.post_type = 'TimeCapsule' AND p.visible_after > NOW() AND p.author_wallet IS DISTINCT FROM $2
                   THEN NULL ELSE p.title END AS title,
              CASE WHEN p.post_type = 'TimeCapsule' AND p.visible_after > NOW() AND p.author_wallet IS DISTINCT FROM $2
                   THEN NULL ELSE p.body END AS body,
              CASE WHEN p.post_type = 'TimeCapsule' AND p.visible_after > NOW() AND p.author_wallet IS DISTINCT FROM $2
                   THEN NULL ELSE p.media_cids END AS media_cids,
              p.upvotes, p.downvotes, p.flag_tally, p.visible_after, p.created_at, p.log_index,
              p.poll_option_count, p.poll_deadline,
              p.cf_target_goal, p.cf_funds_raised, p.cf_deadline, p.cf_claimed, p.cf_backer_count,
              p.total_tips_wei,
              u.username AS author_username, u.profile_cid AS author_profile_cid,
              COALESCE(pv.vote_state, 0) AS user_vote,
              (pf.flagger_wallet IS NOT NULL) AS user_flagged,
              (fm.wallet_address IS NOT NULL) AS is_member,
              pollv.option_id AS user_poll_option,
              cc.amount_wei AS user_contribution_wei,
              ${USER_TIPPED_POST_SUBQUERY} AS user_tipped_wei
       FROM posts p
       JOIN users u ON u.wallet_address = p.author_wallet
       LEFT JOIN post_votes pv ON pv.post_id = p.post_id AND pv.voter_wallet = $2
       LEFT JOIN post_flags pf ON pf.post_id = p.post_id AND pf.flagger_wallet = $2
       LEFT JOIN forum_memberships fm ON fm.forum_key = p.forum_key AND fm.wallet_address = $2
       LEFT JOIN poll_votes pollv ON pollv.post_id = p.post_id AND pollv.voter_wallet = $2
       LEFT JOIN crowdfund_contributions cc ON cc.post_id = p.post_id AND cc.backer_wallet = $2
       WHERE p.post_id = $1`,
      [postIdStr, userWallet]
    );
    if (postRows.length === 0) return sendError(res, 404, "Post not found");
    const post = postRows[0];

    const userPollOption: number | null = post.user_poll_option ?? null;
    const userContributionWei: string | null = post.user_contribution_wei ?? null;
    delete post.user_poll_option;
    delete post.user_contribution_wei;

    let pollOptions: unknown[] = [];
    if (post.post_type === "Poll") {
      const { rows } = await pool.query(
        `SELECT option_id, choice_text, vote_count
         FROM poll_options WHERE post_id = $1 ORDER BY option_id`,
        [postIdStr]
      );
      pollOptions = rows;
    }

    res.json({ post, pollOptions, userPollOption, userContributionWei });
  } catch (err) {
    console.error("[GET /posts/:postId]", err);
    sendError(res, 500, "Internal server error");
  }
});

// =============================================================================
// COMMENTS
// =============================================================================

// Paginated by root (tier-1) comment, not raw row count, so a page
// boundary never splits a thread and orphans a reply - each page's roots
// always come back with their *complete* descendant subtree (bounded to a
// fixed 3-level lookup since MAX_TIER = 3 in the contract/schema, so no
// recursive CTE is needed).
app.get("/api/posts/:postId/comments", async (req: Request, res: Response) => {
  const postIdStr = getSingleParam(req.params.postId);
  const userWallet = getSingleParam(req.query.userWallet)?.toLowerCase() ?? null;
  const { limitNum, offset } = parsePageLimit(getSingleParam(req.query.page), getSingleParam(req.query.limit));
  if (!postIdStr) return sendError(res, 400, "Post id is required");
  try {
    const { rows: rootRows } = await pool.query<{ comment_id: string }>(
      `SELECT comment_id FROM comments
       WHERE post_id = $1 AND parent_id IS NULL
       ORDER BY created_at ASC, log_index ASC
       LIMIT $2 OFFSET $3`,
      [postIdStr, limitNum, offset]
    );
    const rootIds = rootRows.map((r) => r.comment_id);

    let comments: unknown[] = [];
    if (rootIds.length > 0) {
      const { rows } = await pool.query(
        `SELECT c.comment_id, c.parent_id, c.tier, c.ipfs_cid, c.body,
                c.upvotes, c.downvotes, c.flag_tally, c.total_tips_wei,
                c.created_at, c.log_index,
                u.username AS author_username, c.author_wallet, u.profile_cid AS author_profile_cid,
                COALESCE(cv.vote_state, 0) AS user_vote,
                (cf.flagger_wallet IS NOT NULL) AS user_flagged,
                ${USER_TIPPED_COMMENT_SUBQUERY} AS user_tipped_wei
         FROM comments c
         JOIN users u ON u.wallet_address = c.author_wallet
         LEFT JOIN comment_votes cv ON cv.comment_id = c.comment_id AND cv.voter_wallet = $2
         LEFT JOIN comment_flags cf ON cf.comment_id = c.comment_id AND cf.flagger_wallet = $2
         WHERE c.post_id = $1
           AND (
             c.comment_id = ANY($3::numeric[])
             OR c.parent_id = ANY($3::numeric[])
             OR c.parent_id IN (SELECT comment_id FROM comments WHERE parent_id = ANY($3::numeric[]))
           )
         ORDER BY c.tier ASC, c.created_at ASC, c.log_index ASC`,
        [postIdStr, userWallet, rootIds]
      );
      comments = rows;
    }

    res.json({ comments, count: comments.length, hasMore: rootIds.length === limitNum });
  } catch (err) {
    console.error("[GET /posts/:postId/comments]", err);
    sendError(res, 500, "Internal server error");
  }
});

// =============================================================================
// AUDIT ENDPOINTS - multi-tree proofs, delegated to merkle.ts.
// Response shape is unchanged ({root, proof, leaf}) so the frontend's
// verification logic doesn't need to know or care that the proof now spans
// two tree levels for posts/comments.
// =============================================================================

app.get("/api/audit/posts/:postId", async (req: Request, res: Response) => {
  const postIdStr = getSingleParam(req.params.postId);
  if (!postIdStr) return sendError(res, 400, "Post id is required");
  const client = await pool.connect();
  try {
    const result = await getPostAuditProof(client, postIdStr);
    if (!result) return sendError(res, 404, "Post not found");
    res.json(result);
  } catch (err) {
    console.error("[GET /audit/posts/:postId]", err);
    sendError(res, 500, "Internal server error");
  } finally {
    client.release();
  }
});

app.get("/api/audit/comments/:commentId", async (req: Request, res: Response) => {
  const commentIdStr = getSingleParam(req.params.commentId);
  if (!commentIdStr) return sendError(res, 400, "Comment id is required");
  const client = await pool.connect();
  try {
    const result = await getCommentAuditProof(client, commentIdStr);
    if (!result) return sendError(res, 404, "Comment not found");
    res.json(result);
  } catch (err) {
    console.error("[GET /audit/comments/:commentId]", err);
    sendError(res, 500, "Internal server error");
  } finally {
    client.release();
  }
});

app.get("/api/audit/forums/:forumKey", async (req: Request, res: Response) => {
  const forumKey = getSingleParam(req.params.forumKey)?.toLowerCase();
  if (!forumKey) return sendError(res, 400, "Forum key is required");
  const client = await pool.connect();
  try {
    const result = await getForumAuditProof(client, forumKey);
    if (!result) return sendError(res, 404, "Forum not found");
    res.json(result);
  } catch (err) {
    console.error("[GET /audit/forums/:forumKey]", err);
    sendError(res, 500, "Internal server error");
  } finally {
    client.release();
  }
});

app.get("/api/merkle/anchor", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT block_number, merkle_root, anchored_at
       FROM merkle_anchors ORDER BY block_number DESC LIMIT 1`
    );
    res.json({
      lastAnchoredRoot:  rows[0]?.merkle_root  ?? null,
      lastAnchoredBlock: rows[0]?.block_number ? String(rows[0].block_number) : null,
      anchored_at:       rows[0]?.anchored_at  ?? null,
    });
  } catch (err) {
    console.error("[GET /merkle/anchor]", err);
    sendError(res, 500, "Internal server error");
  }
});

// =============================================================================
// SEARCH
// =============================================================================

app.get("/api/search/forums", async (req: Request, res: Response) => {
  const { q = "", category, tag } = req.query as Record<string, string | undefined>;

  const params: unknown[] = [q || " "];
  const conditions: string[] = [
    `(f.fts_document @@ plainto_tsquery('english', $1) OR f.name % $1)`
  ];

  if (category) {
    params.push(category);
    conditions.push(`f.category = $${params.length}::forum_category`);
  }
  if (tag) {
    const tagList = tag.split(",");
    params.push(tagList);
    conditions.push(`f.tags && $${params.length}::text[]`);
  }

  try {
    const { rows } = await pool.query(
      `SELECT f.forum_key, f.name, f.category, f.tags, f.member_count,
              ts_rank(f.fts_document, plainto_tsquery('english', $1)) AS relevance
       FROM forums f
       WHERE ${conditions.join(" AND ")}
       ORDER BY relevance DESC, f.member_count DESC
       LIMIT 30`,
      params
    );
    res.json({ results: rows });
  } catch (err) {
    console.error("[GET /search/forums]", err);
    sendError(res, 500, "Internal server error");
  }
});

// =============================================================================
// NOTIFICATIONS
// =============================================================================

const NOTIFICATION_COLUMNS = `notification_id, type, sender_wallet, amount_wei, post_id,
       comment_id, badge_key, badge_name, read_at, created_at`;

// Wallet-ownership proof for the mutation endpoints below (mark-read,
// mark-all-read, clear-all). `wallet` in the URL alone proves nothing - any
// caller could pass any address - so those routes require a fresh signature
// over this exact message. Mirrors buildNotificationAuthMessage in
// frontend/src/lib/notificationAuth.ts; both sides must stay byte-for-byte
// identical or every signature will fail verification. The plain list read
// and the SSE stream stay unauthenticated (consistent with this API's other
// wallet-scoped reads, e.g. getTipsReceived) since they don't mutate anything.
const NOTIFICATION_AUTH_WINDOW_MS = 10 * 60 * 1000; // matches frontend AUTH_TTL_MS

function buildNotificationAuthMessage(wallet: string, issuedAt: number): string {
  return `DeReddit notifications access for ${wallet} at ${issuedAt}`;
}

function verifyNotificationAuth(wallet: string, req: Request): boolean {
  const signature = getSingleParam(req.headers["x-wallet-signature"]);
  const issuedAtRaw = getSingleParam(req.headers["x-wallet-timestamp"]);
  if (!signature || !issuedAtRaw) return false;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > NOTIFICATION_AUTH_WINDOW_MS) return false;
  try {
    const recovered = ethers.verifyMessage(buildNotificationAuthMessage(wallet, issuedAt), signature);
    return recovered.toLowerCase() === wallet;
  } catch {
    return false;
  }
}

// Applied to every notification-mutation route (not the plain list read or
// the SSE stream, which intentionally stay public - see comment above).
// Middleware, rather than a per-handler `if`, so a future mutation route
// added under /api/notifications can't accidentally skip the check by
// copy-pasting a handler body without also copying a buried guard line.
function requireNotificationAuth(req: Request, res: Response, next: NextFunction): void {
  const wallet = getSingleParam(req.params.wallet)?.toLowerCase();
  if (!wallet) {
    sendError(res, 400, "Wallet is required");
    return;
  }
  if (!verifyNotificationAuth(wallet, req)) {
    sendError(res, 401, "Wallet ownership signature required");
    return;
  }
  next();
}

const WALLET_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

// Caps concurrent SSE stream connections per wallet AND per source IP. The
// per-wallet cap alone doesn't bound anything against an unauthenticated
// caller - :wallet is just a URL string, so an attacker can cycle through
// an unlimited number of distinct (real or fake) addresses to stay under
// it. The per-IP cap is what actually bounds how many long-lived,
// DB-polling connections a single source can hold open.
const MAX_STREAMS_PER_WALLET = 3;
const MAX_STREAMS_PER_IP = 10;
const activeStreams = new Map<string, number>();
const activeStreamsByIp = new Map<string, number>();

function incrementStream(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrementStream(map: Map<string, number>, key: string): void {
  const remaining = (map.get(key) ?? 1) - 1;
  if (remaining <= 0) map.delete(key);
  else map.set(key, remaining);
}

app.get("/api/notifications/:wallet", async (req: Request, res: Response) => {
  const wallet = getSingleParam(req.params.wallet)?.toLowerCase();
  if (!wallet) return sendError(res, 400, "Wallet is required");
  const unreadOnly = getSingleParam(req.query.unread) === "true";
  const { limitNum, offset } = parsePageLimit(
    getSingleParam(req.query.page),
    getSingleParam(req.query.limit),
    20,
    100
  );
  try {
    const { rows } = await pool.query(
      `SELECT ${NOTIFICATION_COLUMNS}
       FROM notifications
       WHERE recipient_wallet = $1 ${unreadOnly ? "AND read_at IS NULL" : ""}
       ORDER BY notification_id DESC
       LIMIT $2 OFFSET $3`,
      [wallet, limitNum, offset]
    );
    const { rows: unreadRows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM notifications WHERE recipient_wallet = $1 AND read_at IS NULL`,
      [wallet]
    );
    res.json({ notifications: rows, unreadCount: unreadRows[0]?.count ?? 0 });
  } catch (err) {
    console.error("[GET /notifications/:wallet]", err);
    sendError(res, 500, "Internal server error");
  }
});

app.patch("/api/notifications/:wallet/read-all", requireNotificationAuth, async (req: Request, res: Response) => {
  const wallet = getSingleParam(req.params.wallet)!.toLowerCase();
  try {
    const { rowCount } = await pool.query(
      `UPDATE notifications SET read_at = NOW() WHERE recipient_wallet = $1 AND read_at IS NULL`,
      [wallet]
    );
    res.json({ updated: rowCount ?? 0 });
  } catch (err) {
    console.error("[PATCH /notifications/:wallet/read-all]", err);
    sendError(res, 500, "Internal server error");
  }
});

app.delete("/api/notifications/:wallet", requireNotificationAuth, async (req: Request, res: Response) => {
  const wallet = getSingleParam(req.params.wallet)!.toLowerCase();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM notifications WHERE recipient_wallet = $1`,
      [wallet]
    );
    res.json({ deleted: rowCount ?? 0 });
  } catch (err) {
    console.error("[DELETE /notifications/:wallet]", err);
    sendError(res, 500, "Internal server error");
  }
});

app.patch(
  "/api/notifications/:wallet/:notificationId/read",
  requireNotificationAuth,
  async (req: Request, res: Response) => {
  const wallet = getSingleParam(req.params.wallet)!.toLowerCase();
  const notificationId = getSingleParam(req.params.notificationId);
  if (!notificationId) return sendError(res, 400, "Notification id is required");
  try {
    const { rowCount } = await pool.query(
      `UPDATE notifications SET read_at = NOW()
       WHERE notification_id = $1 AND recipient_wallet = $2 AND read_at IS NULL`,
      [notificationId, wallet]
    );
    if (!rowCount) return sendError(res, 404, "Notification not found");
    res.json({ ok: true });
  } catch (err) {
    console.error("[PATCH /notifications/:wallet/:notificationId/read]", err);
    sendError(res, 500, "Internal server error");
  }
});

// SSE stream: internally polls Postgres every 4s and pushes only rows newer
// than `lastId`, so the client never has to diff/dedup on its own. Indexer
// and server are separate processes sharing only Postgres - no pub/sub - so
// polling inside the held-open connection is the simplest correct mechanism.
app.get("/api/notifications/:wallet/stream", async (req: Request, res: Response) => {
  const wallet = getSingleParam(req.params.wallet)?.toLowerCase();
  if (!wallet || !WALLET_ADDRESS_RE.test(wallet)) return sendError(res, 400, "A valid wallet address is required");

  // Parsed and validated before writeHead() below - once SSE headers are
  // sent, the connection can no longer carry a normal JSON error response,
  // so any input validation has to happen while we can still fail cleanly.
  const sinceRaw = getSingleParam(req.query.since) ?? "0";
  let lastId: bigint;
  try {
    lastId = BigInt(sinceRaw);
  } catch {
    return sendError(res, 400, "Invalid 'since' parameter");
  }

  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  if ((activeStreams.get(wallet) ?? 0) >= MAX_STREAMS_PER_WALLET) {
    return sendError(res, 429, "Too many active notification streams for this wallet");
  }
  if ((activeStreamsByIp.get(ip) ?? 0) >= MAX_STREAMS_PER_IP) {
    return sendError(res, 429, "Too many active notification streams from this connection");
  }
  incrementStream(activeStreams, wallet);
  incrementStream(activeStreamsByIp, ip);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Node doesn't put the headers on the wire until the first res.write() -
  // writeHead() alone just buffers them. poll() below only writes when it
  // finds rows newer than `since`, which in the common case (client already
  // caught up) is never on the first pass, so without this the connection
  // sits with nothing sent at all until the 20s heartbeat further down -
  // long enough for a proxy/tunnel in between to treat it as idle and kill
  // it before that heartbeat ever gets a chance to go out.
  res.flushHeaders();

  const poll = async () => {
    const { rows } = await pool.query(
      `SELECT ${NOTIFICATION_COLUMNS}
       FROM notifications
       WHERE recipient_wallet = $1 AND notification_id > $2
       ORDER BY notification_id ASC`,
      [wallet, lastId.toString()]
    );
    for (const row of rows) {
      lastId = BigInt(row.notification_id as string);
      res.write(`data: ${JSON.stringify(row)}\n\n`);
    }
  };

  try {
    await poll();
  } catch (err) {
    console.error("[SSE /notifications/:wallet/stream] initial poll", err);
  }
  const pollInterval = setInterval(() => {
    poll().catch((err) => console.error("[SSE /notifications/:wallet/stream] poll", err));
  }, 4000);

  // Heartbeat: keeps proxies/load balancers from timing out an idle connection.
  // Comment lines (":") are valid SSE per spec and ignored by EventSource clients.
  const heartbeatInterval = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 20000);

  req.on("close", () => {
    clearInterval(pollInterval);
    clearInterval(heartbeatInterval);
    decrementStream(activeStreams, wallet);
    decrementStream(activeStreamsByIp, ip);
  });
});

// =============================================================================
// BADGES
// =============================================================================

app.get("/api/badges", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT badge_id, badge_key, name, description, category
       FROM badge_definitions ORDER BY category, badge_id`
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /badges]", err);
    sendError(res, 500, "Internal server error");
  }
});

// =============================================================================
// GLOBAL ERROR HANDLER
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[Server] Unhandled:", err);
  res.status(500).json({ error: "Internal server error" });
});

// =============================================================================
// START
// =============================================================================

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`[Server] DeReddit API running on http://localhost:${PORT}`);
  });
}

export default app;