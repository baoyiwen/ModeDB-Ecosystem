#Requires -Version 5.1
<#
.SYNOPSIS
Repeatable synthetic two-device Windows recovery drill. Never loads instance configuration.
.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\security-recovery-drill.ps1 -Action Prepare
.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\security-recovery-drill.ps1 -Action Receive
.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\security-recovery-drill.ps1 -Action Verify -DrillRoot C:\path\to\receiver-run
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Prepare', 'Receive', 'Verify')]
    [string]$Action,
    [string]$DrillRoot,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$drillExitCode = 1
Push-Location -LiteralPath $repositoryRoot
try {
    if ($Action -eq 'Verify' -and [string]::IsNullOrWhiteSpace($DrillRoot)) {
        throw 'RECOVERY_DRILL_ROOT_REQUIRED'
    }
    # Elevated Windows tokens can assign Administrators ownership to new files.
    # The drill requires current-user ownership and must not rewrite existing ACLs.
    $drillIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $drillPrincipal = New-Object Security.Principal.WindowsPrincipal($drillIdentity)
        if ($drillPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'RECOVERY_DRILL_NON_ELEVATED_REQUIRED'
        }
    } finally {
        $drillIdentity.Dispose()
    }
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) { throw 'RECOVERY_DRILL_NODE_20_REQUIRED' }
    $nodeVersion = & $nodeCommand.Source -p 'parseInt(process.versions.node)'
    if ($LASTEXITCODE -ne 0 -or [int]$nodeVersion -lt 20) {
        throw 'RECOVERY_DRILL_NODE_20_REQUIRED'
    }
    foreach ($requiredPath in @('node_modules/tsx/dist/cli.mjs', 'node_modules/typescript/bin/tsc')) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw 'RECOVERY_DRILL_DEPENDENCIES_MISSING'
        }
    }
    if (-not $SkipBuild) {
        foreach ($buildConfig in @(
            'packages/shared/tsconfig.build.json',
            'packages/common/tsconfig.json',
            'packages/core/tsconfig.build.json',
            'packages/server/tsconfig.json'
        )) {
            Write-Host "Building $buildConfig"
            & $nodeCommand.Source node_modules/typescript/bin/tsc -p $buildConfig
            if ($LASTEXITCODE -ne 0) { throw 'RECOVERY_DRILL_BUILD_FAILED' }
        }
    }
    $runnerArguments = @(
        'node_modules/tsx/dist/cli.mjs',
        'scripts/security-recovery-drill-runner.ts',
        $Action.ToLowerInvariant()
    )
    if (-not [string]::IsNullOrWhiteSpace($DrillRoot)) {
        $runnerArguments += @('--root', $DrillRoot)
    }
    $runnerOutput = & $nodeCommand.Source @runnerArguments
    $drillExitCode = $LASTEXITCODE
    try { $result = ($runnerOutput -join "`n") | ConvertFrom-Json }
    catch { throw 'RECOVERY_DRILL_RUNNER_UNAVAILABLE' }
    if ($null -eq $result) { throw 'RECOVERY_DRILL_RUNNER_UNAVAILABLE' }
    if ($result.drillRoot) { Write-Host "DrillRoot: $($result.drillRoot)" }
    if ($result.report) { Write-Host "Report: $($result.report)" }
    if ($drillExitCode -ne 0 -or $result.ok -ne $true) {
        Write-Host "FAILED: $($result.errorCode)" -ForegroundColor Red
        Write-Host "Step: $($result.step)"
        Write-Host 'Preserve this run. Do not transfer an incomplete fixture.'
        $drillExitCode = 1
    } else {
        Write-Host "SUCCESS: $Action" -ForegroundColor Green
        Write-Output ($result.result | ConvertTo-Json -Depth 8)
        if ($Action -eq 'Prepare' -or $Action -eq 'Receive') {
            Write-Host "Fixture: $(Join-Path $result.drillRoot 'fixture')"
            Write-Host "Separate passphrase file: $(Join-Path $result.drillRoot 'secret\phrase.txt')"
            Write-Host 'Transfer fixture files and passphrase separately. Do not preserve source ACLs.'
        }
    }
} catch {
    $safeMessage = [string]$_.Exception.Message
    if ($safeMessage -notmatch '^RECOVERY_DRILL_[A-Z_]+$') {
        $safeMessage = 'RECOVERY_DRILL_POWERSHELL_FAILED'
    }
    Write-Host "FAILED: $safeMessage" -ForegroundColor Red
    if ($safeMessage -eq 'RECOVERY_DRILL_NON_ELEVATED_REQUIRED') {
        Write-Host 'Open a normal PowerShell window without Run as administrator, then run this command again.'
        Write-Host 'Use a normal window for Prepare, Receive and Verify on both devices.'
    }
    $drillExitCode = 1
} finally {
    Pop-Location
}
exit $drillExitCode
