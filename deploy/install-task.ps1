# Registers the Windows scheduled task "ASKIIES auto-deploy": runs auto-deploy.ps1 every 5 minutes, hidden,
# as the current user (Docker Desktop and git's GitHub sign-in live in this user's session). No admin needed.
#   powershell -ExecutionPolicy Bypass -File deploy\install-task.ps1            # install / update
#   powershell -ExecutionPolicy Bypass -File deploy\install-task.ps1 -Remove    # turn auto-deploy off
param([switch]$Remove, [int]$Minutes = 5)
$name = 'ASKIIES auto-deploy'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed the '$name' task."
  exit 0
}
$script = Join-Path $PSScriptRoot 'auto-deploy.ps1'
# conhost --headless keeps a console window from flashing up every 5 minutes.
$action = New-ScheduledTaskAction -Execute "$env:windir\System32\conhost.exe" `
  -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`"" `
  -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $Minutes)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Checks GitHub (keithanderson85/askiies, main) and deploys new commits after a smoke test. See deploy\README.md.' -Force | Out-Null
Write-Host "Installed '$name': every $Minutes minutes. Log: $env:LOCALAPPDATA\askiies-deploy\deploy.log"
