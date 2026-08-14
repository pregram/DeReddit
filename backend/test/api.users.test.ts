import request from "supertest";
import app from "../src/server.js";
import { fakeAddr, fakeB32, insertUser, insertForum, insertPost } from "./fixtures.js";
import pool from "../src/db.js";

describe("GET /api/users/:wallet", () => {
  it("404s for an unknown wallet", async () => {
    const res = await request(app).get(`/api/users/${fakeAddr("nobody")}`);
    expect(res.status).toBe(404);
  });

  it("returns user profile, badges and joined forums", async () => {
    const wallet = fakeAddr("profile-user");
    await insertUser(wallet, { username: "alice", karma: 42 });

    const res = await request(app).get(`/api/users/${wallet}`);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("alice");
    expect(Number(res.body.user.karma)).toBe(42);
    expect(res.body.badges).toEqual([]);
    expect(res.body.forums).toEqual([]);
  });
});

describe("GET /api/users/:wallet/posts", () => {
  it("lists posts authored by the wallet, newest first, hiding unrevealed TimeCapsule titles", async () => {
    const wallet = fakeAddr("poster");
    const forumKey = fakeB32("forum-userposts");
    await insertUser(wallet);
    await insertForum(forumKey, wallet);
    await insertPost(1, forumKey, wallet, { title: "Old Standard" });
    await insertPost(2, forumKey, wallet, {
      title: "Future Secret",
      postType: "TimeCapsule",
      visibleAfter: new Date(Date.now() + 60_000),
    });

    const res = await request(app).get(`/api/users/${wallet}/posts`);
    expect(res.status).toBe(200);
    const byId: Record<string, unknown> = Object.fromEntries(
      res.body.posts.map((p: { post_id: string; title: string | null }) => [p.post_id, p.title])
    );
    expect(byId["1"]).toBe("Old Standard");
    expect(byId["2"]).toBeNull();
  });
});

describe("GET /api/users/:wallet/tips-received", () => {
  it("returns totalWei: '0' when ?from= is missing, without erroring", async () => {
    const wallet = fakeAddr("tip-recipient");
    await insertUser(wallet);

    const res = await request(app).get(`/api/users/${wallet}/tips-received`);
    expect(res.status).toBe(200);
    expect(res.body.totalWei).toBe("0");
  });

  it("sums only tips from the given sender", async () => {
    const recipient = fakeAddr("tip-recipient-2");
    const senderA = fakeAddr("tip-sender-a");
    const senderB = fakeAddr("tip-sender-b");
    await insertUser(recipient);
    await insertUser(senderA);
    await insertUser(senderB);
    await pool.query(
      `INSERT INTO tips (sender_wallet, recipient_wallet, amount_wei, tx_hash, tipped_at)
       VALUES ($1, $2, $3, $4, NOW()), ($5, $2, $6, $7, NOW())`,
      [senderA, recipient, "1000", fakeB32("tx1"), senderB, "5000", fakeB32("tx2")]
    );

    const res = await request(app).get(`/api/users/${recipient}/tips-received`).query({ from: senderA });
    expect(res.status).toBe(200);
    expect(res.body.totalWei).toBe("1000");
  });
});
