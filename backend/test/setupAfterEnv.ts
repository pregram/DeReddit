// Jest `setupFilesAfterEnv` - runs inside each test file's own worker/module
// registry (unlike globalSetup), so `pool` here is the same singleton the
// test file's imports of db.ts/server.ts/indexer.ts will resolve to.
import pool from "../src/db.js";

// badge_definitions is static reference/seed data (see init.sql), not
// per-test fixture data - never truncate it.
const TABLES = [
  "users",
  "forums",
  "forum_tags",
  "forum_memberships",
  "posts",
  "poll_options",
  "poll_votes",
  "crowdfund_contributions",
  "comments",
  "post_votes",
  "comment_votes",
  "post_flags",
  "comment_flags",
  "tips",
  "user_badges",
  "notifications",
  "indexer_state",
  "merkle_anchors",
  "indexer_errors",
];

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await pool.end();
});
