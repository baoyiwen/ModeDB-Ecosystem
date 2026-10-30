#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Prepare','Serve','Client','Smoke')][string]$Action,
    [string]$DrillRoot,
    [string]$Ticket,
    [string]$Pin,
    [string]$ServerAddress,
    [string]$ClientAddress,
    [ValidateSet('chrome','edge')][string]$Browser = 'edge'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$deviceNode = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$deviceArguments = @((Join-Path $PSScriptRoot 'security-device-drill.mjs'), $Action.ToLowerInvariant())
foreach ($devicePair in @(@('--root',$DrillRoot),@('--ticket',$Ticket),@('--pin',$Pin),@('--server',$ServerAddress),@('--client',$ClientAddress))) {
    if (-not [string]::IsNullOrWhiteSpace($devicePair[1])) { $deviceArguments += $devicePair }
}
if ($Action -eq 'Client') { $deviceArguments += @('--browser',$Browser) }
& $deviceNode.Source @deviceArguments
exit $LASTEXITCODE
