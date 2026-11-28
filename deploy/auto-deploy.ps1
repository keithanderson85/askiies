# ASKIIES auto-deploy: checks GitHub for new commits on main and puts them live.
# Run every 5 minutes by the Windows scheduled task "ASKIIES auto-deploy" (see install-task.ps1).
#
#   1. fetch origin/main; nothing new -> stop
#   2. fast-forward this checkout (never overwrites local uncommitted work; if it can't, it stops and reports)
#   3. a game build uploaded under another name ("ASKIIES (1).html") becomes ASKIIES.html, gets the
#      add-on script tags (apply-patch.py), and that fix is committed and pushed back to GitHub
#   4. game / add-on changes: build a test container on port 5299, run deploy/smoke-test.js against it;
#      only if it passes is the live web container rebuilt (players keep playing; a reload gets the update)
#   5. mp-server changes: rebuild the multiplayer server (players get disconnected for a few seconds);
#      if it doesn't come back healthy, the previous image is put back
#   6. status -> the admin page (Server card) and the log in %LOCALAPPDATA%\askiies-deploy\deploy.log
#
# A commit that fails its test is not retried; the next commit pushed to main is tried instead.
# Run by hand:  powershell -ExecutionPolicy Bypass -File deploy\auto-deploy.ps1 [-Force]
#   -Force  re-test and redeploy the current origin/main even if it's already live or failed before.

param([switch]$Force)
$ErrorActionPreference = 'Continue'
$Repo = Split-Path -Parent $PSScriptRoot
$Dir = Join-Path $env:LOCALAPPDATA 'askiies-deploy'
New-Item -ItemType Directory -Force $Dir | Out-Null
$LogFile = Join-Path $Dir 'deploy.log'
$StateFile = Join-Path $Dir 'state.json'
$TestPort = 5299
Set-Location $Repo

function Write-Log([string]$msg) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  Write-Host $line
}
# Run a native command through cmd so its stderr doesn't turn into PowerShell errors; returns output, sets $LASTEXITCODE.
function Invoke-Cmd([string]$cmd) {
  $out = cmd /c "$cmd 2>&1"
  return ($out | Out-String).Trim()
}
function Read-State {
  if (-not (Test-Path $StateFile)) { return $null }
  try { return Get-Content $StateFile -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json } catch { return $null }
}
function Save-State($s) {
  [IO.File]::WriteAllText($StateFile, ($s | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
# Status for the admin page: written into the multiplayer server's data folder.
function Send-Status($s, [string]$state, [string]$err) {
  $o = [ordered]@{
    checked = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); state = $state
    live = $s.live; liveMsg = $s.liveMsg; deployed = $s.deployed; failed = $s.failed; error = $err
  }
  $json = $o | ConvertTo-Json -Compress
  # Written to a file and copied in: piping text into docker from Windows PowerShell adds a BOM.
  $tmp = Join-Path $Dir 'deploy-status.json'
  [IO.File]::WriteAllText($tmp, $json, [Text.UTF8Encoding]::new($false))
  Invoke-Cmd "docker cp ""$tmp"" askiies-mp:/data/deploy-status.json" | Out-Null
}
function Test-Health([string]$container, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i += 3) {
    $h = (docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $container 2>$null | Out-String).Trim()
    if ($h -eq 'healthy' -or $h -eq 'running') { return $true }
    Start-Sleep 3
  }
  return $false
}

# One run at a time.
$lock = $null
try { $lock = [IO.File]::Open((Join-Path $Dir 'run.lock'), 'OpenOrCreate', 'ReadWrite', 'None') } catch { exit 0 }

try {
  $s = Read-State
  if (-not $s) {
    # First run: whatever is checked out now is what's live.
    $s = [pscustomobject]@{ live = (Invoke-Cmd 'git rev-parse HEAD'); liveMsg = (Invoke-Cmd 'git log -1 --format=%s'); deployed = $null; failed = $null }
    Save-State $s
    Write-Log "first run: live = $($s.live.Substring(0,7)) $($s.liveMsg)"
  }

  $out = Invoke-Cmd 'git fetch -q origin main'
  if ($LASTEXITCODE -ne 0) { Write-Log "git fetch failed: $out"; Send-Status $s 'GitHub check failed' $out; exit 1 }
  $remote = Invoke-Cmd 'git rev-parse origin/main'
  if (-not $Force) {
    if ($remote -eq $s.live) { Send-Status $s 'up to date' $null; exit 0 }
    if ($remote -eq $s.failed) { Send-Status $s 'waiting for a fixed commit' $s.error; exit 0 }
  }
  $short = $remote.Substring(0, 7)
  Write-Log "new code on GitHub: $short $(Invoke-Cmd "git log -1 --format=%s $remote")"

  # 2. fast-forward
  $out = Invoke-Cmd 'git merge --ff-only -q origin/main'
  if ($LASTEXITCODE -ne 0) {
    $err = 'could not update this PC''s copy (local edits or commits are in the way): ' + $out
    Write-Log $err; $s.failed = $remote; $s | Add-Member -Force error $err; Save-State $s; Send-Status $s 'blocked' $err; exit 1
  }

  # 3. game build uploaded under another name -> ASKIIES.html
  $changed = @((Invoke-Cmd "git diff --name-only $($s.live) HEAD") -split "`r?`n" | Where-Object { $_ })
  $upload = $changed | Where-Object { $_ -match '^ASKIIES.*\.html$' -and $_ -ne 'ASKIIES.html' -and $_ -notmatch 'original' -and (Test-Path $_) } | Select-Object -Last 1
  if ($upload) {
    Write-Log "uploaded game build '$upload' becomes ASKIIES.html"
    Copy-Item -LiteralPath $upload -Destination 'ASKIIES.html' -Force
    Invoke-Cmd "git rm -q ""$upload""" | Out-Null
  }
  $out = Invoke-Cmd 'python apply-patch.py'
  if ($LASTEXITCODE -ne 0) { Write-Log "apply-patch.py failed: $out" }
  if (Invoke-Cmd 'git status --porcelain -- ASKIIES.html ASKIIES*.html') {
    Invoke-Cmd 'git add -- ASKIIES.html' | Out-Null
    $msg = Join-Path $Dir 'commit-msg.txt'
    $txt = "Auto-deploy: use the uploaded game build as ASKIIES.html`n`n" + $(if ($upload) { "It was uploaded as `"$upload`". " } else { '' }) + "Add-on script tags checked by apply-patch.py.`n"
    [IO.File]::WriteAllText($msg, $txt, [Text.UTF8Encoding]::new($false))
    Invoke-Cmd "git -c user.name=keithanderson85 -c user.email=keithanderson85@users.noreply.github.com commit -q -F ""$msg""" | Out-Null
    $out = Invoke-Cmd 'git push -q origin HEAD:main'
    if ($LASTEXITCODE -ne 0) { Write-Log "could not push the rename back to GitHub (deploying anyway): $out" } else { Write-Log 'pushed the rename back to GitHub' }
    $changed += 'ASKIIES.html'
  }
  $head = Invoke-Cmd 'git rev-parse HEAD'
  $headMsg = Invoke-Cmd 'git log -1 --format=%s'

  # What needs rebuilding?
  $mp = @($changed | Where-Object { $_ -match '^mp-server/' -or $_ -eq 'docker-compose.yml' }).Count -gt 0
  $web = @($changed | Where-Object { $_ -notmatch '^(mp-server/|docs/|deploy/|_bmad-output/|_snapshots/)' -and $_ -notmatch '\.md$' -and $_ -notmatch '^\.git' }).Count -gt 0
  if ($Force) { $web = $true }

  # 4. test the web build first
  if ($web) {
    Write-Log 'building a test copy of the game'
    $out = Invoke-Cmd 'docker build -q -t askiies-test .'
    if ($LASTEXITCODE -ne 0) { $err = 'build failed: ' + (($out -split "`n" | Select-Object -Last 3) -join ' '); Write-Log $err; $s.failed = $head; $s | Add-Member -Force error $err; Save-State $s; Send-Status $s 'NOT deployed: build failed' $err; exit 1 }
    Invoke-Cmd 'docker rm -f askiies-test' | Out-Null
    Invoke-Cmd "docker run -d --name askiies-test --network askiies_default -p ${TestPort}:80 askiies-test" | Out-Null
    Start-Sleep 3
    if (-not (Test-Path "$Repo\deploy\node_modules\playwright-core")) { Invoke-Cmd "cd /d ""$Repo\deploy"" && npm install --no-audit --no-fund" | Out-Null }
    $out = Invoke-Cmd "node ""$Repo\deploy\smoke-test.js"" http://localhost:$TestPort"
    $code = $LASTEXITCODE
    Invoke-Cmd 'docker rm -f askiies-test' | Out-Null
    Add-Content -Path $LogFile -Value $out -Encoding UTF8
    if ($code -ne 0) {
      $err = (($out -split "`n") | Where-Object { $_ -match 'FAIL' } | ForEach-Object { $_.Trim() }) -join '; '
      if (-not $err) { $err = 'smoke test failed' }
      Write-Log "NOT deployed ($($head.Substring(0,7))): the live site stays on $($s.live.Substring(0,7)). $err"
      $s.failed = $head; $s | Add-Member -Force error $err; Save-State $s; Send-Status $s 'NOT deployed: test failed' $err; exit 1
    }
    Write-Log 'smoke test passed'
  }

  # 5. go live
  if ($web) {
    Invoke-Cmd 'docker tag askiies-askiies:latest askiies-askiies:previous' | Out-Null
    $out = Invoke-Cmd 'docker compose up -d --build --no-deps askiies'
    if (-not (Test-Health 'askiies' 30)) {
      Invoke-Cmd 'docker tag askiies-askiies:previous askiies-askiies:latest' | Out-Null
      Invoke-Cmd 'docker compose up -d --no-build --no-deps askiies' | Out-Null
      $err = 'web container did not start; previous version put back'
      Write-Log $err; $s.failed = $head; $s | Add-Member -Force error $err; Save-State $s; Send-Status $s 'NOT deployed' $err; exit 1
    }
    Write-Log 'game updated on the live site'
  }
  if ($mp) {
    Invoke-Cmd 'docker tag askiies-askiies-mp:latest askiies-askiies-mp:previous' | Out-Null
    $out = Invoke-Cmd 'docker compose build askiies-mp'
    if ($LASTEXITCODE -ne 0) { $err = 'multiplayer server build failed: ' + (($out -split "`n" | Select-Object -Last 3) -join ' '); Write-Log $err; $s.failed = $head; $s | Add-Member -Force error $err; Save-State $s; Send-Status $s 'NOT deployed: build failed' $err; exit 1 }
    Invoke-Cmd 'docker compose up -d --no-deps askiies-mp' | Out-Null
    Start-Sleep 5
    if (-not (Test-Health 'askiies-mp' 60)) {
      Invoke-Cmd 'docker tag askiies-askiies-mp:previous askiies-askiies-mp:latest' | Out-Null
      Invoke-Cmd 'docker compose up -d --no-build --no-deps askiies-mp' | Out-Null
      $err = 'multiplayer server was not healthy after the update; previous version put back'
      Write-Log $err; $s.failed = $head; $s | Add-Member -Force error $err; Save-State $s; Send-Status $s 'NOT deployed' $err; exit 1
    }
    Write-Log 'multiplayer server updated'
  }
  if (-not $web -and -not $mp) { Write-Log 'nothing that runs on the server changed (docs only)' }

  $s = [pscustomobject]@{ live = $head; liveMsg = $headMsg; deployed = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); failed = $null }
  Save-State $s
  Send-Status $s 'up to date' $null
  Write-Log "LIVE: $($head.Substring(0,7)) $headMsg"
} finally {
  if ($lock) { $lock.Close() }
}
