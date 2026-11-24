// Lights Out: the account page as a test sees it (sign up, sign in, sign out, join the group).
// Every helper waits for the page's own confirmation message, so a test never races the network.
const crypto = require("crypto");
const { expect } = require("@playwright/test");

// A brand-new made-up player. The random part keeps runs independent: no clean-up is needed between runs.
function makeUser(label) {
  const id = crypto.randomBytes(4).toString("hex");
  return {
    email: "e2e-" + (label || "player") + "-" + id + "@lightsout.test",
    password: "Test-Pass-1234",
    displayName: "E2E " + id
  };
}

async function openAccount(page, query) {
  await page.goto("/account.html" + (query || ""));
  await expect(page.locator("#signed-out-view")).toBeVisible();
}

async function openSettings(page) {
  await page.locator("button.ac-tab", { hasText: "Settings" }).click();
  await expect(page.locator("#ac")).toHaveAttribute("data-view", "settings");
}

async function signUp(page, user) {
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.locator("#sign-up-button").click();
  await expect(page.locator("#auth-message")).toHaveText("Account created. You are signed in.");
  await expect(page.locator("#signed-in-email")).toHaveText(user.email);
}

async function signIn(page, user, password) {
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(password === undefined ? user.password : password);
  await page.locator("#sign-in-button").click();
}

async function signOut(page) {
  await openSettings(page);
  await page.locator("#sign-out-button").click();
  await expect(page.locator("#auth-message")).toHaveText("Signed out.");
  await expect(page.locator("#signed-out-view")).toBeVisible();
}

async function joinGroup(page, displayName, code) {
  await openSettings(page);
  await page.locator("#join-name").fill(displayName);
  await page.locator("#join-code").fill(code);
  await page.locator("#join-button").click();
}

module.exports = { makeUser, openAccount, openSettings, signUp, signIn, signOut, joinGroup };
