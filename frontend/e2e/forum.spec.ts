import { test, expect } from "@playwright/test";
import { installMockWallet } from "./mockWallet";
import { WALLET_A, userResponse, forumDetailResponse, forumSummary, onePixelPngBuffer } from "./fixtures";

const FORUM_KEY = "0x" + "11".repeat(32);

test.describe("Create-forum form + ForumCard/ForumHubPage rendering", () => {
  test("fills out the create-forum form, including icon/banner uploads, and reaches a ready-to-submit state", async ({ page }) => {
    await installMockWallet(page, WALLET_A);
    await page.route(`**/api/users/${WALLET_A}`, (route) => route.fulfill({ json: userResponse() }));

    await page.goto("/forums/new");

    await page.getByLabel("Community Handle").fill("SolidityDevs");
    await page.getByLabel("Description").fill("A forum for Solidity developers.");
    await page.getByLabel("Community Rules").fill("1. Be respectful.");
    await page.getByLabel("Minimum Karma to Flag Content").fill("10");

    const fileInputs = page.locator('input[type="file"]');
    await fileInputs.nth(0).setInputFiles({ name: "icon.png", mimeType: "image/png", buffer: onePixelPngBuffer() });
    await fileInputs.nth(1).setInputFiles({ name: "banner.png", mimeType: "image/png", buffer: onePixelPngBuffer() });

    await expect(page.getByLabel("Community Handle")).toHaveValue("SolidityDevs");
    await expect(page.getByRole("button", { name: "Broadcast Forum Setup" })).toBeEnabled();
  });

  test("ForumHubPage renders the forum's name, member count, and Create Post action from the API", async ({ page }) => {
    await installMockWallet(page, WALLET_A);
    await page.route(`**/api/users/${WALLET_A}`, (route) => route.fulfill({ json: userResponse() }));
    await page.route(`**/api/forums/${FORUM_KEY}`, (route) => route.fulfill({ json: forumDetailResponse() }));
    await page.route(`**/api/forums/${FORUM_KEY}/posts**`, (route) => route.fulfill({ json: { posts: [], count: 0 } }));

    await page.goto(`/f/${FORUM_KEY}`);

    await expect(page.getByRole("heading", { name: "r/Technology" })).toBeVisible();
    await expect(page.getByText("128 members")).toBeVisible();
    await expect(page.getByRole("link", { name: "Create Post" })).toBeVisible();
  });

  test("ForumCard on the discovery page shows the forum name and member count", async ({ page }) => {
    await page.route("**/api/forums?**", (route) =>
      route.fulfill({ json: { forums: [forumSummary()], count: 1 } })
    );
    await page.route("**/api/forums/tags**", (route) => route.fulfill({ json: { tags: [] } }));

    await page.goto("/forums");

    await expect(page.getByText("r/Technology")).toBeVisible();
    await expect(page.getByText("128 members")).toBeVisible();
  });
});
