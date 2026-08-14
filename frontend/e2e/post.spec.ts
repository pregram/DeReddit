import { test, expect } from "@playwright/test";
import { installMockWallet } from "./mockWallet";
import { WALLET_A, userResponse, forumDetailResponse, postDetailResponse, onePixelPngBuffer } from "./fixtures";

const FORUM_KEY = "0x" + "11".repeat(32);
const POST_ID = "1";

test.describe("Create-post form + voting/tipping UI", () => {
  test("fills out the create-post form with a media attachment and reaches a ready-to-submit state", async ({ page }) => {
    await installMockWallet(page, WALLET_A);
    await page.route(`**/api/users/${WALLET_A}`, (route) => route.fulfill({ json: userResponse() }));
    await page.route(`**/api/forums/${FORUM_KEY}`, (route) => route.fulfill({ json: forumDetailResponse() }));

    await page.goto(`/f/${FORUM_KEY}/submit`);

    await page.getByLabel("Title").fill("Hello DeReddit");
    await page.getByLabel("Body").fill("This is my first post with an image attached.");
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "photo.png",
      mimeType: "image/png",
      buffer: onePixelPngBuffer(),
    });

    await expect(page.getByLabel("Title")).toHaveValue("Hello DeReddit");
    await expect(page.getByRole("button", { name: "Broadcast Transaction" })).toBeEnabled();
  });

  test("voting while disconnected opens the wallet-connect interceptor instead of silently failing", async ({ page }) => {
    await page.route(`**/api/posts/${POST_ID}**`, (route) => route.fulfill({ json: postDetailResponse() }));
    await page.route(`**/api/posts/${POST_ID}/comments**`, (route) =>
      route.fulfill({ json: { comments: [], count: 0, hasMore: false } })
    );
    await page.route(`**/api/forums/${FORUM_KEY}`, (route) => route.fulfill({ json: forumDetailResponse() }));

    await page.goto(`/f/${FORUM_KEY}/p/${POST_ID}`);
    await expect(page.getByRole("heading", { name: "Hello DeReddit" })).toBeVisible();

    await page.getByRole("button", { name: "Upvote" }).click();
    await expect(page.getByRole("button", { name: "Connect Wallet" }).last()).toBeVisible();
  });

  test("renders the already-upvoted state from the API and opens the tip popover", async ({ page }) => {
    await installMockWallet(page, WALLET_A);
    await page.route(`**/api/users/${WALLET_A}`, (route) => route.fulfill({ json: userResponse() }));
    await page.route(`**/api/forums/${FORUM_KEY}`, (route) => route.fulfill({ json: forumDetailResponse() }));
    await page.route(`**/api/posts/${POST_ID}**`, (route) =>
      route.fulfill({ json: postDetailResponse({ user_vote: 1 }) })
    );
    await page.route(`**/api/posts/${POST_ID}/comments**`, (route) =>
      route.fulfill({ json: { comments: [], count: 0, hasMore: false } })
    );

    await page.goto(`/f/${FORUM_KEY}/p/${POST_ID}`);

    await expect(page.getByRole("button", { name: "Remove upvote" })).toBeVisible();

    await page.getByRole("button", { name: "Tip" }).click();
    await expect(page.getByLabel("Amount (ETH)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send Tip" })).toBeVisible();
  });
});
