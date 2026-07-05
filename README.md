<p align="center">
  <img src="site/public/logo.svg" alt="Decall" width="160">
</p>

# decall_client

Web client for **Decall** — sign in with a wallet or passkey, get a visual Call ID from your public key, and join a P2P text chat over WebRTC.

Built with [Cruzo](https://www.npmjs.com/package/cruzo), [cruzo-web3](https://www.npmjs.com/package/cruzo-web3) (SecretAuth), and Vite.

**Backend:** [decall_server](https://github.com/MaratBektemirov/decall_server) (challenge API + WebRTC signaling).

## Quick start

```bash
npm install
cp site/.env.example site/.env   # optional: VITE_API_BASE, WalletConnect
npm run dev
```

Open `http://localhost:5173`. The dev server proxies `/api` to `http://localhost:8080` — start the API first:

```bash
cd ../decall_server && make dev
```

## Flow

1. **Sign in** — wallet or passkey via SecretAuth (challenge from `GET /api/auth/challenge`).
2. **Your ID** — four emojis derived from your public key.
3. **Host** — open a room (room id = your Call ID).
4. **Guest** — paste the host’s Call ID and join.
5. **Chat** — messages over WebRTC data channel; server only signals. TURN credentials (`POST /api/turn-credentials`) are fetched automatically before each call when P2P is blocked.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server (`:5173`) |
| `npm run build` | Production build → `dist-site/` |

## Env (`site/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_BASE` | `/api` | API base URL (proxied in dev) |
| `VITE_WALLETCONNECT_PROJECT_ID` | — | WalletConnect project id (optional) |
