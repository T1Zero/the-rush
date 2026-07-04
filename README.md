# ⚡ OptionDecay's THE RUSH — Futures Trading Tournament

A free, self-hosted paper-trading competition platform for CME index futures with real market data, zero slippage, and instant fills.

## Run it

```
node server.js
```

Then open **http://localhost:3000**. No dependencies to install (Node 18+ required).

To let friends on your network join the competition, they can browse to `http://<your-ip>:3000`.

## Competition rules (enforced automatically)

| Rule | Value |
|---|---|
| Starting balance | $50,000 |
| Max trailing drawdown | $2,000 (trails equity high — breach = account **BLOWN**, positions auto-flattened) |
| Daily loss limit | $1,000 (breach = auto-flatten + locked until the next session) |
| Minis (ES, NQ) | Max 2 contracts per symbol |
| Micros (MES, MNQ) | Max 20 contracts per symbol |
| No overnight holding | Positions auto-flatten at the **5:00pm ET** daily session close; new trades are blocked from 4:59pm until the 6:00pm ET reopen (and all weekend). Holding *within* a session, including overnight, is fine — the rule bites only at the daily close. |

## Products

| Symbol | Contract | $/point |
|---|---|---|
| ES | E-mini S&P 500 | $50 |
| NQ | E-mini Nasdaq-100 | $20 |
| MES | Micro E-mini S&P 500 | $5 |
| MNQ | Micro E-mini Nasdaq | $2 |

## How it works

- **Data**: live index futures quotes pulled from Yahoo Finance every ~2.5s (free; near-real-time). Micros price off the same feed as their mini (they track the same index).
- **Fills**: market orders fill instantly at the last traded price — 0 slippage, $0 commissions.
- **Accounts**: name + email + password. Passwords are salted & hashed (scrypt). Everything persists to `data.json`.
- **Leaderboard**: organizer-only. Only the admin account sees every trader's equity/P&L. Regular users never receive other people's data.

## Security & access rules

- **Account isolation**: every API response is scoped to the logged-in token's own account. No endpoint returns another user's data (the leaderboard is the only cross-user view, and it's admin-only).
- **Admin account**: set by the `ADMIN_EMAIL` env var (defaults to `mail@mail.com`). Whoever registers that email is the organizer and is the only one who sees the leaderboard.
- **One account per IP**: a second registration from the same IP is rejected (the admin email is exempt). Disable with `ONE_ACCOUNT_PER_IP=0`.
- **Brute-force protection**: 8 failed logins from an IP triggers a 15-minute lockout. Passwords compared in constant time.
- Passwords are never sent back to the client; only salted scrypt hashes are stored.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Port to listen on (cloud hosts set this automatically) |
| `ADMIN_EMAIL` | mail@mail.com | The organizer account that sees the leaderboard |
| `TRUST_PROXY` | off | **Set to `1` on any cloud host / reverse proxy** so real client IPs (from `X-Forwarded-For`) are used for the one-account-per-IP rule |
| `ONE_ACCOUNT_PER_IP` | on | Set to `0` to allow multiple accounts per IP |
| `DATA_FILE` | ./data.json | Path to the accounts file (local file driver only) |
| `IGNORE_MARKET_HOURS` | off | Set to `1` to bypass the no-overnight / market-hours block so you can test trading while the market is closed |

> ⚠️ **Critical for cloud hosting:** you MUST set `TRUST_PROXY=1`. Without it, every request appears to come from the platform's proxy (one shared IP), so the one-account-per-IP rule would block *everyone* after the first person registers.

## Hosting it online free on Vercel (always-on, persistent)

The app runs two ways from **one** codebase:
- **Locally** (`node server.js`) it stores accounts in `data.json`.
- **On Vercel** it runs as a serverless function and stores accounts in a free **Upstash Redis** database. The switch is automatic based on env vars — no code changes.

### 1. Create the free database (Upstash)
1. Go to **console.upstash.com** → sign up (free, no card).
2. **Create Database** → Redis → pick a region near your users → Free tier.
3. On the database page, copy the two REST values:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

### 2. Put the code on GitHub
Create a repo and push this folder (it's already set up with `package.json`, `vercel.json`, and `api/`).

### 3. Deploy on Vercel
1. Go to **vercel.com** → sign up with your GitHub → **Add New → Project** → import the repo.
2. Framework preset: **Other** (leave build settings default).
3. Add **Environment Variables** (Project → Settings → Environment Variables):

   | Name | Value |
   |---|---|
   | `UPSTASH_REDIS_REST_URL` | *(from Upstash)* |
   | `UPSTASH_REDIS_REST_TOKEN` | *(from Upstash)* |
   | `TRUST_PROXY` | `1` |
   | `ADMIN_EMAIL` | `mail@mail.com` |

4. **Deploy.** You get a public `https://<project>.vercel.app` URL to share.

### 4. Claim the organizer account
On the live site, register **mail@mail.com** first — that email is the admin and the only one who sees the leaderboard.

> ⚠️ **`TRUST_PROXY=1` is required.** Every Vercel request comes through their proxy; without this flag all users look like one IP and the one-account-per-IP rule would block everyone after the first. With it set, real visitor IPs (from `X-Forwarded-For`) are used.

**Behavior note (serverless):** there's no background loop, so a trader who closes their tab with an open position has their drawdown / daily-loss auto-flatten applied the next time their account is touched (any request), rather than in real time. Prices are fetched on demand and cached ~3s, so the chart and fills stay in sync.

### Alternative: run it from your own PC (no cloud)
`node server.js` locally, then expose it with a free tunnel (`winget install Cloudflare.cloudflared` → `cloudflared tunnel --url http://localhost:3000`). Accounts persist in `data.json`, but your PC must stay on.

## Reset the competition

Stop the server, delete `data.json`, restart. (Or on a host, clear the accounts file.)

## Notes

- CME hours: futures trade Sun 6pm – Fri 5pm ET (daily 5–6pm ET break). Outside those hours the price feed is static at the last close, so fills still work but nothing moves.
- Trading day (for the daily loss limit) rolls over at midnight ET.
