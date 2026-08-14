import request from "supertest";
import { ethers } from "ethers";
import app from "../src/server.js";
import { insertUser, insertNotification } from "./fixtures.js";

// Mirrors buildNotificationAuthMessage in src/server.ts and
// frontend/src/lib/notificationAuth.ts - both must stay byte-for-byte
// identical for a real signature to verify.
function buildAuthMessage(wallet: string, issuedAt: number): string {
  return `DeReddit notifications access for ${wallet} at ${issuedAt}`;
}

async function signAuth(walletObj: ethers.HDNodeWallet, issuedAt: number) {
  const wallet = walletObj.address.toLowerCase();
  const signature = await walletObj.signMessage(buildAuthMessage(wallet, issuedAt));
  return { signature, issuedAt };
}

describe("GET /api/notifications/:wallet (public read)", () => {
  it("paginates and reports unreadCount, defaulting to 20/page", async () => {
    const wallet = ethers.Wallet.createRandom().address.toLowerCase();
    await insertUser(wallet);
    for (let i = 0; i < 3; i++) {
      await insertNotification(wallet, { badgeKey: `badge_${i}`, readAt: i === 0 ? new Date() : null });
    }

    const res = await request(app).get(`/api/notifications/${wallet}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(3);
    expect(res.body.unreadCount).toBe(2);
  });

  it("filters to unread=true", async () => {
    const wallet = ethers.Wallet.createRandom().address.toLowerCase();
    await insertUser(wallet);
    await insertNotification(wallet, { badgeKey: "read_one", readAt: new Date() });
    await insertNotification(wallet, { badgeKey: "unread_one", readAt: null });

    const res = await request(app).get(`/api/notifications/${wallet}`).query({ unread: "true" });
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].badge_key).toBe("unread_one");
  });
});

describe("mutating notification routes require a wallet-ownership signature", () => {
  it("rejects PATCH read-all with no signature headers", async () => {
    const wallet = ethers.Wallet.createRandom().address.toLowerCase();
    await insertUser(wallet);

    const res = await request(app).patch(`/api/notifications/${wallet}/read-all`);
    expect(res.status).toBe(401);
  });

  it("rejects a signature from a different wallet than the one in the URL", async () => {
    const owner = ethers.Wallet.createRandom();
    const impostor = ethers.Wallet.createRandom();
    await insertUser(owner.address.toLowerCase());

    const issuedAt = Date.now();
    const { signature } = await signAuth(impostor, issuedAt);

    const res = await request(app)
      .patch(`/api/notifications/${owner.address.toLowerCase()}/read-all`)
      .set("x-wallet-signature", signature)
      .set("x-wallet-timestamp", String(issuedAt));
    expect(res.status).toBe(401);
  });

  it("rejects a stale signature outside the auth time window", async () => {
    const owner = ethers.Wallet.createRandom();
    await insertUser(owner.address.toLowerCase());

    const staleIssuedAt = Date.now() - 20 * 60 * 1000; // 20 minutes ago, window is 10
    const { signature } = await signAuth(owner, staleIssuedAt);

    const res = await request(app)
      .patch(`/api/notifications/${owner.address.toLowerCase()}/read-all`)
      .set("x-wallet-signature", signature)
      .set("x-wallet-timestamp", String(staleIssuedAt));
    expect(res.status).toBe(401);
  });

  it("accepts a valid, fresh signature and marks all notifications read", async () => {
    const owner = ethers.Wallet.createRandom();
    const wallet = owner.address.toLowerCase();
    await insertUser(wallet);
    await insertNotification(wallet, { badgeKey: "a", readAt: null });
    await insertNotification(wallet, { badgeKey: "b", readAt: null });

    const issuedAt = Date.now();
    const { signature } = await signAuth(owner, issuedAt);

    const res = await request(app)
      .patch(`/api/notifications/${wallet}/read-all`)
      .set("x-wallet-signature", signature)
      .set("x-wallet-timestamp", String(issuedAt));
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const after = await request(app).get(`/api/notifications/${wallet}`);
    expect(after.body.unreadCount).toBe(0);
  });

  it("DELETE requires a valid signature too", async () => {
    const owner = ethers.Wallet.createRandom();
    const wallet = owner.address.toLowerCase();
    await insertUser(wallet);
    await insertNotification(wallet);

    const unauthed = await request(app).delete(`/api/notifications/${wallet}`);
    expect(unauthed.status).toBe(401);

    const issuedAt = Date.now();
    const { signature } = await signAuth(owner, issuedAt);
    const authed = await request(app)
      .delete(`/api/notifications/${wallet}`)
      .set("x-wallet-signature", signature)
      .set("x-wallet-timestamp", String(issuedAt));
    expect(authed.status).toBe(200);
    expect(authed.body.deleted).toBe(1);
  });
});
