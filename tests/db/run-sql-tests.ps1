<#
.SYNOPSIS
  Runs the existing SQL regression tests (supabase\tests\*.sql) against the LOCAL seeded test database.

.DESCRIPTION
  * Each test file is copied into the local Docker container and run with psql. The test files themselves are not changed.
  * Every test rolls its own work back (it ends with a deliberate error that carries the PASS/FAIL list). After each file this
    script also compares a fingerprint of the row counts of every table, and reports LEAK if a test left data behind.
  * Prints one line per file and a summary; exits with code 1 if anything failed, errored or leaked.
  * Never contacts production. Production SQL Editor runs remain an optional manual check.

.PARAMETER Filter
  Only run files whose name contains this text, for example -Filter 039
.PARAMETER Details
  Print the PASS/FAIL lines of every file, not only the failing ones.
.PARAMETER IncludeRetired
  Also run the retired legacy tests listed below (they are expected to fail against the current schema).
#>
[CmdletBinding()]
param(
    [string]$ProjectId = "lights-out-test",
    [string]$Filter = "",
    [switch]$Details,
    [switch]$IncludeRetired
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lo-db-common.ps1")

$RepoRoot  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$TestsDir  = Join-Path (Join-Path $RepoRoot "supabase") "tests"
$Container = "supabase_db_" + $ProjectId
$RemoteDir = "/tmp/lo_sqltests"

# ---------------------------------------------------------------------------------------------------------
# RETIRED LEGACY TESTS. Listed openly and never deleted or edited. Each was written for a schema that later migrations
# replaced, so it cannot pass against the final schema (verified by running it). They are skipped by default; run them
# with -IncludeRetired. Replacement tests for the same behaviour are planned. Add to this list only with the owner's approval.
# ---------------------------------------------------------------------------------------------------------
$Retired = [ordered]@{
    "005" = "Written for the old predictions table (columns p1..p8) and the old submit_prediction signature; both were replaced by migration 009."
    "007" = "Inserts into predictions columns (p1..) that migration 009 removed."
    "009" = "Its setup enters a result the DNF rule added by migration 010 now refuses (results_dnf_not_in_top8)."
}

$files = @(Get-ChildItem -LiteralPath $TestsDir -File -Filter "*.sql" | Where-Object { $_.Name -like "*$Filter*" } | Sort-Object Name)
if ($files.Count -eq 0) { throw "No SQL test files found in $TestsDir matching '$Filter'" }
$skipped = @()
if (-not $IncludeRetired) {
    $skipped = @($files | Where-Object { $Retired.Contains($_.Name.Substring(0, 3)) })
    $files   = @($files | Where-Object { -not $Retired.Contains($_.Name.Substring(0, 3)) })
}
if ($files.Count -eq 0) { throw "Nothing to run: every file matching '$Filter' is retired (use -IncludeRetired)." }

Write-Host ""
Write-Host "Lights Out: SQL regression tests against the LOCAL database (container '$Container')"
Assert-LoContainerRunning $Container

$members = Invoke-LoPsql $Container "select count(*) from public.group_members"
if ($members.Code -ne 0 -or [int]$members.Output -lt 4) {
    throw "The local database is not seeded (needs the 4 seed members). Run: npm run db:seed   (or npm run db:fresh)."
}

$fingerprintSql = "select md5(string_agg(t || '=' || c, ',' order by t)) from (" +
    "select table_name::text as t, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text as c " +
    "from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE') x"

$before = Invoke-LoPsql $Container $fingerprintSql
if ($before.Code -ne 0) { throw "Cannot read the table fingerprint: $($before.Output)" }
$baseline = $before.Output

$results = @()
foreach ($f in $files) {
    $remote = Copy-LoFileIntoContainer $Container $f.FullName $RemoteDir
    $run = Invoke-LoDocker @("exec", $Container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=0", "-f", $remote)
    $text = $run.Output

    # Older tests print "T1 description: PASS" or ": FAIL (...)"; newer tests print lines that start with "ok" or "FAIL".
    $pass = ([regex]::Matches($text, ':\s*PASS\b')).Count + ([regex]::Matches($text, '(?m)^ok\s')).Count
    $fail = ([regex]::Matches($text, ':\s*FAIL\b')).Count + ([regex]::Matches($text, '(?m)^FAIL\s')).Count
    $failLines = @([regex]::Matches($text, '(?m)^(.*:\s*FAIL\b.*|FAIL\s.*)$') | ForEach-Object { $_.Value.Trim() })
    # Tests 023 and 024 print a table of checks instead: a final column of t (ok) or f (not ok).
    foreach ($m in [regex]::Matches($text, '(?m)^(.*)\|\s*(t|f)\s*$')) {
        if ($m.Groups[2].Value -eq "t") { $pass++ } else { $fail++; $failLines += $m.Groups[1].Value.Trim() }
    }

    $after = Invoke-LoPsql $Container $fingerprintSql
    $leak = ($after.Output -ne $baseline)
    if ($leak) { $baseline = $after.Output }

    $firstError = ""
    $em = [regex]::Match($text, '(?m)^(?:psql:[^:]+:\d+:\s*)?ERROR:\s+(.*)$')
    if ($em.Success) { $firstError = $em.Groups[1].Value.Trim() }

    if ($pass + $fail -eq 0) { $status = "NO RESULTS" }
    elseif ($fail -gt 0)     { $status = "FAIL" }
    elseif ($leak)           { $status = "LEAK" }
    else                     { $status = "PASS" }

    Write-Host ("{0,-10} {1,-44} {2} passed, {3} failed" -f $status, $f.Name, $pass, $fail)
    if ($status -eq "NO RESULTS") { Write-Host ("           " + $firstError) }
    if ($status -eq "LEAK") { Write-Host "           the test left data behind (row counts changed)" }
    if ($fail -gt 0) { foreach ($l in $failLines) { Write-Host ("           " + $l) } }
    if ($Details -and $status -ne "NO RESULTS") {
        foreach ($m in [regex]::Matches($text, '(?m)^(.*:\s*PASS\b.*|ok\s.*)$')) { Write-Host ("           " + $m.Value.Trim()) }
    }

    $results += [pscustomobject]@{ Name = $f.Name; Status = $status; Pass = $pass; Fail = $fail }
}
[void](Invoke-LoDocker @("exec", $Container, "rm", "-rf", $RemoteDir))

$totalPass = ($results | Measure-Object -Property Pass -Sum).Sum
$totalFail = ($results | Measure-Object -Property Fail -Sum).Sum
$notPassed = @($results | Where-Object { $_.Status -ne "PASS" })

Write-Host ""
foreach ($f in $skipped) {
    Write-Host ("RETIRED    {0}: {1}" -f $f.Name, $Retired[$f.Name.Substring(0, 3)])
}
Write-Host ("Files: {0}   checks passed: {1}   failed: {2}   files not passing: {3}   retired (not run): {4}" -f $results.Count, $totalPass, $totalFail, $notPassed.Count, $skipped.Count)
if ($notPassed.Count -gt 0) {
    Write-Host "NOT ALL TESTS PASSED."
    exit 1
}
Write-Host "All SQL tests passed. Nothing was kept in the database and nothing touched production."
