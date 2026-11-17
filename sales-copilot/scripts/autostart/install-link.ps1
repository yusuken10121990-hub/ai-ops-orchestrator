# ZEROSYS Sales Copilot - create the per-user Startup shortcut. ASCII only.
# Touches only the one shortcut file given in -LinkPath (no Task Scheduler, no admin rights).
param(
  [Parameter(Mandatory = $true)][string]$LinkPath,
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$Arguments,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$Description,
  [int]$WindowStyle = 7
)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $LinkPath
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($LinkPath)
$lnk.TargetPath = $Target
$lnk.Arguments = $Arguments
$lnk.WorkingDirectory = $WorkDir
$lnk.Description = $Description
$lnk.WindowStyle = $WindowStyle
$lnk.Save()
if (-not (Test-Path -LiteralPath $LinkPath)) { throw 'shortcut was not created' }
Write-Output 'OK'
