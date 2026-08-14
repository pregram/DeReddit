-- =============================================================================
-- DeReddit - PostgreSQL 16 Schema
-- Single-file bootstrap. Runs automatically on first container start via
-- docker-entrypoint-initdb.d/01_init.sql.
-- =============================================================================

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;          -- Fuzzy text search
CREATE EXTENSION IF NOT EXISTS btree_gin;         -- GIN indexes on scalar types
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;-- Query statistics

-- =============================================================================
-- 0. ENUM TYPES
-- =============================================================================

CREATE TYPE post_type AS ENUM ('Standard', 'TimeCapsule', 'Poll', 'Crowdfund');

-- The 8 predefined forum categories. Stored as enum to enforce the
-- "limited predefined set" requirement without needing a lookup table.
CREATE TYPE forum_category AS ENUM (
    'Technology',
    'Gaming',
    'Science',
    'Art',
    'Music',
    'Sports',
    'Finance',
    'General'
);

-- =============================================================================
-- 1. USERS
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
    wallet_address  CHAR(42)     PRIMARY KEY,          -- '0x' + 40 hex chars
    username        VARCHAR(32)  UNIQUE DEFAULT NULL,       -- bytes32 decoded
    karma           BIGINT       NOT NULL DEFAULT 0,    -- uint64 maps to BIGINT
    profile_cid     CHAR(66)     DEFAULT NULL,              -- IPFS bytes32 CID (hex)
    joined_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),    -- block.timestamp of registration
    log_index       INT          NOT NULL DEFAULT 0,        -- position of the event within its block
    -- Soft counters updated by indexer (avoids COUNT(*) on every profile load)
    post_count      INT          NOT NULL DEFAULT 0,
    comment_count   INT          NOT NULL DEFAULT 0,
    forum_count     INT          NOT NULL DEFAULT 0     -- forums created
);

-- Fast wallet lookups (already PK, but explicit for clarity)
CREATE INDEX IF NOT EXISTS idx_users_wallet     ON users (wallet_address);
CREATE INDEX IF NOT EXISTS idx_users_username   ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_karma_desc ON users (karma DESC);

-- =============================================================================
-- 2. FORUMS
-- =============================================================================

CREATE TABLE IF NOT EXISTS forums (
    -- forum_key is keccak256(handle) stored as 0x-prefixed hex
    forum_key           CHAR(66)       PRIMARY KEY,
    name                TEXT           NOT NULL UNIQUE,
    description         TEXT,
    category            forum_category NOT NULL,
    rules               TEXT,
    creator_wallet      CHAR(42)       NOT NULL REFERENCES users (wallet_address),
    min_karma_to_flag   BIGINT         NOT NULL DEFAULT 0,
    -- Tags: up to 10, stored as a fixed-length text array
    tags                TEXT[]         NOT NULL DEFAULT '{}'
                            CHECK (array_length(tags, 1) IS NULL OR array_length(tags, 1) <= 10),
    ipfs_cid            CHAR(66),                           -- bytes32 forum metadata CID
    icon_cid            TEXT,                               -- CIDv0 string, nested in the metadata JSON (never on-chain directly)
    banner_cid          TEXT,                               -- CIDv0 string, nested in the metadata JSON (never on-chain directly)
    member_count        INT            NOT NULL DEFAULT 1,
    post_count          INT            NOT NULL DEFAULT 0,
    comment_count       INT            NOT NULL DEFAULT 0,
    total_upvotes       BIGINT         NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    log_index           INT            NOT NULL DEFAULT 0,

    -- Recommendation scoring is computed on demand via the v_forums_by_score
    -- view (section 15) instead of being stored/refreshed on stored columns -
    -- see the removed engagement_ratio/velocity_score/posts_last_7d columns
    -- that used to be maintained by hand on every mutating handler.

    CONSTRAINT tags_not_empty CHECK (tags IS NOT NULL)
);

-- ── Forum search indexes ───────────────────────────────────────────────────
-- Fuzzy name search
CREATE INDEX IF NOT EXISTS idx_forums_name_trgm
    ON forums USING GIN (name gin_trgm_ops);

-- GIN index on tags array for tag-overlap queries
CREATE INDEX IF NOT EXISTS idx_forums_tags_gin
    ON forums USING GIN (tags);

-- Category filter
CREATE INDEX IF NOT EXISTS idx_forums_category
    ON forums (category);

-- Recommendation / secondary sorting
CREATE INDEX IF NOT EXISTS idx_forums_member_count ON forums (member_count DESC);
CREATE INDEX IF NOT EXISTS idx_forums_created_at   ON forums (created_at DESC);

-- Normalized, per-tag rows kept in sync with forums.tags by the indexer.
-- forums.tags (+ idx_forums_tags_gin above) stays the source of truth and
-- is what exact-match tag-pill filtering (array containment) uses - this
-- table exists solely so the tag-search/autocomplete endpoint can run an
-- indexed ILIKE substring search instead of unnest()-ing every forum's tag
-- array on every keystroke.
CREATE TABLE IF NOT EXISTS forum_tags (
    forum_key CHAR(66) NOT NULL REFERENCES forums (forum_key) ON DELETE CASCADE,
    tag       TEXT     NOT NULL,
    PRIMARY KEY (forum_key, tag)
);

CREATE INDEX IF NOT EXISTS idx_forum_tags_tag_trgm
    ON forum_tags USING GIN (tag gin_trgm_ops);

-- =============================================================================
-- 3. FORUM MEMBERSHIPS
-- =============================================================================

CREATE TABLE IF NOT EXISTS forum_memberships (
    forum_key      CHAR(66)    NOT NULL REFERENCES forums (forum_key) ON DELETE CASCADE,
    wallet_address CHAR(42)    NOT NULL REFERENCES users (wallet_address) ON DELETE CASCADE,
    joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    log_index      INT         NOT NULL DEFAULT 0,
    PRIMARY KEY (forum_key, wallet_address)
);

CREATE INDEX IF NOT EXISTS idx_memberships_wallet
    ON forum_memberships (wallet_address);

-- =============================================================================
-- 4. POSTS
-- =============================================================================

CREATE TABLE IF NOT EXISTS posts (
    post_id         NUMERIC(78,0)   PRIMARY KEY,   -- matches on-chain postCount (uint256 support)
    forum_key       CHAR(66)        NOT NULL REFERENCES forums (forum_key),
    author_wallet   CHAR(42)        NOT NULL REFERENCES users (wallet_address),
    post_type       post_type       NOT NULL DEFAULT 'Standard',
    ipfs_cid        CHAR(66)        NOT NULL,      -- bytes32 content pointer (shared by all post types)
    -- ── Content fields (decoded from the post's single IPFS JSON) ────────────
    title           TEXT,
    body            TEXT,
    media_cids      TEXT[]          NOT NULL DEFAULT '{}',  -- CIDv0 strings, nested in the content JSON (never on-chain directly)
    -- ── On-chain counters (updated by indexer on every vote event) ───────────
    upvotes         INT             NOT NULL DEFAULT 0,
    downvotes       INT             NOT NULL DEFAULT 0,
    flag_tally      INT             NOT NULL DEFAULT 0,
    -- ── Timestamps ───────────────────────────────────────────────────────────
    visible_after   TIMESTAMPTZ,    -- NULL for Standard/Poll/Crowdfund; set for TimeCapsule
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    log_index       INT             NOT NULL DEFAULT 0,
    -- ── Poll fields (populated by PollConfigured event) ──────────────────────
    poll_option_count   SMALLINT,
    poll_deadline       TIMESTAMPTZ,
    -- ── Crowdfund fields (populated by CrowdfundLaunched event) ──────────────
    cf_target_goal      NUMERIC(36,0),   -- Wei value - use NUMERIC to avoid overflow
    cf_funds_raised     NUMERIC(36,0)    NOT NULL DEFAULT 0,
    cf_deadline         TIMESTAMPTZ,
    cf_claimed          BOOLEAN          NOT NULL DEFAULT FALSE,
    cf_backer_count     INT              NOT NULL DEFAULT 0,
    -- ── Tip totals (informational only, authoritative is on-chain) ────────────
    total_tips_wei  NUMERIC(36,0)    NOT NULL DEFAULT 0,
    CONSTRAINT post_timecapsule_check
        CHECK (post_type <> 'TimeCapsule' OR visible_after IS NOT NULL)

    -- post_crowdfund_check REMOVED (see file header) - a Crowdfund post is
    -- valid with cf_target_goal NULL between Step 1 and Step 2; "configured"
    -- status is inferred at the API layer, not enforced here.


    /*Changed:
    CONSTRAINT post_timecapsule_check
        CHECK (post_type <> 'TimeCapsule' OR visible_after IS NOT NULL),
    CONSTRAINT post_crowdfund_check
        CHECK (post_type <> 'Crowdfund'   OR cf_target_goal IS NOT NULL)
        */
        
);

-- ── Post search & filter indexes ──────────────────────────────────────────────
-- Primary feed: posts in a forum sorted by newest (log_index breaks ties within a block)
CREATE INDEX IF NOT EXISTS idx_posts_forum_created
    ON posts (forum_key, created_at DESC, log_index DESC);

-- Post type filter (e.g. "show only polls")
CREATE INDEX IF NOT EXISTS idx_posts_forum_type
    ON posts (forum_key, post_type);

-- TimeCapsule visibility gate
CREATE INDEX IF NOT EXISTS idx_posts_visible_after
    ON posts (visible_after)
    WHERE visible_after IS NOT NULL;

-- Crowdfund deadline sorting
CREATE INDEX IF NOT EXISTS idx_posts_cf_deadline
    ON posts (cf_deadline)
    WHERE cf_deadline IS NOT NULL;

-- Fuzzy title search within a forum
CREATE INDEX IF NOT EXISTS idx_posts_title_trgm
    ON posts USING GIN (title gin_trgm_ops)
    WHERE title IS NOT NULL;

-- -- Full-text search on body
-- CREATE INDEX IF NOT EXISTS idx_posts_body_fts
--     ON posts USING GIN (to_tsvector('english', coalesce(body, '')));

-- -- Author lookup
-- CREATE INDEX IF NOT EXISTS idx_posts_author
--     ON posts (author_wallet, created_at DESC);

-- =============================================================================
-- 5. POLL OPTIONS
-- Each option is a row: optionId (1-based) + human-readable choice text.
-- =============================================================================

CREATE TABLE IF NOT EXISTS poll_options (
    post_id     NUMERIC(78,0) NOT NULL REFERENCES posts (post_id) ON DELETE CASCADE,
    option_id   SMALLINT     NOT NULL CHECK (option_id BETWEEN 1 AND 100),
    choice_text TEXT         NOT NULL,
    vote_count  INT          NOT NULL DEFAULT 0,
    PRIMARY KEY (post_id, option_id)
);

-- =============================================================================
-- 6. POLL VOTES  (user choice registry)
-- =============================================================================

CREATE TABLE IF NOT EXISTS poll_votes (
    post_id        NUMERIC(78,0) NOT NULL REFERENCES posts (post_id) ON DELETE CASCADE,
    voter_wallet   CHAR(42) NOT NULL REFERENCES users (wallet_address),
    option_id      SMALLINT NOT NULL,
    PRIMARY KEY (post_id, voter_wallet),
    FOREIGN KEY (post_id, option_id) REFERENCES poll_options (post_id, option_id)
);

-- =============================================================================
-- 7. CROWDFUND CONTRIBUTIONS
-- =============================================================================

CREATE TABLE IF NOT EXISTS crowdfund_contributions (
    post_id        NUMERIC(78,0) NOT NULL REFERENCES posts (post_id) ON DELETE CASCADE,
    backer_wallet  CHAR(42)     NOT NULL REFERENCES users (wallet_address),
    amount_wei     NUMERIC(36,0) NOT NULL DEFAULT 0,
    contributed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    log_index      INT          NOT NULL DEFAULT 0,
    PRIMARY KEY (post_id, backer_wallet)
);

CREATE INDEX IF NOT EXISTS idx_cf_contributions_post
    ON crowdfund_contributions (post_id);

-- =============================================================================
-- 8. COMMENTS
-- =============================================================================

CREATE TABLE IF NOT EXISTS comments (
    comment_id    NUMERIC(78,0) PRIMARY KEY,   -- matches on-chain commentCount (uint256 support)
    post_id       NUMERIC(78,0) NOT NULL REFERENCES posts (post_id) ON DELETE CASCADE,
    parent_id     NUMERIC(78,0) REFERENCES comments (comment_id),   -- NULL = root
    author_wallet CHAR(42)    NOT NULL REFERENCES users (wallet_address),
    tier          SMALLINT    NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 3),
    ipfs_cid      CHAR(66)    NOT NULL,
    body          TEXT,                       -- Decoded from IPFS
    upvotes       INT         NOT NULL DEFAULT 0,
    downvotes     INT         NOT NULL DEFAULT 0,
    flag_tally    INT         NOT NULL DEFAULT 0,
    total_tips_wei NUMERIC(36,0) NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    log_index     INT         NOT NULL DEFAULT 0,

    CONSTRAINT comment_tier_parent_check
        CHECK (
            (tier = 1 AND parent_id IS NULL) OR
            (tier > 1 AND parent_id IS NOT NULL)
        )
);

-- Thread-load: all comments for a post ordered by tier then true on-chain order
CREATE INDEX IF NOT EXISTS idx_comments_post_tier
    ON comments (post_id, tier, created_at ASC, log_index ASC);

-- Depth traversal via parent
CREATE INDEX IF NOT EXISTS idx_comments_parent
    ON comments (parent_id)
    WHERE parent_id IS NOT NULL;

-- -- Author lookup
-- CREATE INDEX IF NOT EXISTS idx_comments_author
--     ON comments (author_wallet, created_at DESC);

-- =============================================================================
-- 9. VOTES  (Magic Marker states)
-- vote_state: 1=Upvoted, 0=Neutral, -1=Effective Downvote, -2=Swallowed Downvote
-- =============================================================================

CREATE TABLE IF NOT EXISTS post_votes (
    post_id       NUMERIC(78,0) NOT NULL REFERENCES posts (post_id) ON DELETE CASCADE,
    voter_wallet  CHAR(42) NOT NULL REFERENCES users (wallet_address),
    vote_state    SMALLINT NOT NULL DEFAULT 0
                    CHECK (vote_state BETWEEN -2 AND 1),
    PRIMARY KEY (post_id, voter_wallet)
);

CREATE TABLE IF NOT EXISTS comment_votes (
    comment_id    NUMERIC(78,0) NOT NULL REFERENCES comments (comment_id) ON DELETE CASCADE,
    voter_wallet  CHAR(42) NOT NULL REFERENCES users (wallet_address),
    vote_state    SMALLINT NOT NULL DEFAULT 0
                    CHECK (vote_state BETWEEN -2 AND 1),
    PRIMARY KEY (comment_id, voter_wallet)
);

-- =============================================================================
-- 10. FLAGS
-- =============================================================================

CREATE TABLE IF NOT EXISTS post_flags (
    post_id        NUMERIC(78,0) NOT NULL REFERENCES posts (post_id) ON DELETE CASCADE,
    flagger_wallet CHAR(42) NOT NULL REFERENCES users (wallet_address),
    PRIMARY KEY (post_id, flagger_wallet)
);

CREATE TABLE IF NOT EXISTS comment_flags (
    comment_id     NUMERIC(78,0) NOT NULL REFERENCES comments (comment_id) ON DELETE CASCADE,
    flagger_wallet CHAR(42) NOT NULL REFERENCES users (wallet_address),
    PRIMARY KEY (comment_id, flagger_wallet)
);

-- =============================================================================
-- 11. TIPS
-- =============================================================================

CREATE TABLE IF NOT EXISTS tips (
    tip_id         BIGSERIAL   PRIMARY KEY,
    sender_wallet  CHAR(42)    NOT NULL REFERENCES users (wallet_address),
    recipient_wallet CHAR(42)  NOT NULL REFERENCES users (wallet_address),
    -- One of these two will be non-null; both null = tipDirect (no post/comment)
    post_id        NUMERIC(78,0) REFERENCES posts (post_id),
    comment_id     NUMERIC(78,0) REFERENCES comments (comment_id),
    amount_wei     NUMERIC(36,0) NOT NULL,
    tipped_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    log_index      INT         NOT NULL DEFAULT 0,
    tx_hash        CHAR(66)    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tips_sender ON tips (sender_wallet, tipped_at DESC);
CREATE INDEX IF NOT EXISTS idx_tips_recipient ON tips (recipient_wallet, tipped_at DESC);

-- Dedup: (tx_hash, log_index) uniquely identifies the on-chain log that
-- produced this row, so re-indexing a block (crash/restart before commit,
-- overlapping RPC log ranges, etc.) can't insert a second tip for the same event.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tips_tx_log ON tips (tx_hash, log_index);

-- Backs the "how much has this viewer personally tipped this post/comment"
-- lookup used by server.ts's USER_TIPPED_POST_SUBQUERY / _COMMENT_SUBQUERY.
CREATE INDEX IF NOT EXISTS idx_tips_post_sender    ON tips (post_id, sender_wallet);
CREATE INDEX IF NOT EXISTS idx_tips_comment_sender ON tips (comment_id, sender_wallet);

-- =============================================================================
-- 12. BADGE ENGINE
-- =============================================================================

-- Badge definitions table - each row is a badge type with its milestone info.
CREATE TABLE IF NOT EXISTS badge_definitions (
    badge_id        SERIAL       PRIMARY KEY,
    badge_key       VARCHAR(60)  NOT NULL UNIQUE,  -- machine key e.g. 'genesis_10'
    name            VARCHAR(100) NOT NULL,
    description     TEXT         NOT NULL,
    category        VARCHAR(20)  NOT NULL           -- 'genesis'|'karma'|'post'|'comment'|'forum'|'upvotes'|'members'
);

-- Seed the badge definitions
INSERT INTO badge_definitions (badge_key, name, description, category) VALUES
-- Genesis badges (first N users of DeReddit)
('genesis_10',   'Genesis Pioneer',  'You were among the first 10 users to join DeReddit.',    'genesis'),
('genesis_100',  'Genesis Founder',  'You were among the first 100 users to join DeReddit.',   'genesis'),
('genesis_1000', 'Genesis Settler',  'You were among the first 1,000 users to join DeReddit.', 'genesis'),
-- Karma milestones
('karma_10',     'Karma Seedling',   'You earned 10 karma.',                     'karma'),
('karma_100',    'Karma Sprout',     'You earned 100 karma.',                    'karma'),
('karma_1000',   'Karma Tree',       'You earned 1,000 karma.',                  'karma'),
-- Post milestones (posts authored)
('post_1st',     'First Post',       'You published your first post.',           'post'),
('post_10',      'Prolific Poster',  'You published 10 posts.',                  'post'),
('post_100',     'Post Legend',      'You published 100 posts.',                 'post'),
-- Comment milestones
('comment_1st',  'First Comment',    'You wrote your first comment.',             'comment'),
('comment_10',   'Active Voice',     'You wrote 10 comments.',                    'comment'),
('comment_100',  'Forum Veteran',    'You wrote 100 comments.',                   'comment'),
('comment_1000', 'Comment Legend',   'You wrote 1,000 comments.',                 'comment'),
-- Forum creation milestones
('forum_1st',    'Community Builder','You created your first forum.',            'forum'),
('forum_10',     'Forum Architect',  'You created 10 forums.',                   'forum'),
-- Post received upvotes milestones
('post_upvotes_10',   'Rising Star',     'One of your posts received 10 upvotes.',      'upvotes'),
('post_upvotes_100',  'Viral Moment',    'One of your posts received 100 upvotes.',     'upvotes'),
('post_upvotes_1000', 'Cultural Icon',   'One of your posts received 1,000 upvotes.',   'upvotes'),
-- Comment received upvotes milestones
('comment_upvotes_10',   'Sharp Reply',  'One of your comments received 10 upvotes.',    'upvotes'),
('comment_upvotes_100',  'Wit Merchant', 'One of your comments received 100 upvotes.',   'upvotes'),
('comment_upvotes_1000', 'Reply Legend', 'One of your comments received 1,000 upvotes.', 'upvotes'),
-- Forum member count milestones (for forum creators)
('forum_members_10',    'Small Town Mayor',  'Your forum reached 10 members.',      'members'),
('forum_members_100',   'Community Leader',  'Your forum reached 100 members.',     'members'),
('forum_members_1000',  'City Mayor',        'Your forum reached 1,000 members.',   'members'),
('forum_members_10000', 'Platform Pillar',   'Your forum reached 10,000 members.',  'members')
ON CONFLICT (badge_key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category;

-- User badge awards table
CREATE TABLE IF NOT EXISTS user_badges (
    wallet_address CHAR(42)  NOT NULL REFERENCES users (wallet_address),
    badge_id       INT       NOT NULL REFERENCES badge_definitions (badge_id),
    awarded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (wallet_address, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_wallet
    ON user_badges (wallet_address);

-- =============================================================================
-- 12b. NOTIFICATIONS
-- =============================================================================

CREATE TYPE notification_type AS ENUM ('tip', 'badge');

CREATE TABLE IF NOT EXISTS notifications (
    notification_id  BIGSERIAL           PRIMARY KEY,
    recipient_wallet  CHAR(42)           NOT NULL REFERENCES users (wallet_address),
    type              notification_type  NOT NULL,

    -- tip-specific (NULL for type='badge')
    tip_id            BIGINT             REFERENCES tips (tip_id),
    sender_wallet     CHAR(42),
    amount_wei        NUMERIC(36,0),
    post_id           NUMERIC(78,0)      REFERENCES posts (post_id),
    comment_id        NUMERIC(78,0)      REFERENCES comments (comment_id),

    -- badge-specific (NULL for type='tip')
    badge_id          INT                REFERENCES badge_definitions (badge_id),
    badge_key         VARCHAR(60),
    badge_name        VARCHAR(100),

    read_at           TIMESTAMPTZ        DEFAULT NULL,  -- NULL = unread
    created_at        TIMESTAMPTZ        NOT NULL DEFAULT NOW()
);

-- Dedup: one notification per tip event, one per (wallet, badge) first-earn.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_tip
    ON notifications (tip_id) WHERE type = 'tip';
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_badge
    ON notifications (recipient_wallet, badge_id) WHERE type = 'badge';

-- Bell/list fetch: newest-first per recipient.
CREATE INDEX IF NOT EXISTS idx_notifications_recipient
    ON notifications (recipient_wallet, created_at DESC);
-- Unread-count / unread-filter fetch.
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread
    ON notifications (recipient_wallet, created_at DESC) WHERE read_at IS NULL;

-- =============================================================================
-- 13. INDEXER CHECKPOINT  (resumable event cursor)
-- =============================================================================

CREATE TABLE IF NOT EXISTS indexer_state (
    key         VARCHAR(60) PRIMARY KEY,
    value       TEXT        NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the initial block cursor
INSERT INTO indexer_state (key, value) VALUES
    ('last_indexed_block', '0')
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- 14. MERKLE ANCHOR LOG  (mirrors on-chain verifiedDatabaseRoots)
-- =============================================================================

CREATE TABLE IF NOT EXISTS merkle_anchors (
    block_number  BIGINT      PRIMARY KEY,
    merkle_root   CHAR(66)    NOT NULL,
    anchored_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 14b. INDEXER ERROR AUDIT LOG  (per-event failures that were caught and
--      skipped rather than aborting the whole block)
-- =============================================================================

CREATE TABLE IF NOT EXISTS indexer_errors (
    id             SERIAL PRIMARY KEY,
    block_number   INT         NOT NULL,
    tx_hash        VARCHAR(66) NOT NULL,
    event_name     VARCHAR(64),
    error_message  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 15. RECOMMENDATION HELPER VIEW
-- =============================================================================

-- Single popularity-score view, computed on demand instead of being
-- maintained by hand on stored columns after every mutating event:
--   score_engagement = (total_upvotes + post_count + comment_count) / NULLIF(member_count, 0)
CREATE OR REPLACE VIEW v_forums_by_score AS
SELECT
    f.forum_key,
    f.name,
    f.description,
    f.category,
    f.tags,
    f.creator_wallet,
    f.icon_cid,
    f.banner_cid,
    f.member_count,
    f.post_count,
    f.comment_count,
    f.created_at,
    ROUND(
      CAST((f.total_upvotes + f.post_count + f.comment_count) AS NUMERIC) / NULLIF(f.member_count, 0),
      4
    ) AS forum_popularity_score
FROM forums f
ORDER BY forum_popularity_score DESC NULLS LAST;

-- =============================================================================
-- 16. FULL-TEXT SEARCH CONFIGURATION
-- =============================================================================

-- Combined forum search document (name + description + tags joined)
ALTER TABLE forums ADD COLUMN IF NOT EXISTS fts_document TSVECTOR;

CREATE OR REPLACE FUNCTION forums_fts_trigger() RETURNS TRIGGER AS $$
BEGIN
    NEW.fts_document :=
        setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
        setweight(to_tsvector('english', array_to_string(NEW.tags, ' ')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_forums_fts
    BEFORE INSERT OR UPDATE ON forums
    FOR EACH ROW EXECUTE FUNCTION forums_fts_trigger();

CREATE INDEX IF NOT EXISTS idx_forums_fts
    ON forums USING GIN (fts_document);