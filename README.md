# ASKIIES (self-hosted)

ASKIIES is an ASCII / 3D jet-combat game, originally built as a claude.ai artifact.
This repo hosts it in Docker, with add-on modules and a multiplayer server.

| File | What it is |
|---|---|
| `ASKIIES.html` | The game itself (upstream single-file build) with our script tags added by `apply-patch.py` |
| `mp-client.js` | Online layer, loaded in `<head>`. It provides the `window.claude.use('room' / 'db' / 'user')` services the game expects, plus sign-in, the ONLINE / FRIENDS drawer, invites and the display callsign |
| `terrain-engine.js` | GPU terrain, ocean, sky and city buildings |
| `plane-engine.js` | Next-gen aircraft models, real missile rails and mouse aim |
| `mp-server/` | Node 24 + WebSocket + SQLite server: accounts (callsign + password + invite code), lobby/battle rooms, cloud saves, leaderboard and friends |
| `nginx.conf`, `Dockerfile`, `docker-compose.yml` | The web container (port 5210) and the `askiies-mp` container behind `/mp/` |

## Run

```sh
echo "ASKIIES_INVITE_CODE=CHANGE-ME" > .env   # never committed
docker compose up -d --build                  # http://localhost:5210
```

Player data lives in the Docker volume `askiies-mp-data`, not in this repo.

## Taking a new game version from upstream

1. Replace `ASKIIES.html` with the new file.
2. Run `python apply-patch.py` to re-add the `mp-client.js`, `terrain-engine.js` and `plane-engine.js` script tags.
3. Run `docker compose up -d --build`, test, then commit.

## Rolling back

`git log`, then `git checkout <commit> -- <file>` (or `git revert <commit>`), then `docker compose up -d --build`.
