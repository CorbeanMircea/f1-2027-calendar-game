<#
.SYNOPSIS
  Loads the test seed (tests\db\seed.sql) into the LOCAL Supabase test database.

.DESCRIPTION
  Creates one group, one admin, three players and four scored 2026 test sessions, using the application's own functions.
  Local Docker container only. Refuses to run twice (use npm run db:fresh to rebuild everything from scratch).
#>
[CmdletBinding()]
param(
    [string]$ProjectId = "lights-out-test"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lo-db-common.ps1")

$Container = "supabase_db_" + $ProjectId
$SeedFile  = Join-Path $PSScriptRoot "seed.sql"
if (-not (Test-Path -LiteralPath $SeedFile)) { throw "Cannot find $SeedFile" }

if (Select-String -LiteralPath $SeedFile -Pattern 'cron\.schedule|net\.http_|\.supabase\.co(?![A-Za-z0-9])' -Quiet) {
    throw "SAFETY STOP: seed.sql mentions cron scheduling or a production address. Nothing was applied."
}

Write-Host ""
Write-Host "Lights Out: seeding the LOCAL test database (container '$Container')"
Assert-LoContainerRunning $Container

$schema = Invoke-LoPsql $Container "select to_regclass('public.group_members') is not null"
if ($schema.Code -ne 0 -or $schema.Output -ne "t") {
    throw "The local database has no Lights Out tables yet. Run: npm run db:replay   (or npm run db:fresh)."
}
$members = Invoke-LoPsql $Container "select count(*) from public.group_members"
if ($members.Output -ne "0") {
    throw "The local database already has $($members.Output) group member(s), so it looks seeded. Run: npm run db:fresh   to rebuild it from scratch."
}

$remote = Copy-LoFileIntoContainer $Container $SeedFile "/tmp/lo_seed"
$run = Invoke-LoDocker @("exec", $Container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-f", $remote)
[void](Invoke-LoDocker @("exec", $Container, "rm", "-rf", "/tmp/lo_seed"))
if ($run.Code -ne 0) {
    Write-Host $run.Output
    throw "The seed FAILED (it runs in one transaction, so nothing was kept). Send me the error text above."
}

$summary = Invoke-LoPsql $Container ("select (select count(*) from public.group_members) || ' members (' || " +
    "(select count(*) from public.group_members where role = 'admin') || ' admin), ' || " +
    "(select count(*) from public.scores) || ' scored rows for ' || (select count(distinct user_id) from public.scores) || ' players'")
Write-Host "Seeded: $($summary.Output)"
Write-Host "Group invite code (local only): LO-SEED-CODE-1"
