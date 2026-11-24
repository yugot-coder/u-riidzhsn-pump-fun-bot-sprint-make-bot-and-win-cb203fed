# Pump.fun Bot Sprint — Early Probe + Ride the Runners

Paper trading bot for the make.fun **Pump.fun Bot Sprint** (`pumpfun-replay/v2`,
`agent-fun/replay/v2`). It trades 10 SOL of paper money on a replay of
Solana pump.fun bonding-curve activity and is ranked by paper net PnL
against holding cash.

## Strategy

**Early probe + ride the runners.** Measured on the dev window (128k
pump.fun events, 1,122 coins):

- A coin's fate is decided in its first minute: winners reach 1.5x within
  ~1 slot of their first trade and 3x within ~56 slots, and almost never
  retrace below their first-trade price before 2x. Chasing momentum after
  the move is already visible loses money — by then the buying is exhausted
  and the coin mean-reverts.
- So the bot buys a **tiny probe (0.01 SOL, the minimum round trip)** on
  as many fresh coins as the 5-position cap allows, on their **2nd–4th
  trade**, provided the price is still within 1.5x of its first-trade
  price. It keeps retrying while the coin is still that young.
- Losers are cut by a **time stop** (3,600 slots ≈ 24 min, only while still
  below 1.2x) and a **stop-loss at 0.5x** the first-trade price.
- Runners are ridden with a **take-profit at 1.3x** the first-trade price
  and a **wide trailing stop** (25% off the peak, armed at a 2.0x peak) —
  winners pull back ~25% on the way up, so a tight trail shakes them out.
- Orders use **wide slippage (2000 bps)**: on this market a fill more than
  5% worse than the decision price is exactly the fast pump we want to
  catch; rejecting it would select against the winners.
- Position size is capped by the harness rule (1% of the coin's real SOL
  reserve per reply), and the bot never deploys the last 0.2 SOL of cash.

The bot is fully deterministic (no clock, no environment, no randomness)
and defensive: unknown events are skipped, every batch is answered, and a
fault in one batch never kills the run.

## Files

- `main.ts` — the entrypoint; the strategy above, nothing else.
- `vendor/makefun-bot.ts` — the kit's zero-dependency `agent-fun/replay/v2`
  shim (copied unchanged from the competition SDK).
- `README.md` — this file.
- `LICENSE` — MIT.

## Run

```sh
node main.ts   # Node 22.18+ runs the TypeScript as-is; no install step
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout (hello / batch / done)
via `vendor/makefun-bot.ts`; diagnostics go to stderr, replies only to
stdout.
