// Lights Out: joining the friends group with the invite code (browser tests against the LOCAL Supabase stack).
// The invite code and the seed players ("Seed Player 1" ...) come from tests/db/seed.sql (npm run db:fresh).
const { test, expect } = require("../fixtures/app");
const { LOCAL_INVITE_CODE } = require("../fixtures/local-env");
const { makeUser, openAccount, openSettings, signUp, joinGroup } = require("../fixtures/account");

test.describe("joining the group", function () {
  test("a new player without a group is offered the join form", async function ({ page }) {
    await openAccount(page);
    await signUp(page, makeUser("nojoin"));
    await openSettings(page);
    await expect(page.locator("#join-section")).toBeVisible();
    await expect(page.locator("#member-section")).toBeHidden();
  });

  test("a wrong invite code is refused", async function ({ page }) {
    const user = makeUser("badcode");
    await openAccount(page);
    await signUp(page, user);
    await joinGroup(page, user.displayName, "NOT-A-REAL-CODE");
    await expect(page.locator("#auth-message")).toHaveText("Invalid invite code");
    await expect(page.locator("#auth-message")).toHaveClass(/\berror\b/);
    await expect(page.locator("#member-section")).toBeHidden();
  });

  test("a display name that is too short is refused before anything is sent", async function ({ page }) {
    await openAccount(page);
    await signUp(page, makeUser("shortname"));
    const rpcCalls = [];
    page.on("request", function (req) { if (req.url().indexOf("/rpc/join_group") !== -1) { rpcCalls.push(req.url()); } });

    await joinGroup(page, "A", LOCAL_INVITE_CODE);
    await expect(page.locator("#auth-message")).toHaveText("Display name must be 2 to 30 characters.");
    expect(rpcCalls).toEqual([]);
  });

  test("a display name that is already taken is refused", async function ({ page }) {
    await openAccount(page);
    await signUp(page, makeUser("taken"));
    await joinGroup(page, "Seed Player 1", LOCAL_INVITE_CODE);
    await expect(page.locator("#auth-message")).toHaveClass(/\berror\b/);
    await expect(page.locator("#auth-message")).toContainText("already taken");
    await expect(page.locator("#member-section")).toBeHidden();
  });

  test("the right invite code joins the group", async function ({ page }) {
    const user = makeUser("joins");
    await openAccount(page);
    await signUp(page, user);
    await joinGroup(page, user.displayName, LOCAL_INVITE_CODE);

    await expect(page.locator("#auth-message")).toHaveText("Welcome to the group!");
    await expect(page.locator("#member-section")).toBeVisible();
    await expect(page.locator("#member-group")).toHaveText("Lights Out Test Group");
    await expect(page.locator("#member-name")).toHaveText(user.displayName);
    await expect(page.locator("#member-role")).toHaveText("member");
    await expect(page.locator("#join-section")).toBeHidden();
  });

  test("membership is remembered after a reload", async function ({ page }) {
    const user = makeUser("remember");
    await openAccount(page);
    await signUp(page, user);
    await joinGroup(page, user.displayName, LOCAL_INVITE_CODE);
    await expect(page.locator("#member-group")).toHaveText("Lights Out Test Group");

    await page.reload();
    await openSettings(page);
    await expect(page.locator("#member-group")).toHaveText("Lights Out Test Group");
    await expect(page.locator("#member-name")).toHaveText(user.displayName);
    await expect(page.locator("#join-section")).toBeHidden();
  });

  test("an invite link announces the invitation and fills in the code after sign-up", async function ({ page }) {
    const user = makeUser("invited");
    await openAccount(page, "?invite=" + LOCAL_INVITE_CODE);
    await expect(page.locator(".wl-invite")).toBeVisible();

    await signUp(page, user);
    await openSettings(page);
    await expect(page.locator("#join-code")).toHaveValue(LOCAL_INVITE_CODE);

    await page.locator("#join-name").fill(user.displayName);
    await page.locator("#join-button").click();
    await expect(page.locator("#auth-message")).toHaveText("Welcome to the group!");
  });

  test("a player who has joined sees the group on the account page for the rest of the session", async function ({ page }) {
    const user = makeUser("session");
    await openAccount(page);
    await signUp(page, user);
    await joinGroup(page, user.displayName, LOCAL_INVITE_CODE);
    await expect(page.locator("#member-section")).toBeVisible();

    await page.goto("/index.html");
    await page.goto("/account.html#settings");
    await expect(page.locator("#member-group")).toHaveText("Lights Out Test Group");
  });
});
