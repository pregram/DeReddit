import { test, expect } from "@playwright/test";
import { installMockWallet } from "./mockWallet";
import { WALLET_A, WALLET_B, userResponse, onePixelPngBuffer } from "./fixtures";

// The mock wallet's eth_accounts always returns an already-authorized
// account (mirrors a real MetaMask session that was connected before), so
// WalletContext's silent restore (eth_accounts on mount, see
// WalletContext.tsx) connects automatically - no "Connect Wallet" click
// needed, same as a returning user refreshing the page.
test.describe("Wallet auto-connects on load + view/edit profile", () => {
  test("an already-authorized wallet shows the registered username and karma in the header", async ({ page }) => {
    await installMockWallet(page, WALLET_A);
    await page.route(`**/api/users/${WALLET_A}`, (route) =>
      route.fulfill({ json: userResponse() })
    );

    await page.goto("/");

    await expect(page.getByRole("link", { name: /u\/alice/ })).toBeVisible();
    await expect(page.getByText("42 karma")).toBeVisible();
  });

  test("own profile page offers a 'Change avatar' flow that accepts an image file", async ({ page }) => {
    await installMockWallet(page, WALLET_A);
    await page.route(`**/api/users/${WALLET_A}`, (route) =>
      route.fulfill({ json: userResponse() })
    );
    await page.route(`**/api/users/${WALLET_A}/posts`, (route) => route.fulfill({ json: { posts: [] } }));
    await page.route(`**/api/users/${WALLET_A}/comments`, (route) => route.fulfill({ json: { comments: [] } }));
    await page.route(`**/api/users/${WALLET_A}/contributions`, (route) => route.fulfill({ json: { contributions: [] } }));

    await page.goto("/");
    await expect(page.getByRole("link", { name: /u\/alice/ })).toBeVisible();
    await page.getByRole("link", { name: /u\/alice/ }).click();

    await expect(page).toHaveURL(new RegExp(`/u/${WALLET_A}`, "i"));
    await page.getByRole("button", { name: "Change avatar" }).click();

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: onePixelPngBuffer(),
    });

    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  test("viewing another user's profile does not show edit controls", async ({ page }) => {
    await installMockWallet(page, WALLET_A);
    await page.route(`**/api/users/${WALLET_A}`, (route) => route.fulfill({ json: userResponse() }));
    await page.route(`**/api/users/${WALLET_B}`, (route) =>
      route.fulfill({ json: userResponse({ wallet_address: WALLET_B, username: "bob", karma: "7" }) })
    );
    await page.route(`**/api/users/${WALLET_B}/posts`, (route) => route.fulfill({ json: { posts: [] } }));
    await page.route(`**/api/users/${WALLET_B}/comments`, (route) => route.fulfill({ json: { comments: [] } }));
    await page.route(`**/api/users/${WALLET_B}/contributions`, (route) => route.fulfill({ json: { contributions: [] } }));

    await page.goto(`/u/${WALLET_B}`);

    await expect(page.getByText(/u\/bob/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Change avatar" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Set Username & Avatar" })).toHaveCount(0);
  });
});
