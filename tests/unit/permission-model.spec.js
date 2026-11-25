// Lights Out: the written-down permission model must be self-consistent (T5). No database, no network.
const { test, expect } = require("@playwright/test");
const model = require("../fixtures/permission-model");

function unique(list) { return new Set(list).size === list.length; }

test.describe("permission model data", function () {
  test("has no duplicates and every list is sorted", function () {
    for (const name of ["TABLES", "ANON_READABLE", "SIGNED_IN_READABLE", "NO_CLIENT_ACCESS", "APPEND_ONLY_TABLES", "ADMIN_FUNCTIONS", "PLAYER_FUNCTIONS", "INTERNAL_FUNCTIONS"]) {
      const list = model[name];
      expect(list.length, name).toBeGreaterThan(0);
      expect(unique(list), name + " has duplicates").toBe(true);
      expect(list, name + " must stay sorted").toEqual(list.slice().sort());
    }
  });

  test("anonymous access is a subset of signed-in access, and append-only tables are real tables", function () {
    for (const name of model.ANON_READABLE) { expect(model.SIGNED_IN_READABLE, name).toContain(name); }
    for (const name of model.APPEND_ONLY_TABLES) { expect(model.TABLES, name).toContain(name); }
    for (const name of model.NO_CLIENT_ACCESS) { expect(model.TABLES, name).toContain(name); expect(model.SIGNED_IN_READABLE, name).not.toContain(name); }
  });

  test("every function has dummy arguments and every table has a plain column to probe", function () {
    for (const fn of model.ADMIN_FUNCTIONS.concat(model.PLAYER_FUNCTIONS, model.INTERNAL_FUNCTIONS)) {
      expect(model.DUMMY_ARGS[fn], fn).toBeDefined();
    }
    for (const table of model.TABLES) { expect(model.PLAIN_COLUMN[table], table).toBeTruthy(); }
  });

  test("special refusal wordings belong to real admin functions", function () {
    for (const fn of Object.keys(model.ADMIN_REFUSAL)) { expect(model.ADMIN_FUNCTIONS, fn).toContain(fn); }
  });

  test("every admin function is named admin_*, and no other function is", function () {
    for (const fn of model.ADMIN_FUNCTIONS) { expect(fn).toMatch(/^admin_/); }
    for (const fn of model.PLAYER_FUNCTIONS.concat(model.INTERNAL_FUNCTIONS)) { expect(fn).not.toMatch(/^admin_/); }
  });
});
