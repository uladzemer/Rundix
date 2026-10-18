param([int]$CapturePort=9339,[Parameter(Mandatory=$true)][string]$ControlPath)
$ErrorActionPreference='Stop'
$extensionRoot=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$demoProfile=Join-Path $extensionRoot ('.verification/workbench-demo-'+[guid]::NewGuid().ToString('N'))
$demoProject=Join-Path $demoProfile 'rundix-demo'
$demoExtensions=Join-Path $demoProfile 'extensions'
$demoUser=Join-Path $demoProfile 'User'
$demoControl=[IO.Path]::GetFullPath($ControlPath)
New-Item -ItemType Directory -Path $demoProject,$demoExtensions,$demoUser,(Join-Path $demoProject 'src') -Force | Out-Null
@{
  'workbench.startupEditor'='none';'window.title'='Rundix Demo';'window.menuBarVisibility'='compact'
  'workbench.colorTheme'='Default Dark Modern';'workbench.editor.enablePreview'=$false
  'workbench.tips.enabled'=$false;'editor.fontSize'=14;'editor.wordWrap'='on';'breadcrumbs.enabled'=$false
  'extensions.autoCheckUpdates'=$false;'extensions.autoUpdate'=$false;'update.mode'='none'
  'telemetry.telemetryLevel'='off';'rundix.cliAutoUpdate'=$false;'rundix.language'='en'
  'git.enabled'=$false;'chat.disableAIFeatures'=$true
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $demoUser 'settings.json') -Encoding UTF8
@'
export function normalizeTags(tags: string[]) {
  const clean = tags.map(tag => tag.trim());
  return [...new Set(clean.filter(Boolean))];
}

const tags = [" docs ", "", "docs", "api"];
const normalized = normalizeTags(tags);
// Result: ["docs", "api"]

// Synthetic demo project. No real files or account data.
'@ | Set-Content -LiteralPath (Join-Path $demoProject 'src/tags.ts') -Encoding UTF8
'{"scene":"overview","revision":1}' | Set-Content -LiteralPath $demoControl -Encoding UTF8
'{"ready":false}' | Set-Content -LiteralPath ($demoControl -replace '\.json$','-status.json') -Encoding UTF8
$code=Join-Path $env:LOCALAPPDATA 'Programs/Microsoft VS Code/Code.exe'
$arguments=@(('--user-data-dir="{0}"' -f $demoProfile),('--extensions-dir="{0}"' -f $demoExtensions),('--extensionDevelopmentPath="{0}"' -f $extensionRoot),('--extensionTestsPath="{0}"' -f (Join-Path $PSScriptRoot 'workbench-host.cjs')),('--remote-debugging-port={0}' -f $CapturePort),'--remote-debugging-address=127.0.0.1','--skip-welcome','--skip-release-notes','--disable-workspace-trust','--disable-telemetry','--new-window',('"{0}"' -f $demoProject))
$oldNodeMode=$env:ELECTRON_RUN_AS_NODE
$oldControl=$env:RUNDIX_DEMO_CONTROL
$oldProfile=$env:RUNDIX_DEMO_PROFILE
try {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $env:RUNDIX_DEMO_CONTROL=$demoControl
  $env:RUNDIX_DEMO_PROFILE=$demoProfile
  $process=Start-Process -FilePath $code -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
  if($process.ExitCode -ne 0){throw 'Isolated workbench demo failed.'}
} finally {
  $env:ELECTRON_RUN_AS_NODE=$oldNodeMode
  $env:RUNDIX_DEMO_CONTROL=$oldControl
  $env:RUNDIX_DEMO_PROFILE=$oldProfile
}
