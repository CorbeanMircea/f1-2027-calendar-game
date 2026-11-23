# Lights Out: helpers shared by the local-database scripts (dot-sourced; not run on its own).
# Everything here talks only to a LOCAL Docker container. No network address, key or password is used.

function Invoke-LoDocker {
    param([string[]]$DockerArgs)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $raw  = & docker @DockerArgs 2>&1
        $code = $LASTEXITCODE
        $text = ($raw | ForEach-Object { $_.ToString() }) -join "`n"
        return [pscustomobject]@{ Code = $code; Output = $text.Replace("`r", "").Trim() }
    }
    catch {
        return [pscustomobject]@{ Code = 127; Output = $_.Exception.Message }
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

function Invoke-LoPsql {
    param([string]$Container, [string]$Sql)
    return Invoke-LoDocker @("exec", $Container, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c", $Sql)
}

function Assert-LoContainerRunning {
    param([string]$Container)
    $running = Invoke-LoDocker @("inspect", "-f", "{{.State.Running}}", $Container)
    if ($running.Code -ne 0 -or $running.Output -ne "true") {
        throw "The local database container '$Container' is not running. Start it first with: npm run db:start   (Docker Desktop must be running)."
    }
}

function Copy-LoFileIntoContainer {
    param([string]$Container, [string]$LocalPath, [string]$RemoteDir)
    $name = Split-Path -Leaf $LocalPath
    $prepare = Invoke-LoDocker @("exec", $Container, "mkdir", "-p", $RemoteDir)
    if ($prepare.Code -ne 0) { throw "Cannot prepare $RemoteDir inside the container: $($prepare.Output)" }
    $copy = Invoke-LoDocker @("cp", $LocalPath, ($Container + ":" + $RemoteDir + "/" + $name))
    if ($copy.Code -ne 0) { throw "Could not copy $name into the container: $($copy.Output)" }
    return ($RemoteDir + "/" + $name)
}
