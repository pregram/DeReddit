// Shared response-shape fixtures + tiny 1x1 PNG helper for the E2E specs.
// Mirrors frontend/src/lib/api.ts's response interfaces.

export const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const ZERO_BYTES32 = "0x" + "0".repeat(64);

export function userResponse(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      wallet_address: WALLET_A,
      username: "alice",
      karma: "42",
      profile_cid: null,
      joined_at: new Date().toISOString(),
      post_count: 3,
      comment_count: 5,
      forum_count: 1,
      total_tips_received_wei: "0",
      total_tips_given_wei: "0",
      ...overrides,
    },
    badges: [],
    forums: [],
  };
}

export function forumDetailResponse(overrides: Record<string, unknown> = {}) {
  return {
    forum_key: "0x" + "11".repeat(32),
    name: "Technology",
    description: "All things tech",
    category: "Technology",
    tags: ["ai", "hardware"],
    creator_wallet: WALLET_A,
    icon_cid: null,
    banner_cid: null,
    member_count: 128,
    post_count: 4,
    comment_count: 9,
    created_at: new Date().toISOString(),
    forum_popularity_score: 1.5,
    rules: "Be respectful.",
    min_karma_to_flag: "10",
    ipfs_cid: ZERO_BYTES32,
    total_upvotes: "50",
    creator_username: "alice",
    creator_profile_cid: null,
    log_index: 0,
    is_member: false,
    ...overrides,
  };
}

export function forumSummary(overrides: Record<string, unknown> = {}) {
  return {
    forum_key: "0x" + "11".repeat(32),
    name: "Technology",
    description: "All things tech",
    category: "Technology",
    tags: ["ai", "hardware"],
    creator_wallet: WALLET_A,
    icon_cid: null,
    banner_cid: null,
    member_count: 128,
    post_count: 4,
    comment_count: 9,
    created_at: new Date().toISOString(),
    forum_popularity_score: 1.5,
    ...overrides,
  };
}

export function postDetailResponse(overrides: Record<string, unknown> = {}) {
  return {
    post: {
      post_id: "1",
      forum_key: "0x" + "11".repeat(32),
      author_wallet: WALLET_B,
      post_type: "Standard",
      ipfs_cid: ZERO_BYTES32,
      title: "Hello DeReddit",
      body: "This is a test post body.",
      media_cids: [],
      upvotes: 10,
      downvotes: 2,
      flag_tally: 0,
      visible_after: null,
      poll_option_count: null,
      poll_deadline: null,
      cf_target_goal: null,
      cf_funds_raised: null,
      cf_deadline: null,
      cf_claimed: false,
      cf_backer_count: 0,
      total_tips_wei: "0",
      created_at: new Date().toISOString(),
      log_index: 0,
      author_username: "bob",
      author_profile_cid: null,
      user_vote: 0,
      user_flagged: false,
      user_tipped_wei: "0",
      is_member: true,
      ...overrides,
    },
    pollOptions: [],
    userPollOption: null,
    userContributionWei: null,
  };
}

export function onePixelPngBuffer(): Buffer {
  // Smallest valid 1x1 transparent PNG.
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
}
