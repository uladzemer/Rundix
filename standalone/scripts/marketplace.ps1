# Marketplace console for the owner: status, Azure sign-in and publishing.
#   powershell -NoProfile -ExecutionPolicy Bypass -File standalone/scripts/marketplace.ps1 status
#   ... marketplace.ps1 login     # az login into the tenant recorded in marketplace.local.json (MFA in the browser)
#   ... marketplace.ps1 publish   # publishes standalone/rundix-<package.json version>.vsix via Microsoft Entra ID
# The tenant ID lives in the untracked marketplace.local.json next to this script: {"tenant": "<id>"}.
# The signed-in identity must be a member of the publisher (Marketplace -> Members, by profile ID; see "id").
param([ValidateSet('status', 'login', 'publish', 'id')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$azBin = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin'
if ((Test-Path $azBin) -and -not ($env:PATH -split ';' -contains $azBin)) { $env:PATH = "$azBin;$env:PATH" }
$package = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$extension = "$($package.publisher).$($package.name)"
$localConfig = Join-Path $PSScriptRoot 'marketplace.local.json'

function Get-Tenant {
  if (-not (Test-Path $localConfig)) { throw "Missing $localConfig with {""tenant"": ""<id>""}." }
  (Get-Content $localConfig -Raw | ConvertFrom-Json).tenant
}
function Get-PublishedVersion {
  $body = @{filters = @(@{criteria = @(@{filterType = 7; value = $extension})}); flags = 1} | ConvertTo-Json -Depth 5
  $result = Invoke-RestMethod -Method Post -Uri 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery' `
    -ContentType 'application/json' -Headers @{Accept = 'application/json;api-version=3.0-preview.1'} -Body $body -TimeoutSec 30
  $result.results[0].extensions[0].versions[0].version
}
function Test-AzLogin {
  if (-not (Get-Command az -ErrorAction SilentlyContinue)) { return $false }
  az account show --only-show-errors 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

switch ($Action) {
  'status' {
    Write-Host "Local package.json: $($package.version)"
    Write-Host "Marketplace:        $(Get-PublishedVersion)"
    Write-Host "Azure CLI signed in: $(Test-AzLogin)"
  }
  'login' {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI is not installed: winget install -e --id Microsoft.AzureCLI' }
    az login --tenant (Get-Tenant) --allow-no-subscriptions
  }
  'id' {
    az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798 --query id -o tsv
  }
  'publish' {
    if (-not (Test-AzLogin)) { throw 'Not signed in. Run: marketplace.ps1 login' }
    $vsix = Join-Path $root "rundix-$($package.version).vsix"
    if (-not (Test-Path $vsix)) { throw "Missing $vsix. Run npm.cmd run package first." }
    # vsce resolves files relative to the current directory; publish a copy from TEMP.
    $copy = Join-Path $env:TEMP (Split-Path -Leaf $vsix)
    Copy-Item $vsix $copy -Force
    Push-Location $env:TEMP
    try { npx.cmd --yes @vscode/vsce@4.0.0 publish --azure-credential --packagePath (Split-Path -Leaf $copy) }
    finally { Pop-Location; Remove-Item $copy -ErrorAction SilentlyContinue }
    if ($LASTEXITCODE -ne 0) { throw 'Publishing failed.' }
    Write-Host 'Published. The Marketplace listing can take a few minutes to show the new version.'
  }
}
