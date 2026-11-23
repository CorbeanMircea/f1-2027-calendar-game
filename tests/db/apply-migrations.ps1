<#
.SYNOPSIS
  Applies the Lights Out database migrations (supabase\001 ... 039) to the LOCAL Supabase test database.

.DESCRIPTION
  * Talks ONLY to the local Docker container "supabase_db_<ProjectId>". It never uses a network address,
    a production URL, a key or a password.
  * Applies supabase\NNN_*.sql in numeric order, unchanged. The original files are never modified.
  * Skips the migrations listed in $Excluded below, and says so out loud.
  * Refuses to run if any file it WOULD apply contains something that could schedule jobs or call a
    production service (cron.schedule, net.http_..., a *.supabase.co address).
  * Stops at the first error. A half-applied file cannot be repaired: run reset-local-db.ps1 and try again.

.PARAMETER DryRun
  Print the plan (what would be applied, what is excluded) and run the safety scan. Needs no Docker.

.PARAMETER AllowNonEmpty
  Apply even if the local database already has the Lights Out tables (normally it refuses).
#>
[CmdletBinding()]
param(
    [string]$ProjectId = "lights-out-test",
    [switch]$DryRun,
    [switch]$AllowNonEmpty
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------------------------------------
# EXPLICIT EXCLUSIONS (approved Q7). Add a migration here only with the owner's approval.
# ---------------------------------------------------------------------------------------------------------
$Excluded = [ordered]@{
    "015" = "Schedules pg_cron jobs that call the PRODUCTION importer (needs pg_cron, pg_net and Vault). Never replayed locally."
    "022" = "Schedules a pg_cron job that calls the PRODUCTION reminder function. Never replayed locally."
}

# Anything that could schedule work or reach a production service. A file matching this is never applied.
$ForbiddenPattern = 'cron\.schedule|net\.http_|\.supabase\.co(?![A-Za-z0-9])'

$RepoRoot      = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$MigrationsDir = Join-Path $RepoRoot "supabase"
$Container     = "supabase_db_" + $ProjectId
$RemoteDir     = "/tmp/lo_migrations"

function Invoke-LoDocker {
    param([string[]]$DockerArgs)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $raw  = & docker @DockerArgs 2>&1
        $code = $LASTEXITCODE
        $text = ($raw | ForEach-Object { $_.ToString() }) -join "`n"
        return [pscustomobject]@{ Code = $code; Output = $text.Trim() }
    }
    catch {
        return [pscustomobject]@{ Code = 127; Output = $_.Exception.Message }
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

function Invoke-LoPsql {
    param([string]$Sql)
    return Invoke-LoDocker @("exec", $Container, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c", $Sql)
}

# ---- 1. Work out the plan -----------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $MigrationsDir)) { throw "Cannot find the migrations folder: $MigrationsDir" }

$files = @(Get-ChildItem -LiteralPath $MigrationsDir -File -Filter "*.sql" |
    Where-Object { $_.Name -match '^\d{3}_' } |
    Sort-Object Name)
if ($files.Count -eq 0) { throw "No migration files (NNN_*.sql) found in $MigrationsDir" }

$toApply  = @()
$skipped  = @()
foreach ($f in $files) {
    $number = $f.Name.Substring(0, 3)
    if ($Excluded.Contains($number)) { $skipped += $f } else { $toApply += $f }
}
foreach ($number in $Excluded.Keys) {
    if (-not ($files | Where-Object { $_.Name.StartsWith($number + "_") })) {
        Write-Warning "Excluded migration $number was not found in $MigrationsDir (exclusion list may be out of date)."
    }
}

Write-Host ""
Write-Host "Lights Out: local migration replay plan"
Write-Host "  Migration files found : $($files.Count)"
Write-Host "  To apply, unchanged   : $($toApply.Count)"
Write-Host "  EXCLUDED on purpose   : $($skipped.Count)"
foreach ($f in $skipped) {
    Write-Host ("    - {0}: {1}" -f $f.Name, $Excluded[$f.Name.Substring(0, 3)])
}

# ---- 2. Safety scan of every file that would be applied -------------------------------------------------
$unsafe = @()
foreach ($f in $toApply) {
    if (Select-String -LiteralPath $f.FullName -Pattern $ForbiddenPattern -Quiet) { $unsafe += $f.Name }
}
if ($unsafe.Count -gt 0) {
    throw ("SAFETY STOP: these files schedule jobs or reference a production URL and are NOT on the exclusion list: " +
           ($unsafe -join ", ") + ". Nothing was applied. Tell the project owner; do not add them to the list yourself.")
}
Write-Host "  Safety scan           : OK (no cron.schedule, net.http_ or supabase.co in the $($toApply.Count) files to apply)"

if ($DryRun) {
    Write-Host ""
    Write-Host "Dry run only: Docker was not contacted and nothing was applied."
    return
}

# ---- 3. Check the target is the local test database --------------------------------------------------------
Write-Host ""
Write-Host "Target: local Docker container '$Container'"
$running = Invoke-LoDocker @("inspect", "-f", "{{.State.Running}}", $Container)
if ($running.Code -ne 0 -or $running.Output -ne "true") {
    throw "The local database container '$Container' is not running. Start it first with: npm run db:start   (Docker Desktop must be running)."
}

$version = Invoke-LoPsql "show server_version"
if ($version.Code -ne 0) { throw "Cannot query the local database: $($version.Output)" }
Write-Host "  PostgreSQL version    : $($version.Output) (production runs 17.11)"
if (-not $version.Output.StartsWith("17.")) { Write-Warning "Local PostgreSQL is not major version 17; production is 17.11." }

$existing = Invoke-LoPsql "select to_regclass('public.events') is not null"
if ($existing.Code -ne 0) { throw "Cannot query the local database: $($existing.Output)" }
if ($existing.Output -eq "t" -and -not $AllowNonEmpty) {
    throw "The local database already contains Lights Out tables. Run: npm run db:reset   (it rebuilds the LOCAL database from scratch and replays everything)."
}

# ---- 4. Apply, in order, stopping at the first error ----------------------------------------------------------
$prepare = Invoke-LoDocker @("exec", $Container, "mkdir", "-p", $RemoteDir)
if ($prepare.Code -ne 0) { throw "Cannot prepare $RemoteDir inside the container: $($prepare.Output)" }

$applied = 0
foreach ($f in $toApply) {
    Write-Host ("  applying {0}" -f $f.Name)
    $copy = Invoke-LoDocker @("cp", $f.FullName, ($Container + ":" + $RemoteDir + "/" + $f.Name))
    if ($copy.Code -ne 0) { throw "Could not copy $($f.Name) into the container: $($copy.Output)" }

    $run = Invoke-LoDocker @("exec", $Container, "psql", "-U", "postgres", "-d", "postgres",
        "-v", "ON_ERROR_STOP=1", "-q", "-f", ($RemoteDir + "/" + $f.Name))
    if ($run.Code -ne 0) {
        Write-Host $run.Output
        throw ("FAILED while applying $($f.Name) (after $applied successful files). The local database may be half-updated: " +
               "run npm run db:reset to rebuild it, and send me the error text above.")
    }
    $applied++
}
[void](Invoke-LoDocker @("exec", $Container, "rm", "-rf", $RemoteDir))

# ---- 5. Verify nothing can run on a schedule locally ------------------------------------------------------------
$cronTable = Invoke-LoPsql "select to_regclass('cron.job') is not null"
if ($cronTable.Output -eq "t") {
    $jobs = Invoke-LoPsql "select count(*) from cron.job"
    if ($jobs.Output -ne "0") { throw "SAFETY STOP: the local database has $($jobs.Output) scheduled cron job(s). Local tests must have none." }
}

$summary = Invoke-LoPsql ("select (select count(*) from information_schema.tables where table_schema = 'public') || ' tables, ' || " +
    "(select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') || ' functions in schema public'")

Write-Host ""
Write-Host "Done: applied $applied migration files ($($skipped.Count) excluded on purpose)."
Write-Host "Local database now has: $($summary.Output)"
Write-Host "Scheduled cron jobs: none. Nothing was sent to any production service."
