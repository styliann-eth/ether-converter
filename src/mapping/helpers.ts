import {
  Address,
  BigInt,
  BigDecimal,
  Bytes,
  ethereum,
  log,
} from '@graphprotocol/graph-ts';
import { OracleRate, Pool, User } from '../../generated/schema';

/** Replace these with your real addresses */
export const POOL_ADDRESS = Address.fromString(
  '0x2fD13b49F970e8C6D89283056C1c6281214b7EB6'
);
export const WETH_ADDRESS = Address.fromString(
  '0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242'
);
export const WEETH_ADDRESS = Address.fromString(
  '0xA3D68b74bF0528fdD07263c60d6488749044914b'
);
export const WSTETH_ADDRESS = Address.fromString(
  '0x10Aeaf63194db8d453d4D85a06E5eFE1dd0b5417'
);

/** Convert BigInt to BigDecimal using decimals */
export function toDecimal(value: BigInt, decimals: i32): BigDecimal {
  if (decimals <= 0) {
    return value.toBigDecimal();
  }
  let scale = BigInt.fromI32(10)
    .pow(<u8>decimals)
    .toBigDecimal();
  return value.toBigDecimal().div(scale);
}

/** Minimal token decimals cache (stub) */
const DECIMALS_CACHE = new Map<string, i32>();

export function fetchTokenDecimals(token: Address): i32 {
  let key = token.toHexString();
  if (DECIMALS_CACHE.has(key)) {
    return DECIMALS_CACHE.get(key) as i32;
  }
  // Default to 18 if unknown. Replace with on-chain call if needed.
  let d = 18;
  DECIMALS_CACHE.set(key, d);
  return d;
}

/** Make a per-token id: txPrefix-logIndex-tokenIndex */
export function makePerTokenId(
  txHash: string,
  logIndex: BigInt,
  tokenIndex: i32
): string {
  return txHash + '-' + logIndex.toString() + '-' + tokenIndex.toString();
}

/** Minimal oracle rate creation/lookup */
export function getOrCreateOracleRate(
  token: Address,
  block: ethereum.Block,
  rate: BigDecimal,
  source: string
): OracleRate {
  let id = token.toHexString() + '-' + block.number.toString();
  let r = OracleRate.load(id);
  if (r == null) {
    r = new OracleRate(id);
    r.token = token;
    r.blockNumber = block.number;
    r.blockTimestamp = block.timestamp;
    r.rateToETH = rate;
    r.source = source;
    r.save();
  }
  return r as OracleRate;
}

/** Update per-user aggregates (very small, defensive) */
export function updateUserAggregates(
  userId: string,
  depositWETH: BigDecimal,
  withdrawWETH: BigDecimal,
  blockNumber: BigInt
): void {
  let u = User.load(userId);
  if (u == null) {
    u = new User(userId);
    u.totalDepositedWETH = BigDecimal.fromString('0');
    u.totalWithdrawnWETH = BigDecimal.fromString('0');
    u.netLossWETH = BigDecimal.fromString('0');
  }
  u.totalDepositedWETH = u.totalDepositedWETH.plus(depositWETH);
  u.totalWithdrawnWETH = u.totalWithdrawnWETH.plus(withdrawWETH);
  // netLossWETH = withdrawn - deposited (or whatever your logic is)
  u.netLossWETH = u.totalWithdrawnWETH.minus(u.totalDepositedWETH);
  u.lastUpdatedBlock = blockNumber;
  u.save();
}

/** Ensure Pool entity exists with minimal fields */
export function initPoolIfNeeded(
  poolAddr: Address,
  block: ethereum.Block
): void {
  let id = poolAddr.toHexString();
  let p = Pool.load(id);
  if (p == null) {
    p = new Pool(id);
    p.lpToken = Bytes.fromHexString(
      '0x0000000000000000000000000000000000000000'
    ) as Bytes;
    // default tokens array: empty array; mapping expects tokens to be present if available
    p.tokens = new Array<Bytes>(0);
    p.createdBlock = block.number;
    p.save();
    log.info('initPoolIfNeeded: created minimal Pool id={} block={}', [
      id,
      block.number.toString(),
    ]);
  }
}

/**
 * Resolve token address from Pool.tokens safely.
 * Returns zero address if not available.
 */
export function getTokenAddressFromPool(
  pool: Pool | null,
  index: i32
): Address {
  const ZERO = '0x0000000000000000000000000000000000000000';

  if (pool == null) {
    return Address.fromString(ZERO);
  }

  let tokens = pool.tokens;
  if (tokens == null) {
    return Address.fromString(ZERO);
  }

  // Guard by bounds first so the compiler knows tokens[index] is valid
  if (index < 0 || index >= tokens.length) {
    return Address.fromString(ZERO);
  }

  // Cast the element to Bytes (non-null) and convert to Address
  let bytesValue = tokens[index] as Bytes;
  return Address.fromBytes(bytesValue);
}
