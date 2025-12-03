import {
  BigInt,
  BigDecimal,
  Address,
  ethereum,
  Bytes,
  log,
} from '@graphprotocol/graph-ts';
import { OracleRate, Pool, User } from '../generated/schema';
import { ERC20 } from '../generated/MisconfiguredPool/ERC20';
import { CurveStableSwap } from '../generated/MisconfiguredPool/CurveStableSwap';

/**
 * Emergency recovery flag: set true to force overwrite malformed Pool entity.
 * After Pool is corrected, set to false and redeploy.
 */
const FORCE_OVERWRITE: bool = true;

/**
 * Known addresses
 */
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
export const ZERO_ADDRESS = Address.fromString(
  '0x0000000000000000000000000000000000000000'
);

/**
 * Convert BigInt token amount to BigDecimal using token decimals
 */
export function toDecimal(amount: BigInt, decimals: i32): BigDecimal {
  let precision = exponentToBigDecimal(decimals);
  return amount.toBigDecimal().div(precision);
}

export function exponentToBigDecimal(decimals: i32): BigDecimal {
  let bd = BigDecimal.fromString('1');
  for (let i = 0; i < decimals; i++) {
    bd = bd.times(BigDecimal.fromString('10'));
  }
  return bd;
}

/**
 * Deterministic id for per-token rows
 * Use short stable id: txHash prefix + logIndex + tokenIndex to avoid huge strings
 */
export function makePerTokenId(
  txHash: string,
  logIndex: BigInt,
  tokenIndex: i32
): string {
  let prefix = txHash.length > 12 ? txHash.substr(0, 12) : txHash;
  return prefix + '-' + logIndex.toString() + '-' + tokenIndex.toString();
}

/**
 * Fetch token decimals with safe try
 */
export function fetchTokenDecimals(tokenAddr: Address): i32 {
  let erc20 = ERC20.bind(tokenAddr);
  let tryDecimals = erc20.try_decimals();
  if (tryDecimals.reverted) {
    return 18;
  }
  return tryDecimals.value;
}

/**
 * Persist OracleRate for token+block if not exists and return it
 */
export function getOrCreateOracleRate(
  tokenAddr: Address,
  block: ethereum.Block,
  rateToETH: BigDecimal,
  source: string
): OracleRate {
  let id = tokenAddr.toHexString() + '-' + block.number.toString();
  let existing = OracleRate.load(id);
  if (existing != null) {
    return existing as OracleRate;
  }

  let r = new OracleRate(id);
  let maybeTokenBytes = Bytes.fromHexString(tokenAddr.toHexString());
  if (maybeTokenBytes === null) {
    // Extremely unlikely for a valid Address, but guard anyway
    r.token = Bytes.fromHexString(ZERO_ADDRESS.toHexString()) as Bytes;
    log.warning(
      'getOrCreateOracleRate: Bytes.fromHexString returned null for token {}',
      [tokenAddr.toHexString()]
    );
  } else {
    r.token = maybeTokenBytes as Bytes;
  }
  r.blockNumber = block.number;
  r.blockTimestamp = block.timestamp;
  r.rateToETH = rateToETH;
  r.source = source;
  r.save();
  return r;
}

/**
 * Update user aggregates
 */
export function updateUserAggregates(
  userAddr: string,
  depositWETH: BigDecimal,
  withdrawWETH: BigDecimal,
  blockNumber: BigInt
): void {
  let user = User.load(userAddr);
  if (user == null) {
    user = new User(userAddr);
    user.totalDepositedWETH = BigDecimal.fromString('0');
    user.totalWithdrawnWETH = BigDecimal.fromString('0');
    user.netLossWETH = BigDecimal.fromString('0');
    user.lastUpdatedBlock = BigInt.fromI32(0);
  }
  if (depositWETH.gt(BigDecimal.fromString('0'))) {
    user.totalDepositedWETH = user.totalDepositedWETH.plus(depositWETH);
  }
  if (withdrawWETH.gt(BigDecimal.fromString('0'))) {
    user.totalWithdrawnWETH = user.totalWithdrawnWETH.plus(withdrawWETH);
  }
  user.netLossWETH = user.totalDepositedWETH.minus(user.totalWithdrawnWETH);
  user.lastUpdatedBlock = blockNumber;
  user.save();
}

/**
 * Safely read token address from Pool.tokens at index.
 * Returns zero address if not available or invalid.
 */
export function getTokenAddressFromPool(
  pool: Pool | null,
  tokenIndex: i32
): Address {
  if (pool === null) {
    return ZERO_ADDRESS;
  }

  if (pool.tokens === null) {
    return ZERO_ADDRESS;
  }

  if (tokenIndex < 0 || tokenIndex >= pool.tokens.length) {
    return ZERO_ADDRESS;
  }

  // Narrow nullable element before using
  let maybe = pool.tokens[tokenIndex];
  if (maybe === null) {
    log.warning('getTokenAddressFromPool: null token bytes for pool {}', [
      pool.id,
    ]);
    return ZERO_ADDRESS;
  }
  let b = maybe as Bytes;
  if (b.length !== 20) {
    log.warning(
      'getTokenAddressFromPool: invalid token bytes length={} for pool {}',
      [b.length.toString(), pool.id]
    );
    return ZERO_ADDRESS;
  }
  return Address.fromBytes(b);
}

/**
 * Try to read pool coins(i) for indices 0..maxIndex-1 and persist a Pool entity
 * with discovered token addresses. This function is defensive:
 * - validates bytes length before saving
 * - overwrites an existing Pool if it contains invalid entries or if FORCE_OVERWRITE is true
 *
 * Additional logging: logs up to first 4 token hex strings before saving so we can
 * identify malformed values that cause runtime errors.
 */
export function initPoolIfNeeded(
  poolAddr: Address,
  block: ethereum.Block,
  maxIndex: i32 = 8
): void {
  let poolId = poolAddr.toHexString();
  let existing = Pool.load(poolId);

  let binding = CurveStableSwap.bind(poolAddr);
  let discovered: Array<Address> = new Array<Address>();

  for (let i = 0; i < maxIndex; i++) {
    let idx = BigInt.fromI32(i);
    let tryCoin = binding.try_coins(idx);
    if (tryCoin.reverted) {
      break;
    }
    let coinAddr = tryCoin.value;
    if (coinAddr == ZERO_ADDRESS) {
      break;
    }
    discovered.push(coinAddr);
  }

  log.info('initPoolIfNeeded: discovered {} addresses for pool {}', [
    discovered.length.toString(),
    poolId,
  ]);

  // Convert discovered addresses to validated Bytes and hex strings
  let tokenBytes: Array<Bytes> = new Array<Bytes>();
  let tokenHexs: Array<string> = new Array<string>();
  for (let j = 0; j < discovered.length; j++) {
    let hex = discovered[j].toHexString();
    // Bytes.fromHexString returns Bytes | null
    let maybeB = Bytes.fromHexString(hex);
    if (maybeB === null) {
      log.warning(
        'initPoolIfNeeded: skipping null Bytes for pool {} index {}',
        [poolId, j.toString()]
      );
      continue;
    }
    let b = maybeB as Bytes;
    if (b.length === 20) {
      tokenBytes.push(b);
      tokenHexs.push(hex);
    } else {
      log.warning(
        'initPoolIfNeeded: skipping invalid token bytes length={} for pool {} index {}',
        [b.length.toString(), poolId, j.toString()]
      );
    }
  }

  if (tokenBytes.length === 0) {
    log.info('initPoolIfNeeded: no valid tokens discovered for pool {}', [
      poolId,
    ]);
    return;
  }

  // Decide whether to write/overwrite existing Pool
  let shouldWrite = FORCE_OVERWRITE;
  if (!shouldWrite) {
    if (existing === null) {
      shouldWrite = true;
    } else {
      // Validate existing tokens: if any are not 20 bytes or length mismatch, overwrite
      let existingInvalid = false;
      if (
        existing.tokens === null ||
        existing.tokens.length != tokenBytes.length
      ) {
        existingInvalid = true;
      } else {
        for (let k = 0; k < existing.tokens.length; k++) {
          let maybeEb = existing.tokens[k];
          if (maybeEb === null) {
            existingInvalid = true;
            break;
          }
          let eb = maybeEb as Bytes;
          if (eb.length != 20) {
            existingInvalid = true;
            break;
          }
        }
      }
      if (existingInvalid) {
        shouldWrite = true;
        log.info('initPoolIfNeeded: overwriting existing malformed Pool {}', [
          poolId,
        ]);
      }
    }
  } else {
    log.info('initPoolIfNeeded: FORCE_OVERWRITE enabled for pool {}', [poolId]);
  }

  if (!shouldWrite) {
    return;
  }

  // Persist Pool entity with validated bytes
  // Log a compact preview of token hexs (up to first 4) to help debugging malformed values
  let previewCount = tokenHexs.length < 4 ? tokenHexs.length : 4;
  let preview: string = '';
  for (let i = 0; i < previewCount; i++) {
    if (i > 0) {
      preview = preview + ',';
    }
    preview = preview + tokenHexs[i].substr(0, 18); // short prefix to avoid large allocations
  }
  log.info('initPoolIfNeeded: saving Pool {} tokens_count={} preview={}', [
    poolId,
    tokenBytes.length.toString(),
    preview,
  ]);

  let p = new Pool(poolId);

  // Null-safe lpToken assignment
  let maybeLp = Bytes.fromHexString(poolAddr.toHexString());
  if (maybeLp === null) {
    log.warning(
      'initPoolIfNeeded: Bytes.fromHexString returned null for pool address {}',
      [poolId]
    );
    p.lpToken = Bytes.fromHexString(ZERO_ADDRESS.toHexString()) as Bytes;
  } else {
    p.lpToken = maybeLp as Bytes;
  }

  p.tokens = tokenBytes;
  p.createdBlock = block.number;
  p.save();

  log.info('initPoolIfNeeded: saved Pool {} with {} tokens', [
    poolId,
    tokenBytes.length.toString(),
  ]);
}
