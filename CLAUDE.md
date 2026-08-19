# CLAUDE.md
# Your role
This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Your role 
- Separate concerns into independent modules Clear interfaces between components High cohesion, low coupling Scalability Design for horizontal scaling
-  Implement caching strategies and Maintainability
-  Keep code organized and consistent
-  Document architecture decisions
- Write comprehensive tests Architecture Process and Analyze Current State
- Review existing architecture Identify patterns and technical debt
- Design High-level architecture diagram Component responsibilities and Trade-Off
- Analize pros, cons, and alternatives for decisions
-Identify scalability bottlenecks

# About Me

Based in Baltimore, MD.
Builder — I like figuring out systems and making them work for me.
Currently deep into Deriv trading bots, but I learn fast and jump between tools.

# Personality

- Direct, no BS. Say it straight.
- Independent — I want the framewor.
- Minimalist. If it doesn't need to be there, don't add it.
- I like things that are efficient and consistent over flashy and risky.
- builder, I get locked in when I'm testing an idea.

# How I Like AI To Talk To Me

- Short and useful. No long intros, no motivational paragraphs.
- Don't repeat basics I already know.
- If I ask for a prompt, just give me the prompt.
- explain as if your talking to a child.
- be witty and jovial no need to talk like a robot 

# Likes
- keeping things simple,simplicity over complexity.
- Clean code, simple systems that work
- Testing ideas fast, framework-first approach
- Tools like GitHub, Netlify, Claude,when they actually save time
- Figuring stuff out 
-long term survival 

# Dislikes

- Fluff and over-explaining
- AI adding extra features I didn't ask for
- Being told the same warning 5 times
- People overcomplicating simple things

# What I'm Working On Right Now

Learning and building trading automation, but that's just one lane. 
I like to keep my systems private and my code clean.

## What this is

BandzzBot: an automated trading bot for Deriv synthetic indices (Volatility 10/25/50/75/100, standard and 1s variants). It's a static frontend dashboard (`frontend/index.html`) backed by Netlify Functions (`netlify/functions/*.js`) that connect to the Deriv WebSocket API to fetch prices, compute a signal, and place contracts. There is no separate backend server, database, or build step — Netlify Functions + Netlify Blobs (for persistence) is the entire backend.

Three strategies exist, controlled by one switch (`settings.activeStrategy`), never run in parallel:
- **`accumulator`** — Accumulator contracts, entered only when ADX reads calm/ranging (see `strategy_accumulator.js`), cashed out via Deriv's native take-profit or a max-hold-time safety sell. Survival-focused: the goal is avoiding knockout, not calling direction — see the Accumulator lifecycle note below.
- **`digit_differ`** — fixed-odds, not directional at all: bets the next tick's last digit won't be one of N excluded digits (see `strategy_digit_differ.js`). Win probability is exactly N/10, guaranteed by the contract's own combinatorics rather than any market read — which digits get excluded doesn't affect the odds, so they're picked by simple time-based rotation, not a heuristic pretending to add edge that isn't there. Stacks N simultaneous contracts (one per excluded digit) over a single batched WebSocket connection (`placeDigitDifferBatchAndWait`) so raising the excluded-digit count doesn't multiply the connection/auth load per run — same batching principle as `connectAndGetTicksForSymbols`, applied to buys.
- **`hybrid`** — not a third signal, a meta-strategy: reads ADX on the user's chosen symbol each run and picks whichever of the other two styles fits the market (`runHybridStrategy` in `driver.js`), so the user only sets stake and profit goal. Calm ADX (at or below `accumulatorAdxMaxEntry`) → `accumulator`, anything else → `digit_differ` (which doesn't care about market conditions, so it's simply the fallback) — the routing decision itself lives in the pure, unit-tested `pickHybridBucket`. It reuses whatever settings each sub-strategy already has configured rather than introducing its own copies, and delegates the actual entry/buy/record logic straight to `runAccumulatorStrategy`/`runDigitDifferStrategy` (passing `'hybrid'` as the strategy-name bucket) instead of duplicating it. Tracked as its own strategy bucket in `memory.js`/`risk.js`/stats, separate from running each style manually — trade history additionally records which style was picked per trade (`subStrategy`), and `stats.js`'s `bySubStrategy` breakdown (dashboard's "By style" panel) is hybrid-only, per an explicit decision to give hybrid its own stats rather than blend into the style it borrowed.

Two prior strategies were removed from the codebase entirely, both recoverable from git history if ever wanted back:
- `even_odd` (DIGITEVEN/DIGITODD, fading whichever digit parity appeared most often recently) — its own honesty caveat (a synthetic index's last digit is close to uniformly even/odd) meant it never had a real statistical edge, and it lost money live in practice.
- `rise_fall` (EMA/RSI/ADX-based Rise/Fall contracts with an adaptive trend/range regime switch) — direction-calling on these instruments can't sustainably beat ~50% (the payout skew means even a true coin flip loses money slowly), which didn't fit the goal of styles that win consistently often. `digit_differ` and `accumulator` both win via a fundamentally different mechanism (fixed odds / survival, not predicting direction) rather than trying to out-guess the market.

## Commands

No build or lint tooling. There's a minimal zero-dependency test suite (`test/`, plain Node + `assert`, no framework) covering the pure strategy math. The only runtime dependency is `@netlify/blobs`.

```bash
npm install              # install the one dependency (@netlify/blobs)
npm test                  # runs test/run.js - unit tests for strategy_accumulator.js / strategy_digit_differ.js / memory.js's stake-scaling math / driver.js's pickHybridBucket
netlify dev               # run the frontend + functions locally (requires Netlify CLI)
netlify deploy --prod     # deploy (deploys are otherwise handled by Netlify's git integration)
```

`npm test` covers the pure-function strategy modules (`strategy_accumulator.js`, `strategy_digit_differ.js`) plus the pure logic extracted from `memory.js` (stake-scaling factors) and `driver.js` (`pickHybridBucket`) — everything else that's still I/O-bound (Deriv WS/REST calls, Netlify Blobs, the scheduled trading loop) has no automated coverage. Verify those by running locally with `netlify dev` against a **DEMO** Deriv token and watching the dashboard/logs.

## Architecture

### Request flow
- **`driver.js`** is a Netlify *scheduled* function (`netlify.toml`: `*/1 * * * *`, every minute). It is the only place that actually places trades. Each run: acquires a cross-invocation lock, reconciles any orphaned trade from a previous run that died mid-flight, loads settings, dispatches to `runAccumulatorStrategy`, `runDigitDifferStrategy`, or `runHybridStrategy` based on `settings.activeStrategy`, and always releases the lock in a `finally`.
- **`status.js`**, **`balance.js`**, **`settings.js`**, **`stats.js`**, **`control.js`** are on-demand HTTP functions the frontend polls/calls directly. They never place trades — `status.js`/`stats.js` only read from `memory.js`; `balance.js` opens its own short-lived WebSocket connection to Deriv for read-only data, independent of the trading loop so checking balance never blocks or races a trade. A former **`chart.js`** (candlestick-data endpoint) and the dashboard's candlestick chart widget were both removed entirely to cut a recurring API call and simplify the UI.
- **`control.js`** just flips `state.manualPause` (the STOP/START button); **`settings.js`** GET/POST validates and persists user-configured settings, taking effect on the *next* scheduled `driver.js` run, not instantly. `settings.js` also exports `validateStakeAmount`/`ALLOWED_SYMBOLS` so `telegram-webhook.js` enforces the exact same stake rule instead of a second copy of it.
- **`telegram-webhook.js`** is the Telegram-side counterpart to `control.js`/`settings.js` — a remote control channel (`/start`, `/stop`, `/status`, `/strategy`, `/stake`) for when the dashboard isn't open. Not auto-wired by Netlify; Telegram must be told to POST updates here via `setWebhook` (see the file header). Every command is checked against `TELEGRAM_CHAT_ID` first and silently ignored otherwise — since `control.js`/`settings.js` still have no auth of their own (a known, deliberately deferred gap), this chat-ID check is the *only* thing gating remote control right now.

### Shared modules
- **`memory.js`** — all persistence, via Netlify Blobs (one store `bot-memory`, keyed by strings like `state_<strategy>`, `bot_settings`, `active_trade_<strategy>`, `trade_history_<strategy>`, `weekly_state_<strategy>`, `execution_lock`). Each strategy (`accumulator` / `digit_differ` / `hybrid`) has fully separate state so switching strategies doesn't mix stats — this required zero code changes for `hybrid` since the module is already generic by strategy-name string. Also owns: daily/weekly P&L tracking, the cross-invocation execution lock, and persistent trade history used for `stats.js`'s by-hour/by-symbol/by-exit-reason/by-sub-strategy breakdown.
- **`risk.js`** — the single gate (`checkCanTrade`) `driver.js` consults before every trade: manual pause, cooldown-after-losses, daily/weekly profit goal hit, daily stop loss hit, consecutive-loss cooldown trigger. Reads both `memory.js` state and user settings; state can be mutated as a side effect (e.g. clearing an expired cooldown). Fully generic by strategy name — needed no changes to support `accumulator`/`digit_differ`.
- **`deriv-auth.js`** — turns a Deriv API token (`DERIV_TOKEN` env var) into a per-request WebSocket URL via the accounts→OTP REST flow. Shared by every function that talks to Deriv over WS. Each returned URL is single-use — every new WS connection re-authenticates. Its two REST calls retry on transient timeout/network failures (`fetchWithRetry`, 2 retries) but never on a genuine Deriv rejection (a real HTTP response is Deriv answering, not something a retry fixes) — the one exception is a 200 response with an empty accounts array, seen in practice as a transient Deriv-side hiccup rather than a genuine "no accounts" answer, which gets its own short retry loop since `fetchWithRetry` only retries actual network/timeout failures. Also the single enforcement point for **live-trading**: `getOtpWebSocketUrl` overrides `preferDemo` back to `true` regardless of what a caller passes, unless `ALLOW_LIVE_TRADING=true` is set — a real-money connection requires deliberately setting that env var, not just a function argument somewhere changing.
- **`indicators.js`** — shared pure indicator math with no single owning strategy. Currently just `calculateADX`, used by `strategy_accumulator.js`'s entry gate and by `hybrid`'s own market read in `driver.js`. Extracted here when `rise_fall` (the strategy that originally owned it) was removed, since ADX itself isn't Rise/Fall-specific logic.
- **`strategy_accumulator.js`** — pure entry-gate function. No I/O, no persistence. Accumulators aren't directional, so there's no CALL/PUT signal — `getEntryDecision(candles, params)` just returns whether ADX is calm enough to enter (`canEnter`), reusing `indicators.calculateADX` rather than duplicating it. Also exports `ticksToTakeProfitPct`.
- **`strategy_digit_differ.js`** — pure digit-selection function, no I/O, no persistence, no market data needed at all. `pickExcludedDigits(excludeCount, rotationSeed)` returns which digit(s) to bet against this trade, by simple deterministic rotation through 0-9 — since win probability is fixed by the digit *count* alone, which specific digits get excluded doesn't affect the odds.
- **`telegram.js`** — fire-and-forget alerts (bot start, pause/cooldown, daily goal/stop-loss hit, EOD report, trade result) via Telegram's HTTP API directly, using `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`. No-ops silently if unconfigured. One-way (bot → you); `telegram-webhook.js` is the reverse direction (you → bot), a separate file since it's request-triggered by Telegram rather than called from within a strategy run.

### Key design points to preserve when changing this code
- **Trade recovery**: `driver.js` persists a trade marker *before* sending a buy, then updates it with the contract ID immediately after the buy confirms (before waiting for settlement), so a mid-trade crash can be reconciled on the next run (`reconcileOrphanedTrade`) instead of silently losing the outcome.
- **Accumulator lifecycle is fundamentally different from Digit Differ's**: Digit Differ settles within a single tick, so `runDigitDifferStrategy` can block a single invocation on `placeDigitDifferBatchAndWait()` until every bet in the batch is done. Accumulators have no fixed expiry and can stay open for many minutes — far longer than one ~30s scheduled invocation. So `runAccumulatorStrategy` instead **buys and returns immediately**, then **polls** the open contract on every subsequent run (`pollActiveAccumulator`) until Deriv's native take-profit sells it, a knockout sells it, or the `accumulatorMaxHoldMinutes` safety timer forces a sell. Because of this, `reconcileOrphanedTrade` deliberately does nothing once an accumulator trade has a contract ID — `pollActiveAccumulator` is the sole owner of resolving it (it also does exit-reason classification `reconcileOrphanedTrade` doesn't know how to do), avoiding a race where both paths try to record the same settled trade. This check is by trade *shape* (`active.growthRate !== undefined`), not just `strategyName === 'accumulator'`, so it also catches an accumulator-shaped trade filed under the `hybrid` bucket when hybrid picked accumulator that run.
- **Accumulator take-profit: flat % or target ticks**: `accumulatorTakeProfitPct` (flat percentage of stake) is the default, but setting `accumulatorTakeProfitTicks` > 0 overrides it — the take-profit percentage is derived at trade time from `strategy_accumulator.ticksToTakeProfitPct(growthRate, ticks)` (`(1 + growthRate)^ticks - 1`), so a target like "cash out after ~3 ticks" stays correct even if the growth rate changes later, instead of the user hand-computing and re-entering a percentage. Trades win size for a higher chance of cashing out before a knockout — same survival-first philosophy as the rest of this strategy.
- **Digit Differ batches N contracts over one WebSocket connection**: excluding multiple digits means multiple simultaneous `DIGITDIFF` contracts, one per digit. `placeDigitDifferBatchAndWait` sends all N `buy` requests over a single connection (tagged with `req_id`, matched to settlement via `contract_id` since Deriv's `proposal_open_contract` push doesn't reliably echo `req_id`) instead of one connection per bet — raising the excluded-digit count doesn't multiply the auth/connection load per run. Configured stake (`settings.stakeAmount`, after scaling) is the TOTAL risk for the trade event, split evenly across the N bets — not risked in full per bet — so total exposure doesn't scale with however many digits are excluded.
- **Digit Differ crash recovery is all-or-nothing**: a leftover `active.contractIds` array (shape check, parallel to accumulator's `growthRate` check) means the invocation died mid-batch. `reconcileOrphanedDigitDifferBatch` queries every contract's status first and only records results once *every* contract has settled — recording one at a time as they resolve isn't safe, since `recordAndLogTrade` clears the whole active-trade marker on its first call, which would silently drop tracking of the still-unresolved contract IDs.
- **Overlap protection**: `memory.acquireLock()`/`releaseLock()` prevent two scheduled invocations from placing duplicate trades or racing on state writes; a lock older than `LOCK_TIMEOUT_MS` (25s) is assumed abandoned and can be re-acquired.
- **Stake safety clamp**: `driver.js` and `settings.js` both enforce that a single trade can never exceed 20% of the daily stop loss, independently, as defense in depth.
- **Weekly de-risking**: stake automatically scales down (never up) as weekly net profit approaches the weekly goal (`getScaledStake` / `getStakeScaleFactor`), to protect gains rather than push harder.
- **Three-factor stake scaling, always downward**: `getScaledStake` combines three independent multiplicative factors, each capped at 1.0 (never scales up) — weekly de-risking (above), a losing-streak factor (`memory.getLosingStreakScaleFactor`, ramps to a 0.5x floor by the time `consecutiveLosses` reaches `maxConsecutiveLosses`, the same point `risk.js` fully pauses, so graduated sizing and the hard pause converge instead of disagreeing), and a confidence factor (`memory.getConfidenceScaleFactor` — no current strategy produces a confidence score, kept as an optional no-op hook for a future one that does). The three multiply together; since each is ≤1.0 and the base stake (`settings.stakeAmount`) is already clamped to ≤20% of `dailyStopLoss` before scaling ever runs, the scaled result can never exceed that clamp.
- **Custom candles**: candles are built from raw ticks bucketed by `settings.candleGranularitySeconds` (`buildCandlesFromTicks`) instead of Deriv's native candles, because Deriv's own floor is 60s; falls back to native 60s candles if there isn't enough tick history. `fetchCandlesForSymbol` wraps this fetch-with-fallback for a single symbol; `fetchCandlesForWatchlist` is the batched equivalent used by `accumulator`'s watchlist auto-scan (and `hybrid`'s own ADX read), fetching all 3 symbols' tick history over **one** WebSocket connection (`connectAndGetTicksForSymbols`, correlating responses via `req_id`) instead of one connection per symbol — sustained per-scan connection volume is what caused real Deriv-side throttling in practice, so this isn't just theoretical. Both candle-fetch functions and `calculateADX` (`indicators.js`) exist purely to support `accumulator`'s entry gate and `hybrid`'s routing read now — `digit_differ` needs neither, since it has no market read at all.
- **API failure kill switch**: `driver.js`'s top-level catch calls `memory.recordApiFailure`, which trips `manualPause` (the same flag the STOP button sets) after `memory.API_FAILURE_KILL_SWITCH` (5) consecutive failed runs, and fires one Telegram alert (`killSwitchAlertSent` guards against re-alerting every run after). A single successful run (`memory.recordApiSuccess`) clears the streak. This only ever fires on *unhandled* errors (network/auth failures bubbling out of a strategy function) — deliberate "soft" outcomes like a Deriv business-rule rejection (e.g. a daily stake limit) return normally and don't count, since retrying those wouldn't help and isn't a health problem. A separate, persistent error log (`memory.appendErrorLog`/`getErrorLog`, capped rolling list per strategy, distinct from the routine `recentEvents` log) is written alongside every kill-switch-counted failure and surfaced on the dashboard so failures are visible without reading Netlify's function logs.
- Do not point this at a real-money Deriv token during development — the `driver.js` header comment explicitly warns this is DEMO-only until proven out, and `deriv-auth.js`'s `ALLOW_LIVE_TRADING` gate enforces it in code, not just in a comment. This applies doubly to `digit_differ` and `accumulator`, since both are structurally newer and less proven against live Deriv API responses than a longer-running strategy would be.

### Environment variables
- `DERIV_TOKEN` — Deriv API token (required; `driver.js`/`balance.js` no-op or error without it).
- `APP_ID` — Deriv app ID (defaults to `'1089'`).
- `ALLOW_LIVE_TRADING` — must be the exact string `'true'` to allow real-money account selection; unset or anything else forces demo, enforced inside `deriv-auth.js` itself (see above), not by trusting every call site.
- `NETLIFY_SITE_ID`, `NETLIFY_AUTH_TOKEN` — needed by `memory.js` so scheduled functions can reach Netlify Blobs (they don't always get the automatic Blobs context that request-triggered functions do).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — optional; alerts are skipped if unset.
- `DASHBOARD_SECRET` — required for `control.js`/`settings.js` to accept requests (see `auth.js`); fails closed (500) if unset, rather than silently allowing unauthenticated access. The frontend prompts for the same value once and remembers it in `localStorage`.

### Frontend
`frontend/index.html` is a single self-contained static file (inline CSS/JS, no framework, no build step) that polls the on-demand functions (`status`, `balance`, `stats`) and posts to `control`/`settings`. Deployed as-is via `netlify.toml`'s `publish = "frontend"`.

## Development workflow

No CI — every one of these checks is manual, every time, before anything reaches `main`. Skipping a step is exactly how the `fetchCandlesForSymbol` regression (a shared function accidentally deleted along with an unrelated code block) reached production.

1. **Branch.** Create a feature branch off `main` — never commit directly to `main`.
2. **Change.** Make the edit.
3. **Verify, before committing:**
   - `node --check <every changed .js file>` — catches syntax errors instantly, costs nothing.
   - If `frontend/index.html` changed: extract the `<script>` block and run it through `new Function()` to catch JS syntax errors the browser would otherwise be the first to find.
   - `npm test` — must show only new passes, zero failures, and the same or higher total count as before the change (a lower count usually means a test file broke silently, e.g. a bad merge).
   - **After any large deletion or refactor** (moving code between files, bulk-removing a feature): grep for every top-level function definition before and after, and diff the two lists by hand. A bulk delete can silently sweep up a shared function that happened to sit inside the deleted range — `node --check` and `npm test` will NOT catch a function that's simply missing if nothing in the test suite exercises that code path (most of `driver.js` has no test coverage — see Commands above).
4. **Commit** on the feature branch with a message that explains *why*, not just *what*.
5. **Merge to `main`:** `git fetch origin main` → `git checkout main` → `git merge origin/main --ff-only` → `git merge <feature-branch> --no-ff` (never squash, keep the branch's history visible).
6. **Re-verify on the merged result** — repeat step 3's checks *after* merging, not just before. A merge can reintroduce a conflict resolution mistake that neither branch had alone.
7. **Push** (`git push origin main`) — Netlify's git integration deploys automatically on push, there is no separate manual deploy step.
8. **Delete the local feature branch** once merged and pushed.
9. **Watch it live.** Anything touching `driver.js`, `memory.js`, or the Deriv WS/REST calls has zero automated coverage (see Commands above) — the only real verification is `netlify dev` against a **DEMO** token, or watching the actual Netlify function logs after deploy for the next few scheduled runs. Don't consider a change to that code "done" until it's been observed actually running clean live, not just merged.
