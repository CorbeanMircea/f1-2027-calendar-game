// Lights Out: the permission model must not change by accident (T5).
// These tests read the LIVE catalog of the local database (all migrations applied) and compare it with
// tests/fixtures/permission-model.js. A new table without row level security, a new grant to the public API roles or a new
// callable function makes a test here fail, so a person has to look at it before it can ship.
const { test, expect } = require("@playwright/test");
const db = require("../fixtures/local-db");
const model = require("../fixtures/permission-model");

function sorted(list) { return list.slice().sort(); }

const FUNCTION_FILTER = "p.prokind = 'f' and p.prorettype <> 'trigger'::regtype and n.nspname = 'public'";

test.describe("database permission snapshot", function () {
  test("the tables are exactly the known ones, and every one has row level security", function () {
    const tables = db.psqlJson("select coalesce(json_agg(c.relname order by c.relname), '[]') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'");
    expect(tables).toEqual(sorted(model.TABLES));
    const withoutRls = db.psqlJson("select coalesce(json_agg(c.relname order by c.relname), '[]') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity");
    expect(withoutRls, "tables without row level security").toEqual([]);
  });

  test("anonymous visitors can read exactly the public schedule objects", function () {
    const readable = db.psqlJson("select coalesce(json_agg(distinct table_name order by table_name), '[]') from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon' and privilege_type = 'SELECT'");
    expect(readable).toEqual(sorted(model.ANON_READABLE));
  });

  test("signed-in users can read exactly the known objects", function () {
    const readable = db.psqlJson("select coalesce(json_agg(distinct table_name order by table_name), '[]') from information_schema.role_table_grants where table_schema = 'public' and grantee = 'authenticated' and privilege_type = 'SELECT'");
    expect(readable).toEqual(sorted(model.SIGNED_IN_READABLE));
  });

  test("the public API roles have no write, truncate, reference or trigger privilege on anything", function () {
    const extra = db.psqlJson("select coalesce(json_agg(grantee || ':' || table_name || ':' || privilege_type order by 1), '[]') from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC') and privilege_type <> 'SELECT'");
    expect(extra, "write-type privileges granted to anon, authenticated or PUBLIC").toEqual([]);
  });

  test("every view runs with the caller's rights (security_invoker), so row level security applies through views", function () {
    const bad = db.psqlJson("select coalesce(json_agg(c.relname order by c.relname), '[]') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v' and not coalesce(c.reloptions @> array['security_invoker=true'], false)");
    expect(bad, "views that would bypass row level security").toEqual([]);
  });

  test("signed-in users can call exactly the known functions, anonymous visitors none", function () {
    const callable = db.psqlJson("select coalesce(json_agg(p.proname order by p.proname), '[]') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where " + FUNCTION_FILTER + " and has_function_privilege('authenticated', p.oid, 'execute')");
    expect(callable).toEqual(sorted(model.ADMIN_FUNCTIONS.concat(model.PLAYER_FUNCTIONS)));
    const anon = db.psqlJson("select coalesce(json_agg(p.proname order by p.proname), '[]') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where " + FUNCTION_FILTER + " and has_function_privilege('anon', p.oid, 'execute')");
    expect(anon, "functions an anonymous visitor could call").toEqual([]);
  });

  test("the internal functions stay internal", function () {
    const internal = db.psqlJson("select coalesce(json_agg(p.proname order by p.proname), '[]') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where " + FUNCTION_FILTER + " and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')");
    expect(internal).toEqual(sorted(model.INTERNAL_FUNCTIONS));
  });

  test("every function a client can call is SECURITY DEFINER with a fixed, empty search_path", function () {
    const bad = db.psqlJson("select coalesce(json_agg(p.proname order by p.proname), '[]') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where " + FUNCTION_FILTER + " and has_function_privilege('authenticated', p.oid, 'execute') and (not p.prosecdef or not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c = 'search_path=\"\"'))");
    expect(bad, "callable functions without SECURITY DEFINER and an empty search_path").toEqual([]);
  });

  test("the append-only tables each keep their blocking trigger", function () {
    const triggers = db.psqlJson("select coalesce(json_agg(c.relname order by c.relname), '[]') from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal and t.tgname = c.relname || '_append_only'");
    expect(triggers).toEqual(sorted(model.APPEND_ONLY_TABLES));
  });
});
