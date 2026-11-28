# Auto-deploy

Whatever is on GitHub's `main` branch goes live on askiies.silverstateapps.com within about 5 minutes,
**if it passes a quick automatic test**. Work on a branch and open a pull request; merging it into `main`
is what puts it live.

## What happens after a merge

Every 5 minutes the server PC checks GitHub (`deploy/auto-deploy.ps1`, run by the Windows task
"ASKIIES auto-deploy"). When `main` has new commits:

1. The server's copy is updated (fast-forward only).
2. A new game build uploaded under another name (for example `ASKIIES (1).html` from GitHub's
   "Add files via upload") is renamed to `ASKIIES.html`, gets the add-on script tags
   (`apply-patch.py`), and that is committed back to `main` automatically.
3. Changes to the game or add-ons: a test copy is built on port 5299 and `deploy/smoke-test.js` loads it in
   headless Edge. It checks that every add-on loads, the hangar menus and campaign page open, a free
   sortie flies, and there are no JavaScript errors.
   Only if that passes is the live site updated. Players already in a game keep playing; they get the
   new version when they reload.
4. Changes in `mp-server/`: the multiplayer server is rebuilt and restarted (online players are
   disconnected for a few seconds). If it isn't healthy afterwards, the previous version is put back.
5. Changes only to docs (`*.md`, `docs/`, `deploy/`) don't rebuild anything.

If a commit fails its test, **the live site stays on the last good version** and that commit is not
retried. Push a fix and the next commit is tried.

## Seeing what happened

- Admin page (`/admin`, Server card): live commit, last GitHub check, and any commit that was NOT
  deployed with the reason.
- Full log on the server PC: `%LOCALAPPDATA%\askiies-deploy\deploy.log`.

## On the server PC

```powershell
powershell -ExecutionPolicy Bypass -File deploy\install-task.ps1           # turn auto-deploy on (every 5 min)
powershell -ExecutionPolicy Bypass -File deploy\install-task.ps1 -Remove   # turn it off
powershell -ExecutionPolicy Bypass -File deploy\auto-deploy.ps1            # check right now
powershell -ExecutionPolicy Bypass -File deploy\auto-deploy.ps1 -Force     # re-test and redeploy current main
node deploy\smoke-test.js http://localhost:5210                            # test the live site
```

Needs Docker Desktop, git signed in to GitHub, Python, Node and Microsoft Edge. The first run installs
the test's one dependency (`npm install` in `deploy/`).
