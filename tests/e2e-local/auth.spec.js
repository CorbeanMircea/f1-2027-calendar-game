// Lights Out: signing up, signing in and out, and staying signed in (browser tests against the LOCAL Supabase stack).
// Every test creates its own made-up player, so tests are independent and can run in parallel and in any order.
const { test, expect } = require("../fixtures/app");
const { makeUser, openAccount, openSettings, signUp, signIn, signOut } = require("../fixtures/account");

test.describe("authentication", function () {
  test("a visitor who is not signed in sees the sign-in form", async function ({ page }) {
    await openAccount(page);
    await expect(page.locator("#auth-form")).toBeVisible();
    await expect(page.locator("#sign-in-button")).toBeVisible();
    await expect(page.locator("#sign-up-button")).toBeVisible();
    await expect(page.locator("#signed-in-view")).toBeHidden();
  });

  test("a bad e-mail address or a short password is refused before anything is sent", async function ({ page }) {
    await openAccount(page);
    const authCalls = [];
    page.on("request", function (req) { if (req.url().indexOf("/auth/v1/") !== -1) { authCalls.push(req.url()); } });

    await page.locator("#email").fill("not-an-email");
    await page.locator("#password").fill("Test-Pass-1234");
    await page.locator("#sign-up-button").click();
    await expect(page.locator("#auth-message")).toHaveText("Please enter a valid email address.");
    await expect(page.locator("#auth-message")).toHaveClass(/\berror\b/);

    await page.locator("#email").fill("someone@lightsout.test");
    await page.locator("#password").fill("short");
    await page.locator("#sign-up-button").click();
    await expect(page.locator("#auth-message")).toHaveText("Password must be at least 8 characters.");

    expect(authCalls, "no sign-in or sign-up request may be made for invalid input").toEqual([]);
  });

  test("a new player can create an account and is signed in straight away", async function ({ page }) {
    const user = makeUser("signup");
    await openAccount(page);
    await signUp(page, user);
    await expect(page.locator("#signed-out-view")).toBeHidden();
    await expect(page.locator("#signed-in-view")).toBeVisible();
  });

  test("the same e-mail address cannot be registered twice", async function ({ page, context }) {
    const user = makeUser("twice");
    await openAccount(page);
    await signUp(page, user);
    await signOut(page);

    await signIn(page, user, "Another-Pass-5678"); // wrong password, same address: must not get in either
    await expect(page.locator("#auth-message")).toHaveClass(/\berror\b/);

    await page.locator("#email").fill(user.email);
    await page.locator("#password").fill(user.password);
    await page.locator("#sign-up-button").click();
    await expect(page.locator("#auth-message")).toHaveClass(/\berror\b/);
    await expect(page.locator("#signed-out-view")).toBeVisible();
  });

  test("the session survives a page reload", async function ({ page }) {
    const user = makeUser("reload");
    await openAccount(page);
    await signUp(page, user);

    await page.reload();
    await expect(page.locator("#signed-out-view")).toBeHidden();
    await expect(page.locator("#signed-in-email")).toHaveText(user.email);
  });

  test("the session is shared with the other pages of the site", async function ({ page }) {
    const user = makeUser("shared");
    await openAccount(page);
    await signUp(page, user);

    await page.goto("/index.html");
    await expect(page.locator("nav.lo-nav")).toBeVisible();
    await page.goto("/account.html");
    await expect(page.locator("#signed-in-email")).toHaveText(user.email);
  });

  test("signing out returns to the sign-in form and stays signed out after a reload", async function ({ page }) {
    const user = makeUser("signout");
    await openAccount(page);
    await signUp(page, user);
    await signOut(page);

    await page.reload();
    await expect(page.locator("#signed-out-view")).toBeVisible();
    await expect(page.locator("#signed-in-view")).toBeHidden();
  });

  test("a wrong password is refused and the player stays signed out", async function ({ page }) {
    const user = makeUser("wrongpw");
    await openAccount(page);
    await signUp(page, user);
    await signOut(page);

    await signIn(page, user, "Not-The-Password-9");
    await expect(page.locator("#auth-message")).toHaveClass(/\berror\b/);
    await expect(page.locator("#auth-message")).not.toHaveText("");
    await expect(page.locator("#signed-out-view")).toBeVisible();
  });

  test("signing in again with the right password works", async function ({ page }) {
    const user = makeUser("signin");
    await openAccount(page);
    await signUp(page, user);
    await signOut(page);

    await signIn(page, user);
    await expect(page.locator("#auth-message")).toHaveText("Signed in.");
    await expect(page.locator("#signed-in-email")).toHaveText(user.email);
    await openSettings(page);
    await expect(page.locator("#sign-out-button")).toBeVisible();
  });
});
