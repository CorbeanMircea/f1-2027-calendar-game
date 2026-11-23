<#
.SYNOPSIS
  Rebuilds the LOCAL Supabase test database from scratch, then replays the migrations.

.DESCRIPTION
  Runs "supabase db reset" against the local Docker stack defined in tests\db\supabase\config.toml (the CLI's default
  target is local; this repository is never linked to a remote project), then runs apply-migrations.ps1.
  Production is never contacted. Run it from anywhere; it works from the repository root.

.PARAMETER SkipReplay
  Only reset; do not replay the migrations afterwards.
#>
[CmdletBinding()]
param(
    [string]$ProjectId = "lights-out-test",
    [switch]$SkipReplay
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

Push-Location $RepoRoot
try {
    Write-Host "Resetting the LOCAL test database (Docker project '$ProjectId'). Production is not touched."
    & npx supabase db reset --workdir tests/db --no-seed
    if ($LASTEXITCODE -ne 0) {
        throw "supabase db reset failed. Is the local stack running? Start it with: npm run db:start"
    }

    if ($SkipReplay) {
        Write-Host "Reset done. Replay skipped (-SkipReplay)."
    }
    else {
        & (Join-Path $PSScriptRoot "apply-migrations.ps1") -ProjectId $ProjectId
    }
}
finally {
    Pop-Location
}
