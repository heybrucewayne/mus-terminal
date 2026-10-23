# MUS Terminal 2.0

A focused market workspace with crypto and traditional market quotes, a live bubble map, Solana token discovery, and probability-based scenario ranges. No framework, build step, or client dependencies.

## What's new

- Midnight default theme, a visible navigation bar, four market summary cards, and feed freshness status. Existing theme and wallpaper choices are retained.
- Search assets and commands with **⌘K / Ctrl+K**; navigate with arrow keys and Enter.
- Filter the watchlist by asset type and text without changing its saved order.
- One-time local price alerts with session freshness checks. Alerts run only while the page is open and are not push notifications.
- Overview, Solana focus, Chart desk, and a saved panel layout.
- Export/import a versioned JSON backup of preferences, watchlist, alerts, and panel positions. Quote caches and server keys are excluded.
- Shared 15-second server-side crypto cache with in-flight request deduplication, a bounded stale fallback, and honest unavailable states.
- Separate HTML, CSS, market code, workspace code and testable state utilities. Original charts, drag/resize panels, provider integrations and storage keys remain available.

## Run locally

Requires **Node.js 20+**. There are no packages to install.

```sh
npm run dev
```

Open <http://127.0.0.1:3000>. The development server serves both the static UI and the same API handlers used by Vercel. Optional `.env.local` values can be loaded with Node's built-in option:

```sh
node --env-file=.env.local scripts/dev.mjs
```

Copy `.env.example` if you want to configure optional token security providers. Public price/discovery sources work without those keys; unavailable checks must remain unverified.

## Check

```sh
npm run check
npm test
```

Checks cover source syntax and referenced assets. Tests cover shared API requests, cache freshness and outages, number handling, local alerts, filters and backup validation. GitHub Actions runs these on pushes and pull requests.

## Deploy

The repository retains Vercel's static root and `api/*.js` layout. Import the repository with the **Other** framework preset, no build command, and the repository root as the output. Keep optional API credentials in deployment environment variables, never in browser files.

## Data and limits

The footer reports **crypto feed** health, not the health of every provider. Traditional market quotes can be delayed. Summary cards show only values actually received; a missing quote stays missing. The server cache is per instance plus CDN caching, not a persistent global database. It reduces duplicate work but does not override upstream service terms.

Price alerts require a fresh quote fetched during the current tab session, fire once, and persist their state in browser storage. Closing the browser stops checks. Backups replace saved preferences and reload the page. Scenario ranges are estimates, not guaranteed outcomes. Existing optional token-security checks and scan scoring retain their original behavior.
