# ZEROSYS Sales Copilot - start the local server hidden (called from the Startup shortcut).
# ASCII only. Paths are passed as arguments so they may contain any characters.
param(
  [Parameter(Mandatory = $true)][string]$Node,
  [Parameter(Mandatory = $true)][string]$Runner,
  [Parameter(Mandatory = $true)][string]$WorkDir
)
$ErrorActionPreference = 'Stop'
Start-Process -FilePath $Node -ArgumentList @('"' + $Runner + '"') -WorkingDirectory $WorkDir -WindowStyle Hidden
