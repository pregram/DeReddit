// Feeds synthetic decoded event logs straight through the indexer's real
// dispatch functions (exported from src/indexer.ts for exactly this purpose)
// and asserts the resulting Postgres rows, without needing a live RPC
// provider or chain - dispatchCoreEvent/dispatchEscrowEvent only need a
// PoolClient + a {name, args} pair shaped like ethers.LogDescription.
import { ethers } from "ethers";
import type { PoolClient } from "pg";
import pool from "../src/db.js";
import { runInTransaction } from "../src/utils/tx.js";
import { dispatchCoreEvent } from "../src/indexer.js";

function fakeAddr(seed: string): string {
  return ethers.getAddress(ethers.keccak256(ethers.toUtf8Bytes(seed)).slice(0, 42));
}

function fakeB32(seed: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(seed));
}

function coreLog(name: string, args: unknown[]) {
  return { name, args } as unknown as ethers.LogDescription;
}

const BLOCK_TS = 1_700_000_000;
const TX_HASH = fakeB32("tx");

async function dispatch(name: string, args: unknown[], logIndex = 0) {
  return runInTransaction((client: PoolClient) =>
    dispatchCoreEvent(client, coreLog(name, args), BLOCK_TS, logIndex, TX_HASH)
  );
}

describe("indexer - event dispatch writes accurate Postgres records", () => {
  it("UserRegistered: inserts a users row with decoded username + profile CID", async () => {
    const wallet = fakeAddr("alice");
    const username = ethers.encodeBytes32String("alice");
    const profileCid = fakeB32("QmProfile");

    await dispatch("UserRegistered", [wallet, username, profileCid]);

    const { rows } = await pool.query(
      "SELECT wallet_address, username, profile_cid, karma FROM users WHERE wallet_address = $1",
      [wallet.toLowerCase()]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe("alice");
    expect(rows[0].profile_cid).toBe(profileCid);
    expect(Number(rows[0].karma)).toBe(0);
  });

  it("UserRegistered: a non-UTF8 username falls back to a placeholder instead of throwing (poison-block hardening)", async () => {
    const wallet = fakeAddr("mallory");
    // 0xff is not valid UTF-8 on its own - b32str() must catch and fall back.
    const malformedUsername = "0xff" + "00".repeat(31);
    const profileCid = fakeB32("QmProfile");

    await dispatch("UserRegistered", [wallet, malformedUsername, profileCid]);

    const { rows } = await pool.query(
      "SELECT username FROM users WHERE wallet_address = $1",
      [wallet.toLowerCase()]
    );
    expect(rows[0].username).toMatch(/^invalid_/);
  });

  it("ProfileCIDUpdated: updates profile_cid on an already-registered user", async () => {
    const wallet = fakeAddr("bob");
    await dispatch("UserRegistered", [wallet, ethers.encodeBytes32String("bob"), fakeB32("old-cid")]);

    const newCid = fakeB32("new-cid");
    await dispatch("ProfileCIDUpdated", [wallet, newCid]);

    const { rows } = await pool.query("SELECT profile_cid FROM users WHERE wallet_address = $1", [wallet.toLowerCase()]);
    expect(rows[0].profile_cid).toBe(newCid);
  });
});

describe("indexer - IPFS JSON payload fetching", () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("ForumCreated: mirrors icon/banner/category/tags from a successfully fetched IPFS JSON blob", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        name: "Technology Forum",
        description: "All things tech",
        category: "Technology",
        tags: ["ai", "hardware"],
      }),
    } as Response);

    const creator = fakeAddr("forum-creator");
    const forumKey = fakeB32("tech-forum");
    await dispatch("ForumCreated", [forumKey, creator, 10n, fakeB32("forum-cid")]);

    const { rows } = await pool.query(
      "SELECT name, description, category, tags FROM forums WHERE forum_key = $1",
      [forumKey.toLowerCase()]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Technology Forum");
    expect(rows[0].category).toBe("Technology");
    expect(rows[0].tags).toEqual(["ai", "hardware"]);
  });

  it("ForumCreated: degrades gracefully to placeholder metadata when the IPFS gateway is unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const creator = fakeAddr("forum-creator-2");
    const forumKey = fakeB32("unreachable-forum");
    await dispatch("ForumCreated", [forumKey, creator, 10n, fakeB32("forum-cid-2")]);

    const { rows } = await pool.query(
      "SELECT name, description, category FROM forums WHERE forum_key = $1",
      [forumKey.toLowerCase()]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(`Forum ${forumKey.toLowerCase().slice(0, 10)}`);
    expect(rows[0].description).toBeNull();
    expect(rows[0].category).toBe("General");
  });

  it("PostCreated: a non-200 gateway response falls back to the '[Metadata Unavailable]' placeholder without throwing", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) } as Response);

    const author = fakeAddr("post-author");
    const forumKey = fakeB32("some-forum");
    await dispatch("UserRegistered", [author, ethers.encodeBytes32String("poster"), fakeB32("cid")]);
    await dispatch(
      "ForumCreated",
      [forumKey, author, 10n, fakeB32("forum-cid-3")],
      1
    );

    const postId = 1n;
    await dispatch(
      "PostCreated",
      [postId, author, forumKey, 0, 0, fakeB32("post-cid")],
      2
    );

    const { rows } = await pool.query("SELECT title, body FROM posts WHERE post_id = $1", [String(postId)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("[Metadata Unavailable]");
    expect(rows[0].body).toMatch(/could not be retrieved/i);
  });
});

describe("indexer - per-event SAVEPOINT isolation", () => {
  // Mirrors processBlock's per-log SAVEPOINT loop (src/indexer.ts) at a
  // smaller scale: one bad event inside a block must not roll back events
  // that were already applied earlier in the same transaction.
  it("rolls back only the failing event's writes, keeping earlier writes in the same transaction", async () => {
    const goodWallet = fakeAddr("good-user");
    const badWallet = fakeAddr("bad-user");

    await runInTransaction(async (client) => {
      await client.query("SAVEPOINT event_sp");
      await dispatchCoreEvent(
        client,
        coreLog("UserRegistered", [goodWallet, ethers.encodeBytes32String("good"), fakeB32("cid")]),
        BLOCK_TS,
        0,
        TX_HASH
      );
      await client.query("RELEASE SAVEPOINT event_sp");

      await client.query("SAVEPOINT event_sp");
      try {
        // Missing tuple elements fail zod parsing inside the handler, which
        // throws - the same failure mode a malformed/unexpected log shape
        // would trigger in production.
        await dispatchCoreEvent(
          client,
          coreLog("UserRegistered", [badWallet]),
          BLOCK_TS,
          1,
          TX_HASH
        );
        await client.query("RELEASE SAVEPOINT event_sp");
      } catch {
        await client.query("ROLLBACK TO SAVEPOINT event_sp");
        await client.query("RELEASE SAVEPOINT event_sp");
      }
    });

    const { rows } = await pool.query(
      "SELECT wallet_address FROM users WHERE wallet_address IN ($1, $2)",
      [goodWallet.toLowerCase(), badWallet.toLowerCase()]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].wallet_address).toBe(goodWallet.toLowerCase());
  });
});
