# League Picker Backend

Fetches champion counter data from U.GG and caches it.

## Deploy to Railway (free)

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Select the repo → Railway auto-detects Node.js and deploys
4. Copy your Railway URL (e.g. `https://league-picker-backend.railway.app`)
5. Put that URL in your app's `counters.ts` as `BACKEND_URL`

## Endpoints

- `GET /` — health check, shows cache status
- `GET /counters/:champion` — counters for one champion
- `GET /counters?picks=Jinx,Renekton&bans=Zed` — suggestions for multiple picks
- `POST /refresh` — manually refresh the cache

## Cache

- Refreshes every 6 hours automatically
- On first boot, fetches all ~150 champions (takes ~3-4 minutes)
- Rate limited to 3 requests per 1.5s to avoid U.GG blocks
