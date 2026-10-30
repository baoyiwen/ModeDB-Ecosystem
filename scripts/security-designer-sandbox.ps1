#Requires -Version 5.1
<#
.SYNOPSIS
Starts a fresh synthetic Windows Server and Model Designer with one-time pairing.
#>
[CmdletBinding()]
param(
    [string]$Candidate,
    [switch]$NoOpen,
    [switch]$Smoke
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$sandboxIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    $sandboxPrincipal = New-Object Security.Principal.WindowsPrincipal($sandboxIdentity)
    if ($sandboxPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host 'SANDBOX_NON_ELEVATED_REQUIRED: use an ordinary PowerShell window.'
        exit 1
    }
} finally {
    $sandboxIdentity.Dispose()
}
$sandboxNode = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$sandboxArguments = @((Join-Path $PSScriptRoot 'security-designer-sandbox.mjs'))
if (-not [string]::IsNullOrWhiteSpace($Candidate)) { $sandboxArguments += @('--candidate', $Candidate) }
if ($NoOpen) { $sandboxArguments += '--no-open' }
if ($Smoke) { $sandboxArguments += '--smoke' }
& $sandboxNode.Source @sandboxArguments
exit $LASTEXITCODE
