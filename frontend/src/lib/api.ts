// Response shapes mirror the columns each endpoint in backend/src/server.ts
// actually selects, so a field missing here means the backend doesn't return it.

import { env } from "./env";

async function request<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${env.apiBaseUrl}${path}`);
  } catch {
    // A rejected fetch() here means the request never reached the server at
    // all (offline, DNS failure, backend down) - the browser's own message
    // for this ("Failed to fetch" / "NetworkError...") is implementation
    // jargon, not something a user can act on.
    throw new Error("Couldn't reach the DeReddit server. Check your connection and try again.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Something went wrong loading this (error ${response.status}). Try again.`);
  }
  return response.json() as Promise<T>;
}

async function requestMutate<T>(path: string, method: string, headers?: Record<string, string>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${env.apiBaseUrl}${path}`, { method, headers });
  } catch {
    throw new Error("Couldn't reach the DeReddit server. Check your connection and try again.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Something went wrong (error ${response.status}). Try again.`);
  }
  return response.json() as Promise<T>;
}

export interface ForumSummary {
  forum_key: string;
  name: string;
  description: string | null;
  category: string;
  tags: string[];
  creator_wallet: string;
  icon_cid: string | null;
  banner_cid: string | null;
  member_count: number;
  post_count: number;
  comment_count: number;
  created_at: string;
  forum_popularity_score: number | null;
}

export interface ForumDetail extends ForumSummary {
  rules: string | null;
  min_karma_to_flag: string;
  ipfs_cid: string;
  total_upvotes: string;
  creator_username: string | null;
  creator_profile_cid: string | null;
  log_index: number;
  /** Only meaningful when GET /api/forums/:forumKey was called with ?wallet=. Defaults to false otherwise. */
  is_member: boolean;
}

export interface PostSummary {
  post_id: string;
  post_type: "Standard" | "TimeCapsule" | "Poll" | "Crowdfund";
  ipfs_cid: string;
  title: string | null;
  body: string | null;
  media_cids: string[] | null;
  upvotes: number;
  downvotes: number;
  flag_tally: number;
  visible_after: string | null;
  poll_option_count: number | null;
  poll_deadline: string | null;
  cf_target_goal: string | null;
  cf_funds_raised: string | null;
  cf_deadline: string | null;
  cf_claimed: boolean;
  cf_backer_count: number;
  total_tips_wei: string;
  created_at: string;
  log_index: number;
  author_username: string | null;
  author_wallet: string;
  author_profile_cid: string | null;
  /** Only populated when the feed request included ?userWallet=. Defaults to 0/false otherwise. */
  user_vote: number;
  user_flagged: boolean;
  /** How much the connected wallet (?userWallet=) personally tipped this post. Defaults to "0" otherwise. */
  user_tipped_wei: string;
  /**
   * Only populated by the forum-feed endpoint (Poll posts get their full
   * option list embedded so the feed card can show a summary); the post-
   * detail endpoint returns poll options as a separate top-level field
   * instead (see PostDetailResponse.pollOptions), so this is absent there.
   */
  poll_options?: PollOption[] | null;
}

export interface PostDetail extends PostSummary {
  forum_key: string;
  user_vote: number;
  /** Only meaningful when GET /api/posts/:postId was called with ?userWallet=. Defaults to false otherwise. */
  is_member: boolean;
}

export interface PollOption {
  option_id: number;
  choice_text: string;
  vote_count: number;
}

export interface CommentSummary {
  comment_id: string;
  parent_id: string | null;
  tier: number;
  ipfs_cid: string;
  body: string | null;
  upvotes: number;
  downvotes: number;
  flag_tally: number;
  total_tips_wei: string;
  created_at: string;
  log_index: number;
  author_username: string | null;
  author_wallet: string;
  author_profile_cid: string | null;
  user_vote: number;
  user_flagged: boolean;
  /** How much the connected wallet (?userWallet=) personally tipped this comment. Defaults to "0" otherwise. */
  user_tipped_wei: string;
}

export interface UserProfile {
  wallet_address: string;
  username: string | null;
  karma: string;
  profile_cid: string | null;
  joined_at: string;
  post_count: number;
  comment_count: number;
  forum_count: number;
  total_tips_received_wei: string;
  total_tips_given_wei: string;
}

export interface BadgeSummary {
  badge_key: string;
  name: string;
  description: string;
  category: string;
  awarded_at: string;
}

export interface AppNotification {
  notification_id: string;
  type: "tip" | "badge";
  sender_wallet: string | null;
  amount_wei: string | null;
  post_id: string | null;
  comment_id: string | null;
  badge_key: string | null;
  badge_name: string | null;
  read_at: string | null;
  created_at: string;
}

export interface UserPostSummary {
  post_id: string;
  forum_key: string;
  forum_name: string;
  post_type: PostSummary["post_type"];
  title: string | null;
  upvotes: number;
  downvotes: number;
  visible_after: string | null;
  created_at: string;
}

export interface UserCommentSummary {
  comment_id: string;
  post_id: string;
  tier: number;
  body: string | null;
  upvotes: number;
  downvotes: number;
  created_at: string;
  post_title: string | null;
  forum_key: string;
}

export interface ContributionSummary {
  post_id: string;
  amount_wei: string;
  contributed_at: string;
  post_title: string | null;
  forum_key: string;
  cf_target_goal: string | null;
  cf_funds_raised: string | null;
  cf_deadline: string | null;
  cf_claimed: boolean;
}

export interface AuditProof {
  root: string;
  proof: string[];
  leaf: { entityType: "post" | "comment" | "forum"; id: string; contentHash: string };
}

export interface MerkleAnchor {
  lastAnchoredRoot: string | null;
  lastAnchoredBlock: string | null;
  anchored_at: string | null;
}

interface ForumsListResponse {
  forums: ForumSummary[];
  count: number;
}

interface ForumsRecommendedResponse {
  byScore: ForumSummary[];
  byTagOverlap: ForumSummary[];
}

interface ForumTagsResponse {
  tags: string[];
}

interface ForumPostsResponse {
  posts: PostSummary[];
  count: number;
}

interface PostDetailResponse {
  post: PostDetail;
  pollOptions: PollOption[];
  userPollOption: number | null;
  userContributionWei: string | null;
}

interface PostCommentsResponse {
  comments: CommentSummary[];
  count: number;
  /** True when this page returned a full page of root (tier-1) comments, i.e. there's likely another page. */
  hasMore: boolean;
}

interface UserResponse {
  user: UserProfile;
  badges: BadgeSummary[];
  forums: ForumSummary[];
}

interface UserPostsResponse {
  posts: UserPostSummary[];
}

interface UserCommentsResponse {
  comments: UserCommentSummary[];
}

interface UserContributionsResponse {
  contributions: ContributionSummary[];
}

interface TipsReceivedResponse {
  totalWei: string;
}

interface NotificationsResponse {
  notifications: AppNotification[];
  unreadCount: number;
}

/** Proof of wallet ownership for notification-mutation endpoints - see lib/notificationAuth.ts. */
export interface NotificationAuth {
  issuedAt: number;
  signature: string;
}

function notificationAuthHeaders({ issuedAt, signature }: NotificationAuth): Record<string, string> {
  return { "x-wallet-signature": signature, "x-wallet-timestamp": String(issuedAt) };
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** Typed REST client for the backend read API - each method returns JSON typed to match what that endpoint in server.ts actually selects. */
export const api = {
  getForums(params: { search?: string; category?: string; tag?: string; tags?: string; sort?: string; page?: number; limit?: number }) {
    return request<ForumsListResponse>(`/api/forums${buildQuery(params)}`);
  },
  getRecommendedForums(wallet?: string) {
    return request<ForumsRecommendedResponse>(`/api/forums/recommended${buildQuery({ wallet })}`);
  },
  getForumTags(q: string) {
    return request<ForumTagsResponse>(`/api/forums/tags${buildQuery({ q })}`);
  },
  getForum(forumKey: string, wallet?: string) {
    return request<ForumDetail>(`/api/forums/${forumKey}${buildQuery({ wallet })}`);
  },
  getForumPosts(forumKey: string, params: { type?: string; title?: string; sort?: string; page?: number; limit?: number; userWallet?: string }) {
    return request<ForumPostsResponse>(`/api/forums/${forumKey}/posts${buildQuery(params)}`);
  },
  getPost(postId: string, userWallet?: string) {
    return request<PostDetailResponse>(`/api/posts/${postId}${buildQuery({ userWallet })}`);
  },
  getPostComments(postId: string, params: { userWallet?: string; page?: number; limit?: number } = {}) {
    return request<PostCommentsResponse>(`/api/posts/${postId}/comments${buildQuery(params)}`);
  },
  getUser(wallet: string) {
    return request<UserResponse>(`/api/users/${wallet}`);
  },
  getUserPosts(wallet: string) {
    return request<UserPostsResponse>(`/api/users/${wallet}/posts`);
  },
  getUserComments(wallet: string) {
    return request<UserCommentsResponse>(`/api/users/${wallet}/comments`);
  },
  getUserContributions(wallet: string) {
    return request<UserContributionsResponse>(`/api/users/${wallet}/contributions`);
  },
  getTipsReceived(wallet: string, from: string) {
    return request<TipsReceivedResponse>(`/api/users/${wallet}/tips-received${buildQuery({ from })}`);
  },
  getNotifications(wallet: string, params: { unread?: boolean; page?: number; limit?: number } = {}) {
    return request<NotificationsResponse>(
      `/api/notifications/${wallet}${buildQuery({ unread: params.unread ? "true" : undefined, page: params.page, limit: params.limit })}`
    );
  },
  markNotificationRead(wallet: string, notificationId: string, auth: NotificationAuth) {
    return requestMutate<{ ok: boolean }>(
      `/api/notifications/${wallet}/${notificationId}/read`,
      "PATCH",
      notificationAuthHeaders(auth)
    );
  },
  markAllNotificationsRead(wallet: string, auth: NotificationAuth) {
    return requestMutate<{ updated: number }>(`/api/notifications/${wallet}/read-all`, "PATCH", notificationAuthHeaders(auth));
  },
  clearAllNotifications(wallet: string, auth: NotificationAuth) {
    return requestMutate<{ deleted: number }>(`/api/notifications/${wallet}`, "DELETE", notificationAuthHeaders(auth));
  },
  getAuditProof(type: "post" | "comment" | "forum", id: string) {
    return request<AuditProof>(`/api/audit/${type}s/${id}`);
  },
  getMerkleAnchor() {
    return request<MerkleAnchor>(`/api/merkle/anchor`);
  },
};