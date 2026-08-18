# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BandzzBot: an automated trading bot for Deriv synthetic indices (Volatility 10/25/50/75/100, standard and 1s variants). It's a static frontend dashboard (`frontend/index.html`) backed by Netlify Functions (`netlify/functions/*.js`) that connect to the Deriv WebSocket API to fetch prices, compute a signal, and place contracts. There is no separate backend server, database, or build step — Netlify Functions + Netlify Blobs (for persistence) is the entire backend.

Two strategies exist, controlled by one switch (`settings.activeStrategy`), never run in parallel:
- **`rise_fall`** — EMA/RSI/ADX-based Rise/Fall contracts, with an adaptive trend/range regime switch (see `strategy_rise_fall.js`).
- **`digit`** — Digit Differ contracts, betting against whichever digit appeared most often recently (see `strategy_digit.js`). Explicitly documented in-file as having no real statistical edge — chosen only for its low per-trade variance.

## Commands

There is no build, lint, or test tooling in this repo (no `test`/`build`/`lint` scripts in `package.json`, no test framework installed). The only dependency is `@netlify/blobs`.

```bash
npm install              # install the one dependency (@netlify/blobs)
netlify dev               # run the frontend + functions locally (requires Netlify CLI)
netlify deploy --prod     # deploy (deploys are otherwise handled by Netlify's git integration)
```

There is no automated test suite. Verify changes by running locally with `netlify dev` against a **DEMO** Deriv token and watching the dashboard/logs, or by reasoning through the pure-function strategy modules (`strategy_rise_fall.js`, `strategy_digit.js`) directly, since they take plain arrays/params and return a signal with no I/O.

## Architecture

### Request flow
- **`driver.js`** is a Netlify *scheduled* function (`netlify.toml`: `*/1 * * * *`, every minute). It is the only place that actually places trades. Each run: acquires a cross-invocation lock, reconciles any orphaned trade from a previous run that died mid-flight, loads settings, dispatches to `runRiseFallStrategy` or `runDigitStrategy` based on `settings.activeStrategy`, and always releases the lock in a `finally`.
- **`status.js`**, **`balance.js`**, **`chart.js`**, **`settings.js`**, **`stats.js`**, **`control.js`** are on-demand HTTP functions the frontend polls/calls directly. They never place trades — `status.js`/`stats.js` only read from `memory.js`; `balance.js`/`chart.js` open their own short-lived WebSocket connections to Deriv for read-only data, independent of the trading loop so checking balance/chart never blocks or races a trade.
- **`control.js`** just flips `state.manualPause` (the STOP/START button); **`settings.js`** GET/POST validates and persists user-configured settings, taking effect on the *next* scheduled `driver.js` run, not instantly.

### Shared modules
- **`memory.js`** — all persistence, via Netlify Blobs (one store `bot-memory`, keyed by strings like `state_<strategy>`, `bot_settings`, `active_trade_<strategy>`, `regime_state_<symbol>`, `trade_history_<strategy>`, `weekly_state_<strategy>`, `execution_lock`). Each strategy (`rise_fall` / `digit`) has fully separate state so switching strategies doesn't mix stats. Also owns: daily/weekly P&L tracking, the regime hysteresis state machine (per-symbol, since different symbols can be in different regimes simultaneously), the cross-invocation execution lock, and persistent trade history used for `stats.js`'s by-hour/by-regime/by-symbol breakdown.
- **`risk.js`** — the single gate (`checkCanTrade`) `driver.js` consults before every trade: manual pause, cooldown-after-losses, daily/weekly profit goal hit, daily stop loss hit, consecutive-loss cooldown trigger. Reads both `memory.js` state and user settings; state can be mutated as a side effect (e.g. clearing an expired cooldown).
- **`deriv-auth.js`** — turns a Deriv API token (`DERIV_TOKEN` env var) into a per-request WebSocket URL via the accounts→OTP REST flow. Shared by every function that talks to Deriv over WS.
- **`strategy_rise_fall.js`** / **`strategy_digit.js`** — pure signal functions. No I/O, no persistence, no Deriv connection. Given candle/tick data and params, return `{ signal, reason, details }`. Regime state (trend/range) is computed and persisted externally in `memory.js`/`driver.js`; these files are just told the current regime.
- **`telegram.js`** — fire-and-forget one-way alerts (bot start, pause/cooldown, daily goal/stop-loss hit, EOD report, trade result) via Telegram's HTTP API directly, using `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`. No-ops silently if unconfigured.

### Key design points to preserve when changing this code
- **Trade recovery**: `driver.js` persists the contract ID immediately after a buy confirms (before waiting for settlement), so a mid-trade crash can be reconciled on the next run (`reconcileOrphanedTrade`) instead of silently losing the outcome.
- **Overlap protection**: `memory.acquireLock()`/`releaseLock()` prevent two scheduled invocations from placing duplicate trades or racing on state writes; a lock older than `LOCK_TIMEOUT_MS` (25s) is assumed abandoned and can be re-acquired.
- **Stake safety clamp**: `driver.js` and `settings.js` both enforce that a single trade can never exceed 20% of the daily stop loss, independently, as defense in depth.
- **Weekly de-risking**: stake automatically scales down (never up) as weekly net profit approaches the weekly goal (`getScaledStake` / `getStakeScaleFactor`), to protect gains rather than push harder.
- **Regime hysteresis**: trend/range regime switches require several consecutive confirming candles (`TREND_CONFIRM_CANDLES` / `RANGE_CONFIRM_CANDLES`), not a single ADX reading, to avoid flip-flopping. Tracked per-symbol.
- **Custom candles**: candles are built from raw ticks bucketed by `settings.candleGranularitySeconds` (`buildCandlesFromTicks`) instead of Deriv's native candles, because Deriv's own floor is 60s; falls back to native 60s candles if there isn't enough tick history.
- Do not point this at a real-money Deriv token during development — the `driver.js` header comment explicitly warns this is DEMO-only until proven out.

### Environment variables
- `DERIV_TOKEN` — Deriv API token (required; `driver.js`/`balance.js`/`chart.js` no-op or error without it).
- `APP_ID` — Deriv app ID (defaults to `'1089'`).
- `NETLIFY_SITE_ID`, `NETLIFY_AUTH_TOKEN` — needed by `memory.js` so scheduled functions can reach Netlify Blobs (they don't always get the automatic Blobs context that request-triggered functions do).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — optional; alerts are skipped if unset.

### Frontend
`frontend/index.html` is a single self-contained static file (inline CSS/JS, no framework, no build step) that polls the on-demand functions (`status`, `balance`, `chart`, `stats`) and posts to `control`/`settings`. Deployed as-is via `netlify.toml`'s `publish = "frontend"`.
