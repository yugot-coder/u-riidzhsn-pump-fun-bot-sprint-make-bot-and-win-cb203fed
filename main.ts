// SPDX-License-Identifier: MIT
// Pump.fun Replay Sprint — paper trading bot (agent-fun/replay/v2).
//
// Strategy: "early probe + ride the runners".
//
// Why this shape (measured on the dev window, 128k pump.fun events):
// - A coin's whole life is decided in its first minute: winners reach 1.5x
//   within ~1 slot of their first trade and 3x within ~56 slots, and they
//   almost never retrace below their first-trade price before 2x. Chasing
//   momentum after the move is already priced in loses money: by the time a
//   coin is visibly up 12-25%, the buying is exhausted and it mean-reverts.
// - The only workable entry is therefore a tiny probe bought as early as
//   the harness lets us (2nd-4th trade), sized at the 0.01 SOL minimum
//   round trip, on as many fresh coins as the 5-position cap allows.
// - Most probes bleed slowly back to their start price, so losers are cut
//   by a time stop; the few runners are ridden with a wide trailing stop
//   (winners pull back ~25% on the way up, so a tight trail shakes them
//   out) plus a take-profit at 1.3x the first-trade price, which is where
//   the bulk of the reliable gains sit.
// - Orders are sent with wide slippage (2000 bps): on this market a fill
//   more than 5% worse than the decision price is exactly the fast pump
//   we want to catch, and rejecting it would select against the winners.
//
// Everything is deterministic: no clock, no environment, no randomness.
// All thresholds are constants below; the harness caps (positions, order
// size, orders per batch) are read from hello at runtime.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning
const PROBE_LAMPORTS = 10_000_000n; // 0.01 SOL: the minimum round trip.
const CASH_RESERVE_LAMPORTS = 200_000_000n; // 0.2 SOL: never deploy the last of it.
const MAX_SLIPPAGE_BPS = 2000; // 20%: accept the fill on a fast pump.
const ENTRY_MIN_TRADES = 2; // buy on the 2nd trade at the earliest ...
const ENTRY_MAX_TRADES = 4; // ... and keep retrying while still this young.
const ENTRY_MAX_MULT = 1.5; // ... unless it already ran past 1.5x first price.
const TAKE_PROFIT_MULT = 1.3; // sell all at 1.3x the first-trade price.
const STOP_MULT = 0.5; // sell all at 0.5x the first-trade price.
const TRAIL_ARM_MULT = 2.0; // trailing stop arms once the peak hits 2.0x ...
const TRAIL_DROP = 0.25; // ... and fires on a 25% fall from that peak.
const TIMEOUT_SLOTS = 3600; // dead-money exit after this many slots ...
const TIMEOUT_MULT = 1.2; // ... but only while still below 1.2x first price.

// ------------------------------------------------------------------ per-coin memory
interface CoinMemory {
  /** Price (lamports per token, as a float) at the first TradeEvent seen. */
  firstPrice: number | null;
  /** Highest price multiple vs firstPrice seen since the position opened. */
  peakMult: number;
  /** Slot of the batch in which the position first appeared. */
  entrySlot: number;
}

const coins = new Map<Pubkey, CoinMemory>();

function priceOf(state: BotState, mint: Pubkey): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves <= 0n) return null;
  if (curve.virtual_quote_reserves <= 0n) return null;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

function hasPendingSell(state: BotState, mint: Pubkey): boolean {
  for (const pending of state.pending.values()) {
    if (pending.order.side === 'sell' && pending.order.mint === mint) return true;
  }
  return false;
}

function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
  for (const pending of state.pending.values()) {
    if (pending.order.side === 'buy' && pending.order.mint === mint) return true;
  }
  return false;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const maxOrders = state.hello.caps.max_orders_per_batch;
  const maxPositions = state.hello.caps.max_open_positions;
  const txFee = state.txFeeLamports();

  try {
    // ---- remember first-trade prices and entry slots -------------------
    for (const event of batch.events) {
      if (event.event !== 'TradeEvent') continue;
      const memory = coins.get(event.mint);
      if (memory === undefined) {
        const first = priceOf(state, event.mint);
        coins.set(event.mint, { firstPrice: first, peakMult: 1, entrySlot: -1 });
      }
    }
    // A position that just appeared (its buy fill landed) opens here.
    for (const mint of state.positions.keys()) {
      const memory = coins.get(mint);
      if (memory !== undefined && memory.entrySlot < 0) {
        memory.entrySlot = state.slot;
        const price = priceOf(state, mint);
        if (price !== null && memory.firstPrice !== null && memory.firstPrice > 0) {
          memory.peakMult = price / memory.firstPrice;
        }
      }
    }
    // Drop memory for coins whose positions are gone and which completed;
    // for a live coin that just exited, reset the entry record so a later
    // re-entry (same mint, still young) starts clean instead of reusing
    // the old entry slot and peak.
    for (const [mint, memory] of coins) {
      if (state.positions.has(mint)) continue;
      if (memory.entrySlot < 0) continue;
      const curve = state.curves.get(mint);
      if (curve?.complete) {
        coins.delete(mint);
      } else if (!hasPendingBuy(state, mint)) {
        memory.entrySlot = -1;
        memory.peakMult = 1;
      }
    }

    // ---- exits: every open position, every batch -----------------------
    for (const [mint, holding] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (hasPendingSell(state, mint)) continue;
      const memory = coins.get(mint);
      if (memory === undefined || memory.firstPrice === null || memory.firstPrice <= 0) continue;
      const price = priceOf(state, mint);
      if (price === null || price <= 0) continue;
      if (holding.token_amount <= 0n) continue;

      const mult = price / memory.firstPrice;
      if (mult > memory.peakMult) memory.peakMult = mult;

      let reason: string | null = null;
      if (mult >= TAKE_PROFIT_MULT) reason = 'take-profit';
      else if (mult <= STOP_MULT) reason = 'stop-loss';
      else if (memory.peakMult >= TRAIL_ARM_MULT && price <= (memory.peakMult * memory.firstPrice) * (1 - TRAIL_DROP)) reason = 'trailing-stop';
      else if (memory.entrySlot >= 0 && state.slot - memory.entrySlot >= TIMEOUT_SLOTS && mult < TIMEOUT_MULT) reason = 'time-stop';
      if (reason === null) continue;

      console.error(`slot ${state.slot} sell ${mint.slice(0, 8)} ${reason} mult=${mult.toFixed(3)} peak=${memory.peakMult.toFixed(3)}`);
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }

    // ---- entries: fresh coins in this batch, still early ----------------
    const openCount = state.committedPositionCount();
    let slotsFree = maxPositions - openCount;
    if (slotsFree > 0) {
      const seenThisBatch = new Set<Pubkey>();
      for (const event of batch.events) {
        if (orders.length >= maxOrders || slotsFree <= 0) break;
        if (event.event !== 'TradeEvent') continue;
        const mint = event.mint;
        if (seenThisBatch.has(mint)) continue;
        seenThisBatch.add(mint);
        if (state.positions.has(mint) || hasPendingBuy(state, mint)) continue;

        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.trades < ENTRY_MIN_TRADES || curve.trades > ENTRY_MAX_TRADES) continue;

        const memory = coins.get(mint);
        if (memory === undefined || memory.firstPrice === null || memory.firstPrice <= 0) continue;
        const price = priceOf(state, mint);
        if (price === null || price <= 0) continue;
        const mult = price / memory.firstPrice;
        if (mult > ENTRY_MAX_MULT) continue;

        // Size is the minimum round trip, capped at 1% of the real SOL
        // reserve (the harness rejects anything larger for this mint).
        const cap = state.maxBuyLamports(mint);
        if (cap < PROBE_LAMPORTS) continue;
        const size = PROBE_LAMPORTS < cap ? PROBE_LAMPORTS : cap;
        if (state.freeCashLamports() < size + txFee + CASH_RESERVE_LAMPORTS) continue;

        console.error(`slot ${state.slot} buy ${mint.slice(0, 8)} mult=${mult.toFixed(3)} trades=${curve.trades}`);
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: size,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        slotsFree -= 1;
      }
    }
  } catch (error) {
    // Never let one bad batch kill the run: keep whatever orders were
    // already decided and answer the batch. Diagnostics go to stderr.
    console.error(`slot ${state.slot} onBatch error (continuing): ${error instanceof Error ? error.message : String(error)}`);
  }

  return orders;
}

await runBot({
  onHello(state) {
    console.error(
      `hello seed=${state.hello.seed} capital=${state.hello.capital.lamports} ` +
        `maxPos=${state.hello.caps.max_open_positions} maxOrderBps=${state.hello.caps.max_order_bps_of_real_reserve}`,
    );
  },
  onBatch,
  onDone(state, done) {
    console.error(`done reason=${done.reason} cash=${state.cash} positions=${state.positions.size}`);
  },
});
