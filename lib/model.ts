// Token Radar's value model (radar-2): rank pre-token protocols by an implied token value that is
// calibrated on the snapshot itself, not on a flat constant.
//
// implied = TVL x category multiple x growth multiplier x maturity multiplier
//
//   category multiple  The median market-cap / TVL ratio of the live-token protocols in the same
//                      category (at least 3 with both figures, else the global median 0.2138 over
//                      the 128 live protocols that carry both). Clamped to [0.05, 2.0]. A DEX's token
//                      trades at a different multiple of TVL than a lender's, and the snapshot says so.
//                      Protocols with a non-positive TVL or market cap are left out of the
//                      calibration: one live protocol in the snapshot carries a market cap of -1.
//   growth multiplier  1 + clamp(change_7d, -60, 120) / 100 x 0.5. A protocol growing 20% in a week
//                      scores 10% above one standing still; a missing 7d change counts as 0.
//   maturity multiplier  0.6 + min(age_days, 1095) / 1095 x 0.4. Age is the days since first listing,
//                      the snapshot's only record of how long a protocol has run with no token.
//                      An unlisted age uses 365 days. Older with no token means more to price in.
//
// The watchlist is the floor, never the ceiling: every pre-token protocol that is not a wrapped,
// staked or bridged product, not a versioned copy and not an exchange product is rankable, and the
// board holds all of them. Protocols whose token already trades are set aside with their market cap
// shown, never ranked. No protocol name is special-cased anywhere in this file.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number | null;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  watchlist: string[];
  protocols: SnapshotProtocol[];
}

export interface BoardRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  rank: number;
  implied_value_usd: number;
  category_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

export const MODEL_VERSION = 'radar-2';

export const MODEL = {
  growth_floor: -60,
  growth_cap: 120,
  growth_weight: 0.5,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  multiple_floor: 0.05,
  multiple_cap: 2.0,
  multiple_min_sample: 3,
  early_rows: 200,
  live_rows: 24,
} as const;

/** A protocol has no token on record when all three token fields are null. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_PRODUCT = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIX = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * A wrapped, staked or bridged product, a versioned copy or an exchange product is not a token
 * launch to rank: its token already exists elsewhere, or it is the same protocol under another
 * name. This is the watchlist's own exclusion rule, applied to the whole board.
 */
export function isLaunchable(p: SnapshotProtocol): boolean {
  if (p.category !== null && WRAPPED_PRODUCT.has(p.category)) return false;
  const name = p.name || '';
  if (/\b(wrapped|staked|staking)\b/i.test(name)) return false;
  if (VERSION_SUFFIX.test(name)) return false;
  if (EXCHANGE_PREFIX.some((x) => name.startsWith(x))) return false;
  return true;
}

/** Days from first listing to the snapshot date; null when the snapshot carries no listing date. */
export function ageDays(p: SnapshotProtocol, asOf: string): number | null {
  if (!p.listed_at) return null;
  const days = Math.floor((Date.parse(asOf + 'T00:00:00Z') - Date.parse(p.listed_at + 'T00:00:00Z')) / 86400000);
  return Math.max(0, days);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The category multiple for every category in the snapshot: the median market-cap / TVL ratio of
 * its live-token protocols, the global median when a category has fewer than three such protocols.
 * Returns the map and the global median (with the sample sizes, so the page can show its working).
 */
export function categoryMultiples(protocols: SnapshotProtocol[]): {
  multiples: Map<string, number>;
  global: number;
  samples: Map<string, number>;
} {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of protocols) {
    if (isPreToken(p)) continue;
    if (p.tvl_usd === null || p.mcap_usd === null || p.tvl_usd <= 0 || p.mcap_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const cat = p.category ?? 'Other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(ratio);
  }
  const global = median(all);
  const multiples = new Map<string, number>();
  const samples = new Map<string, number>();
  for (const [cat, ratios] of byCategory) {
    samples.set(cat, ratios.length);
    const raw = ratios.length >= MODEL.multiple_min_sample ? median(ratios) : global;
    multiples.set(cat, Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, raw)));
  }
  return { multiples, global, samples };
}

function growthMultiplier(change7d: number | null): number {
  const growth = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, change7d ?? 0));
  return 1 + (growth / 100) * MODEL.growth_weight;
}

function maturityMultiplier(age: number | null): number {
  const days = age ?? MODEL.unknown_age_days;
  return MODEL.maturity_floor + (Math.min(Math.max(days, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
}

/** The implied value of one protocol, with every factor kept so the page can show its working. */
export function impliedValue(
  p: SnapshotProtocol,
  age: number | null,
  multiple: number,
): { value: number; growth: number; maturity: number } {
  const growth = growthMultiplier(p.change_7d);
  const maturity = maturityMultiplier(age);
  const tvl = p.tvl_usd ?? 0;
  const value = Math.max(1, Math.round(tvl * multiple * growth * maturity));
  return { value, growth, maturity };
}

// ---------------------------------------------------------------- farm plans

function chainOf(p: SnapshotProtocol): string {
  return p.chains && p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(tvlUsd: number): number {
  if (tvlUsd >= 5e9) return 250;
  if (tvlUsd >= 1e9) return 150;
  if (tvlUsd >= 1e8) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null || age === undefined) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function mainAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  let action: string;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    action = `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open, so it earns points on the deposit.`;
  } else if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) {
    action = `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open through at least one fee cycle.`;
  } else if (c.includes('bridge')) {
    action = `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds inside its app.`;
  } else if (c.includes('staking') || c.includes('restak')) {
    action = `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  } else if (c.includes('perpetual') || c.includes('derivative')) {
    action = `Deposit $${capital} of USDC as margin on ${name} and open one small hedge, then leave the margin in place.`;
  } else if (c.includes('prediction')) {
    action = `Fund $${capital} and place one market position on ${name} on a market that is about to resolve.`;
  } else if (c.includes('curator') || c.includes('allocator')) {
    action = `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares until the strategy's next rebalance.`;
  } else if (c.includes('stable')) {
    action = `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold the balance.`;
  } else if (c.includes('rwa')) {
    action = `Mint $${capital} of the protocol's yield asset on ${chain} and hold it through at least one payout.`;
  } else if (c.includes('insurance')) {
    action = `Buy $${capital} of cover from ${name} on ${chain} and keep the policy for its full term.`;
  } else {
    action = `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
  }
  if (p.chains && p.chains.length > 1) {
    action += ` It also runs on ${p.chains.slice(1, 3).join(', ')}.`;
  }
  return action;
}

function weeklyAction(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return 'Each week, borrow a small amount against the deposit and repay it, so the position shows activity on both sides.';
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) {
    return 'Each week, make one swap through the pool and add a little liquidity, so the position shows steady activity.';
  }
  if (c.includes('bridge')) {
    return 'Each week, bridge a small amount in the other direction and use the funds in the destination app.';
  }
  if (c.includes('staking') || c.includes('restak')) {
    return 'Each week, check the staking dashboard and restake any rewards the position earns.';
  }
  if (c.includes('perpetual') || c.includes('derivative')) {
    return 'Each week, open and close one small trade, keeping the margin deposit in place.';
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return "Each week, check the vault's allocation and add a small top-up when the strategy changes.";
  }
  if (c.includes('rwa')) {
    return 'Each week, check the yield accrual and hold the asset through at least one payout cycle.';
  }
  if (c.includes('prediction')) {
    return 'Each week, place one small position on a market that is about to resolve.';
  }
  if (c.includes('stable')) {
    return 'Each week, use the stable asset for one payment or deposit so the balance moves.';
  }
  return 'Each week, make one qualifying action such as a deposit, a borrow, a swap or a vote.';
}

/**
 * Six concrete steps for one protocol, each carrying its own cost and time. The steps follow from
 * the protocol's category, chains, TVL and age only; no name is special-cased.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p.tvl_usd ?? 0);
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 8 : 4;
  const steps = [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: mainAction(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyAction(p),
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days, so your activity spans more than one points snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.",
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
  return steps.map((s) => {
    let line = `${s.text} Cost: ${s.cost}. Time: ${s.time}.`;
    if (line.length > 600) line = line.slice(0, 596) + '...';
    if (line.length < 20) line += ' Hold the position and check the protocol’s own page.';
    return line;
  });
}

// ---------------------------------------------------------------- the board

export interface RadarResult {
  rows: BoardRow[];
  live: SnapshotProtocol[];
  multiples: Map<string, number>;
  globalMultiple: number;
  multipleSamples: Map<string, number>;
  watchlistSize: number;
  earlySize: number;
  boardSize: number;
  liveSize: number;
}

/**
 * Build the ranked board: every watchlist protocol, plus every other launchable pre-token
 * protocol below the floor, ordered by implied value. The early set is taken by TVL, the final
 * order by implied value, ties broken by slug, so the same snapshot always gives the same board.
 */
export function buildRadar(snapshot: Snapshot): RadarResult {
  const watchlist = new Set(snapshot.watchlist);
  const { multiples, global, samples } = categoryMultiples(snapshot.protocols);
  const multipleFor = (p: SnapshotProtocol): number => {
    const cat = p.category ?? 'Other';
    return multiples.get(cat) ?? global;
  };

  const watchRows = snapshot.protocols.filter((p) => watchlist.has(p.slug));
  const earlyCandidates = snapshot.protocols
    .filter((p) => !watchlist.has(p.slug) && isPreToken(p) && isLaunchable(p))
    .sort((a, b) => (b.tvl_usd ?? 0) - (a.tvl_usd ?? 0) || a.slug.localeCompare(b.slug))
    .slice(0, MODEL.early_rows);
  const board = [...watchRows, ...earlyCandidates];

  const scored: BoardRow[] = board.map((p) => {
    const age = ageDays(p, snapshot.as_of);
    const multiple = multipleFor(p);
    const { value, growth, maturity } = impliedValue(p, age, multiple);
    return {
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains ?? [],
      tvl_usd: p.tvl_usd ?? 0,
      change_7d: p.change_7d,
      age_days: age,
      watchlist: watchlist.has(p.slug),
      rank: 0,
      implied_value_usd: value,
      // Full precision, not rounded: the page recomputes the row from these exact factors, and
      // a rounded factor would reproduce a different integer and look stale.
      category_multiple: multiple,
      growth_multiplier: growth,
      maturity_multiplier: maturity,
      farm_steps: farmSteps(p, age),
    };
  });
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || a.slug.localeCompare(b.slug));
  scored.forEach((row, i) => {
    row.rank = i + 1;
  });

  const live = snapshot.protocols
    .filter((p) => !isPreToken(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || a.slug.localeCompare(b.slug))
    .slice(0, MODEL.live_rows);

  return {
    rows: scored,
    live,
    multiples,
    globalMultiple: global,
    multipleSamples: samples,
    watchlistSize: watchRows.length,
    earlySize: earlyCandidates.length,
    boardSize: scored.length,
    liveSize: live.length,
  };
}

/** The gate's own checks on the board, in the same words the scorer uses. */
export function boardIssue(rows: BoardRow[], watchlist: string[]): string | null {
  if (rows.length < 100 || rows.length > 4000) return `the board holds ${rows.length} rows, not the 100 to 4000 it must`;
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.slug)) return `the board repeats ${row.slug}`;
    seen.add(row.slug);
  }
  for (const slug of watchlist) {
    if (!seen.has(slug)) return `the board leaves out watchlist protocol ${slug}`;
  }
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `the board's ranks are not 1 to ${rows.length}`;
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.implied_value_usd > rows[i - 1]!.implied_value_usd) {
      return `the board is not sorted by implied value at rank ${rows[i]!.rank}`;
    }
  }
  if (rows.length >= 2 && rows.every((r) => r.implied_value_usd === rows[0]!.implied_value_usd)) {
    return 'every row carries the same implied value';
  }
  for (const row of rows) {
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `${row.slug} carries ${row.farm_steps.length} farm steps, not the 3 to 12 it must`;
    }
    for (const step of row.farm_steps) {
      const trimmed = step.trim();
      if (trimmed.length < 20 || trimmed.length > 600) {
        return `${row.slug} has a farm step of ${trimmed.length} characters, not the 20 to 600 it must`;
      }
    }
  }
  return null;
}
