param([ValidateSet('host.cjs','new-session-host.cjs','titles-host.cjs','local-auth-host.cjs','reconnect-host.cjs','cli-install-host.cjs','cli-updates-host.cjs','pasted-image-host.cjs','mode-queue-host.cjs','follow-ups-host.cjs','fast-host.cjs','startup-host.cjs','control-motion-host.cjs','activity-host.cjs','context-display-host.cjs','notifications-host.cjs','toggle-response-host.cjs')][string]$TestFile='host.cjs',[switch]$ForceReducedMotion)
$ErrorActionPreference='Stop'
$workbenchRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$workbenchCode=Join-Path $env:LOCALAPPDATA 'Programs/Microsoft VS Code/Code.exe'
$workbenchProfile=Join-Path $workbenchRoot ('.verification/host-'+[guid]::NewGuid().ToString('N'))
$workbenchExtensions=Join-Path $workbenchRoot '.verification/isolated-extensions'
New-Item -ItemType Directory -Path $workbenchExtensions -Force | Out-Null
$workbenchProject=Join-Path $workbenchProfile 'fixture-project'
New-Item -ItemType Directory -Path $workbenchProject -Force | Out-Null
$workbenchArgs=@(('--user-data-dir="{0}"' -f $workbenchProfile),('--extensions-dir="{0}"' -f $workbenchExtensions),('--extensionDevelopmentPath="{0}"' -f $workbenchRoot),('--extensionTestsPath="{0}"' -f (Join-Path $PSScriptRoot $TestFile)),'--skip-welcome','--skip-release-notes','--disable-workspace-trust','--new-window',('"{0}"' -f $workbenchProject))
if($ForceReducedMotion){$workbenchArgs+='--force-prefers-reduced-motion'}
$workbenchNodeMode=$env:ELECTRON_RUN_AS_NODE
try{Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue;$workbenchProcess=Start-Process -FilePath $workbenchCode -ArgumentList $workbenchArgs -WindowStyle Hidden -PassThru -Wait}finally{$env:ELECTRON_RUN_AS_NODE=$workbenchNodeMode}
$workbenchResult=Get-Content -LiteralPath (Join-Path $workbenchRoot ('.verification/' + [IO.Path]::GetFileNameWithoutExtension($TestFile) + '.json')) -Raw | ConvertFrom-Json
$workbenchResult | ConvertTo-Json
if(-not $workbenchResult.passed -or $workbenchProcess.ExitCode -ne 0){throw 'Workbench extension host validation failed.'}
