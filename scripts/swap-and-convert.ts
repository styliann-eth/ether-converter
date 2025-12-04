// scripts/swap-and-convert-with-manual-deposits.ts
// Reverted pipeline: only deposit(s) and withdrawal(s). Inject three manual deposit rows.
// Outputs: deposits_corrected.csv, withdrawals_corrected.csv, swap_audit.csv, user_aggregates.csv
// Or run directly with ts-node/esm:
//   node --loader ts-node/esm scripts/swap-and-convert.ts

import fs from 'fs';
import { Decimal } from 'decimal.js';

const GRAPHQL =
  process.env.GRAPHQL_ENDPOINT ??
  'https://api.studio.thegraph.com/query/40826/ether-converter/v0.0.11';
const PAGE = 1000;

// Addresses (lowercase)
const WETH = '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242'.toLowerCase();
const WEETH = '0xa3d68b74bf0528fdd07263c60d6488749044914b'.toLowerCase();
const WSTETH = '0x10aeaf63194db8d453d4d85a06e5efe1dd0b5417'.toLowerCase();
const LP_TOKEN =
  '0x5937e8aa8092eb2b18c40290a65d217e764bafaf2e6f5ddb594a692a9761b26f'.toLowerCase();

// Conversion rates
const CONVERSION_RATES: Record<string, string> = {
  [WEETH]: '1.0829400000000',
  [WSTETH]: '1.2208745075197',
  [WETH]: '1.00000',
};

type EventRow = {
  id?: string;
  provider?: string;
  token?: string;
  amountRaw?: string;
  amountWETH?: string;
  blockNumber?: string;
  transactionHash?: string;
};

async function gql<T = any>(
  query: string,
  vars: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: vars }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GraphQL request failed: ${res.status} ${res.statusText} - ${text}`
    );
  }
  const parsed = (await res.json()) as unknown;
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('Unexpected GraphQL response shape');
  const maybe = parsed as { errors?: unknown; data?: T };
  if (Array.isArray(maybe.errors) && maybe.errors.length > 0) {
    throw new Error(JSON.stringify(maybe.errors));
  }
  return (maybe.data ?? ({} as T)) as T;
}

// Generic pager for a single entity name
async function fetchAll(entity: string, fields: string): Promise<EventRow[]> {
  const out: EventRow[] = [];
  let skip = 0;
  while (true) {
    const q = `query($first:Int,$skip:Int){ ${entity}(first:$first, skip:$skip, orderBy:blockNumber, orderDirection:asc) { ${fields} } }`;
    const data = await gql<{ [k: string]: EventRow[] }>(q, {
      first: PAGE,
      skip,
    });
    const items = data?.[entity] || [];
    if (!items.length) break;
    out.push(...items);
    skip += items.length;
  }
  return out;
}

// Try singular/plural names and concatenate results
async function fetchAnyOf(
  candidates: string[],
  fields: string
): Promise<EventRow[]> {
  const out: EventRow[] = [];
  for (const name of candidates) {
    try {
      const items = await fetchAll(name, fields);
      if (items.length) {
        console.log(`Fetched ${items.length} rows for entity "${name}"`);
        out.push(...items);
      } else {
        console.log(`Entity "${name}" exists but returned 0 rows`);
      }
    } catch (err: any) {
      console.log(`Skipping entity "${name}": ${String(err).slice(0, 200)}`);
      continue;
    }
  }
  return out;
}

function safeLower(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase() : '';
}

function csvEscape(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function rawToBigDecimal(raw?: string): Decimal | null {
  if (!raw) return null;
  try {
    return new Decimal(raw);
  } catch {
    return null;
  }
}

function swapTokenDeterministic(tokenRaw: unknown): {
  tokenBefore: string;
  tokenAfter: string;
  swapped: boolean;
} {
  const token = safeLower(tokenRaw);
  if (!token) return { tokenBefore: '', tokenAfter: '', swapped: false };
  if (token === WETH)
    return { tokenBefore: token, tokenAfter: WEETH, swapped: true };
  if (token === WEETH)
    return { tokenBefore: token, tokenAfter: WETH, swapped: true };
  return { tokenBefore: token, tokenAfter: token, swapped: false };
}

function conversionRateForToken(tokenAfter: string): string {
  return CONVERSION_RATES[tokenAfter] ?? '1.00000';
}

function computeAmountWETHFromRaw(
  amountRaw?: string,
  conversionRateStr?: string
): Decimal | null {
  const rawBig = rawToBigDecimal(amountRaw);
  if (rawBig === null) return null;
  const conv = conversionRateStr
    ? new Decimal(conversionRateStr)
    : new Decimal('1');
  return rawBig.mul(conv).div(new Decimal(10).pow(18));
}

// Helper to create an injected deposit row
function makeManualDepositRow(params: {
  id: string;
  provider: string;
  token: string;
  amountDecimal: string;
  blockNumber: string;
  transactionHash: string;
}): EventRow {
  // amountDecimal is human amount (e.g., "4.99367")
  const raw = new Decimal(params.amountDecimal)
    .mul(new Decimal(10).pow(18))
    .toFixed(0);
  return {
    id: params.id,
    provider: params.provider.toLowerCase(),
    token: params.token.toLowerCase(),
    amountRaw: raw,
    amountWETH: undefined,
    blockNumber: params.blockNumber,
    transactionHash: params.transactionHash.toLowerCase(),
  };
}

async function main(): Promise<void> {
  console.log('GRAPHQL endpoint:', GRAPHQL);

  // Candidate names discovered earlier
  const depositCandidates = ['deposit', 'deposits'];
  const withdrawalCandidates = ['withdrawal', 'withdrawals'];
  const fields =
    'id provider token amountRaw amountWETH blockNumber transactionHash';

  // Fetch deposits and withdrawals (only these)
  console.log('Fetching deposit-like entities...');
  const deposits = await fetchAnyOf(depositCandidates, fields);
  console.log('Total deposit-like rows fetched:', deposits.length);

  console.log('Fetching withdrawal-like entities...');
  const withdrawals = await fetchAnyOf(withdrawalCandidates, fields);
  console.log('Total withdrawal-like rows fetched:', withdrawals.length);

  // Manual deposit injections (exact data you provided)
  const manualDeposits: EventRow[] = [
    makeManualDepositRow({
      id: 'manual-1',
      provider: '0x750e9a7b449904f47b793b805db469fa6e025e33',
      token: WETH, // 4.99367 WETH
      amountDecimal: '4.99367',
      blockNumber: '39496719',
      transactionHash:
        '0x48d878e4b6669c34ef333d84e9d714d3db06047e3eeefe89ba7614237a70d2df',
    }),
    makeManualDepositRow({
      id: 'manual-2',
      provider: '0x8d114f86f43c76e084ac9b82b073a744e3e55fdb',
      token: WEETH, // 0.705403 weETH
      amountDecimal: '0.705403',
      blockNumber: '39480009',
      transactionHash:
        '0x3eabc09680d2b1ffc2a0f4e26305d9cc54a1c4bbb85722cfc07fad3fd3c8898e',
    }),
    makeManualDepositRow({
      id: 'manual-3',
      provider: '0x50d4df2878e44f0d4ba02502f0a3646f9daf5d5f',
      token: WETH, // 0.088141282419113033 WETH
      amountDecimal: '0.088141282419113033',
      blockNumber: '39454993',
      transactionHash:
        '0xbce6b32891e033c64c6a59c9c150a199e166cd65a56ae8f043f783a763f640d3',
    }),
  ];

  // Append manual deposits to fetched deposits
  const allDeposits = deposits.concat(manualDeposits);
  console.log('Total deposits after manual injection:', allDeposits.length);

  type CorrectedRow = {
    original: EventRow;
    tokenAfter: string;
    swapped: boolean;
    amountWETHComputed: Decimal | null;
    conversionRate: string;
  };

  const correctedDeposits: CorrectedRow[] = [];
  const correctedWithdrawals: CorrectedRow[] = [];
  const auditLines: string[] = [];

  // Process deposits
  for (const r of allDeposits) {
    const { tokenBefore, tokenAfter, swapped } = swapTokenDeterministic(
      r.token
    );
    const convRate = conversionRateForToken(tokenAfter);
    const amountWETHComputed = computeAmountWETHFromRaw(r.amountRaw, convRate);
    correctedDeposits.push({
      original: r,
      tokenAfter,
      swapped,
      amountWETHComputed,
      conversionRate: convRate,
    });
    auditLines.push(
      [
        csvEscape(r.id ?? ''),
        csvEscape(safeLower(r.provider)),
        csvEscape(safeLower(r.transactionHash) || ''),
        csvEscape(tokenBefore),
        csvEscape(tokenAfter),
        csvEscape(r.amountRaw ?? ''),
        csvEscape(amountWETHComputed ? amountWETHComputed.toFixed() : ''),
        csvEscape(convRate),
        csvEscape(swapped ? 'swapped-token' : 'conversion-applied'),
      ].join(',')
    );
  }

  // Process withdrawals
  for (const r of withdrawals) {
    const { tokenBefore, tokenAfter, swapped } = swapTokenDeterministic(
      r.token
    );
    const convRate = conversionRateForToken(tokenAfter);
    const amountWETHComputed = computeAmountWETHFromRaw(r.amountRaw, convRate);
    correctedWithdrawals.push({
      original: r,
      tokenAfter,
      swapped,
      amountWETHComputed,
      conversionRate: convRate,
    });
    auditLines.push(
      [
        csvEscape(r.id ?? ''),
        csvEscape(safeLower(r.provider)),
        csvEscape(safeLower(r.transactionHash) || ''),
        csvEscape(tokenBefore),
        csvEscape(tokenAfter),
        csvEscape(r.amountRaw ?? ''),
        csvEscape(amountWETHComputed ? amountWETHComputed.toFixed() : ''),
        csvEscape(convRate),
        csvEscape(swapped ? 'swapped-token' : 'conversion-applied'),
      ].join(',')
    );
  }

  // Compute tx aggregates using corrected amountWETHComputed (sum non-LP rows per user|tx)
  function computeTxAggregates(corrected: CorrectedRow[]) {
    const map = new Map<string, Decimal>();
    for (const r of corrected) {
      const user = safeLower(r.original.provider);
      const tx = safeLower(r.original.transactionHash) || (r.original.id ?? '');
      const key = `${user}|${tx}`;
      const token = r.tokenAfter;
      const isLP = token === LP_TOKEN;
      if (!map.has(key)) map.set(key, new Decimal(0));
      if (r.amountWETHComputed !== null && !isLP) {
        map.set(key, map.get(key)!.plus(r.amountWETHComputed));
      }
    }
    return map;
  }

  const txAggDeposits = computeTxAggregates(correctedDeposits);
  const txAggWithdrawals = computeTxAggregates(correctedWithdrawals);

  // CSV headers
  const header = [
    'user',
    'transactionHash',
    'token',
    'isLP',
    'amountRaw',
    'amountWETH',
    'conversionRate',
    'txAggregatedWETH',
    'blockNumber',
    'id',
  ].join(',');

  const depositLines = [header];
  for (const r of correctedDeposits) {
    const user = safeLower(r.original.provider);
    const tx = safeLower(r.original.transactionHash) || (r.original.id ?? '');
    const token = r.tokenAfter;
    const isLP = token === LP_TOKEN ? 'true' : 'false';
    const amtRaw = r.original.amountRaw ?? '';
    const amtWETH = r.amountWETHComputed ? r.amountWETHComputed.toFixed() : '';
    const convRate = r.conversionRate;
    const txAgg = txAggDeposits.get(`${user}|${tx}`) ?? new Decimal(0);
    const block = r.original.blockNumber ?? '';
    const id = r.original.id ?? '';
    depositLines.push(
      [
        csvEscape(user),
        csvEscape(tx),
        csvEscape(token),
        csvEscape(isLP),
        csvEscape(amtRaw),
        csvEscape(amtWETH),
        csvEscape(convRate),
        csvEscape(txAgg.toFixed()),
        csvEscape(block),
        csvEscape(id),
      ].join(',')
    );
  }

  const withdrawalLines = [header];
  for (const r of correctedWithdrawals) {
    const user = safeLower(r.original.provider);
    const tx = safeLower(r.original.transactionHash) || (r.original.id ?? '');
    const token = r.tokenAfter;
    const isLP = token === LP_TOKEN ? 'true' : 'false';
    const amtRaw = r.original.amountRaw ?? '';
    const amtWETH = r.amountWETHComputed ? r.amountWETHComputed.toFixed() : '';
    const convRate = r.conversionRate;
    const txAgg = txAggWithdrawals.get(`${user}|${tx}`) ?? new Decimal(0);
    const block = r.original.blockNumber ?? '';
    const id = r.original.id ?? '';
    withdrawalLines.push(
      [
        csvEscape(user),
        csvEscape(tx),
        csvEscape(token),
        csvEscape(isLP),
        csvEscape(amtRaw),
        csvEscape(amtWETH),
        csvEscape(convRate),
        csvEscape(txAgg.toFixed()),
        csvEscape(block),
        csvEscape(id),
      ].join(',')
    );
  }

  fs.writeFileSync('deposits_corrected.csv', depositLines.join('\n'));
  console.log('Wrote deposits_corrected.csv rows:', depositLines.length - 1);

  fs.writeFileSync('withdrawals_corrected.csv', withdrawalLines.join('\n'));
  console.log(
    'Wrote withdrawals_corrected.csv rows:',
    withdrawalLines.length - 1
  );

  // Write audit CSV
  const auditHeader = [
    'id',
    'provider',
    'transactionHash',
    'tokenBefore',
    'tokenAfter',
    'amountRaw',
    'amountWETHAfter',
    'conversionRate',
    'reason',
  ].join(',');
  fs.writeFileSync('swap_audit.csv', [auditHeader, ...auditLines].join('\n'));
  console.log('Wrote swap_audit.csv rows:', auditLines.length);

  // Per-user aggregates using corrected amountWETHComputed
  const userMap = new Map<
    string,
    { deposits: Decimal; withdrawals: Decimal }
  >();
  for (const r of correctedDeposits) {
    const user = safeLower(r.original.provider);
    const v = r.amountWETHComputed ?? new Decimal(0);
    const cur = userMap.get(user) ?? {
      deposits: new Decimal(0),
      withdrawals: new Decimal(0),
    };
    cur.deposits = cur.deposits.plus(v);
    userMap.set(user, cur);
  }
  for (const r of correctedWithdrawals) {
    const user = safeLower(r.original.provider);
    const v = r.amountWETHComputed ?? new Decimal(0);
    const cur = userMap.get(user) ?? {
      deposits: new Decimal(0),
      withdrawals: new Decimal(0),
    };
    cur.withdrawals = cur.withdrawals.plus(v);
    userMap.set(user, cur);
  }

  const aggLines = ['user,totalDepositedWETH,totalWithdrawnWETH,remainingWETH'];
  for (const [user, vals] of userMap.entries()) {
    const remaining = vals.deposits.minus(vals.withdrawals);
    aggLines.push(
      [
        csvEscape(user),
        csvEscape(vals.deposits.toFixed()),
        csvEscape(vals.withdrawals.toFixed()),
        csvEscape(remaining.toFixed()),
      ].join(',')
    );
  }
  fs.writeFileSync('user_aggregates.csv', aggLines.join('\n'));
  console.log('Wrote user_aggregates.csv rows:', userMap.size);

  console.log(
    'Done. Manual deposits injected and pipeline reverted to deposit/withdrawal only.'
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
