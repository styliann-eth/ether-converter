import {
  Address,
  BigInt,
  BigDecimal,
  ethereum,
  log,
} from '@graphprotocol/graph-ts';

import {
  AddLiquidity as AddLiquidityEvent,
  RemoveLiquidity as RemoveLiquidityEvent,
  RemoveLiquidityOne as RemoveLiquidityOneEvent,
} from '../../generated/MisconfiguredPool/CurveStableSwap';

import { Deposit, Withdrawal, Pool } from '../../generated/schema';

import {
  POOL_ADDRESS,
  WETH_ADDRESS,
  WEETH_ADDRESS,
  WSTETH_ADDRESS,
  toDecimal,
  fetchTokenDecimals,
  makePerTokenId,
  getOrCreateOracleRate,
  updateUserAggregates,
  initPoolIfNeeded,
  getTokenAddressFromPool,
} from '../helpers';

/**
 * fetchRedemptionRate
 */
function fetchRedemptionRate(
  tokenAddr: Address,
  block: ethereum.Block
): BigDecimal {
  if (tokenAddr == WETH_ADDRESS) {
    return BigDecimal.fromString('1');
  }

  if (tokenAddr == WEETH_ADDRESS) {
    return BigDecimal.fromString('1.0829400000000');
  }

  if (tokenAddr == WSTETH_ADDRESS) {
    return BigDecimal.fromString('1.2208745075197');
  }

  return BigDecimal.fromString('1');
}

/*
  Handlers
  - Defensive: minimal logs, truncated tx prefixes, validated bytes before conversions.
*/

export function handleAddLiquidity(event: AddLiquidityEvent): void {
  initPoolIfNeeded(POOL_ADDRESS, event.block);

  // Minimal log: tx prefix + block
  let txHash = event.transaction.hash.toHexString();
  let txPrefix = txHash.length > 12 ? txHash.substr(0, 12) : txHash;
  log.info('handleAddLiquidity: txPrefix={} block={}', [
    txPrefix,
    event.block.number.toString(),
  ]);

  let logIndex = event.logIndex;
  let providerStr = event.params.provider.toHexString();
  let block = event.block;

  // Defensive pool load / creation check
  let pool = Pool.load(POOL_ADDRESS.toHexString());
  if (pool == null) {
    log.info('Pool missing after initPoolIfNeeded at block {}', [
      event.block.number.toString(),
    ]);
    initPoolIfNeeded(POOL_ADDRESS, event.block);
    pool = Pool.load(POOL_ADDRESS.toHexString());
    if (pool == null) {
      log.error(
        'initPoolIfNeeded failed to create Pool; aborting handler for tx {}',
        [event.transaction.hash.toHexString()]
      );
      return;
    } else {
      log.info('Pool created by initPoolIfNeeded at block {}', [
        event.block.number.toString(),
      ]);
    }
  } else {
    log.info('Pool loaded successfully at block {}', [
      event.block.number.toString(),
    ]);
  }

  let amounts = event.params.token_amounts;
  log.info('handleAddLiquidity: tx={} block={} amounts_len={}', [
    event.transaction.hash.toHexString(),
    event.block.number.toString(),
    amounts.length.toString(),
  ]);

  for (let i = 0; i < amounts.length; i++) {
    let tokenIndex = i;
    let amountRaw = amounts[i];
    if (amountRaw.isZero()) {
      log.info('handleAddLiquidity: skipping zero amount index={} tx={}', [
        i.toString(),
        event.transaction.hash.toHexString(),
      ]);
      continue;
    }

    // Determine token address from Pool.tokens if available (safe)
    let tokenAddr = getTokenAddressFromPool(pool, tokenIndex);
    // If helper returned zero address, fall back to previous mapping
    if (
      tokenAddr ==
      Address.fromString('0x0000000000000000000000000000000000000000')
    ) {
      if (tokenIndex == 0) tokenAddr = WEETH_ADDRESS;
      if (tokenIndex == 1) tokenAddr = WSTETH_ADDRESS;
      if (tokenIndex == 2) tokenAddr = WETH_ADDRESS;
    }

    log.info('handleAddLiquidity: resolved tokenAddr index={} addr={} tx={}', [
      tokenIndex.toString(),
      tokenAddr.toHexString(),
      event.transaction.hash.toHexString(),
    ]);

    let decimals = fetchTokenDecimals(tokenAddr);
    let amountDecimal = toDecimal(amountRaw, decimals);

    let rate = fetchRedemptionRate(tokenAddr, block);
    let oracle = getOrCreateOracleRate(tokenAddr, block, rate, 'wrapper-call');

    let amountWETH = amountDecimal.times(oracle.rateToETH);

    // Use short id to avoid long allocations
    let id = makePerTokenId(txHash, logIndex, tokenIndex);
    let d = new Deposit(id);
    d.provider = Address.fromString(providerStr);
    d.pool = POOL_ADDRESS.toHexString();
    d.token = tokenAddr;
    d.tokenIndex = tokenIndex;
    d.amountRaw = amountRaw;
    d.amountWETH = amountWETH;
    d.rateToETHId = oracle.id;
    d.blockNumber = block.number;
    d.blockTimestamp = block.timestamp;
    d.transactionHash = event.transaction.hash;
    d.save();

    // CONFIRMATION LOG
    log.info(
      'saved Deposit id={} provider={} tokenIndex={} amountRaw={} tx={}',
      [
        id,
        providerStr,
        tokenIndex.toString(),
        amountRaw.toString(),
        event.transaction.hash.toHexString(),
      ]
    );

    updateUserAggregates(
      providerStr,
      amountWETH,
      BigDecimal.fromString('0'),
      block.number
    );
  }
}

export function handleRemoveLiquidity(event: RemoveLiquidityEvent): void {
  initPoolIfNeeded(POOL_ADDRESS, event.block);

  let txHash = event.transaction.hash.toHexString();
  let txPrefix = txHash.length > 12 ? txHash.substr(0, 12) : txHash;
  log.info('handleRemoveLiquidity: txPrefix={} block={}', [
    txPrefix,
    event.block.number.toString(),
  ]);

  let logIndex = event.logIndex;
  let providerStr = event.params.provider.toHexString();
  let block = event.block;

  let pool = Pool.load(POOL_ADDRESS.toHexString());
  if (pool == null) {
    log.info('Pool missing after initPoolIfNeeded at block {}', [
      event.block.number.toString(),
    ]);
    initPoolIfNeeded(POOL_ADDRESS, event.block);
    pool = Pool.load(POOL_ADDRESS.toHexString());
    if (pool == null) {
      log.error(
        'initPoolIfNeeded failed to create Pool; aborting handler for tx {}',
        [event.transaction.hash.toHexString()]
      );
      return;
    } else {
      log.info('Pool created by initPoolIfNeeded at block {}', [
        event.block.number.toString(),
      ]);
    }
  } else {
    log.info('Pool loaded successfully at block {}', [
      event.block.number.toString(),
    ]);
  }

  let amounts = event.params.token_amounts;
  log.info('handleRemoveLiquidity: tx={} block={} amounts_len={}', [
    event.transaction.hash.toHexString(),
    event.block.number.toString(),
    amounts.length.toString(),
  ]);

  for (let i = 0; i < amounts.length; i++) {
    let tokenIndex = i;
    let amountRaw = amounts[i];
    if (amountRaw.isZero()) {
      log.info('handleRemoveLiquidity: skipping zero amount index={} tx={}', [
        i.toString(),
        event.transaction.hash.toHexString(),
      ]);
      continue;
    }

    let tokenAddr = getTokenAddressFromPool(pool, tokenIndex);
    if (
      tokenAddr ==
      Address.fromString('0x0000000000000000000000000000000000000000')
    ) {
      if (tokenIndex == 0) tokenAddr = WEETH_ADDRESS;
      if (tokenIndex == 1) tokenAddr = WSTETH_ADDRESS;
      if (tokenIndex == 2) tokenAddr = WETH_ADDRESS;
    }

    log.info(
      'handleRemoveLiquidity: resolved tokenAddr index={} addr={} tx={}',
      [
        tokenIndex.toString(),
        tokenAddr.toHexString(),
        event.transaction.hash.toHexString(),
      ]
    );

    let decimals = fetchTokenDecimals(tokenAddr);
    let amountDecimal = toDecimal(amountRaw, decimals);

    let rate = fetchRedemptionRate(tokenAddr, block);
    let oracle = getOrCreateOracleRate(tokenAddr, block, rate, 'wrapper-call');

    let amountWETH = amountDecimal.times(oracle.rateToETH);

    let id = makePerTokenId(txHash, logIndex, tokenIndex);
    let w = new Withdrawal(id);
    w.provider = Address.fromString(providerStr);
    w.pool = POOL_ADDRESS.toHexString();
    w.token = tokenAddr;
    w.tokenIndex = tokenIndex;
    w.amountRaw = amountRaw;
    w.amountWETH = amountWETH;
    w.rateToETHId = oracle.id;
    w.blockNumber = block.number;
    w.blockTimestamp = block.timestamp;
    w.transactionHash = event.transaction.hash;
    w.save();

    log.info(
      'saved Withdrawal id={} provider={} tokenIndex={} amountRaw={} tx={}',
      [
        id,
        providerStr,
        tokenIndex.toString(),
        amountRaw.toString(),
        event.transaction.hash.toHexString(),
      ]
    );

    updateUserAggregates(
      providerStr,
      BigDecimal.fromString('0'),
      amountWETH,
      block.number
    );
  }
}

export function handleRemoveLiquidityOne(event: RemoveLiquidityOneEvent): void {
  initPoolIfNeeded(POOL_ADDRESS, event.block);

  let txHash = event.transaction.hash.toHexString();
  let txPrefix = txHash.length > 12 ? txHash.substr(0, 12) : txHash;
  log.info('handleRemoveLiquidityOne: txPrefix={} block={}', [
    txPrefix,
    event.block.number.toString(),
  ]);

  let logIndex = event.logIndex;
  let providerStr = event.params.provider.toHexString();
  let block = event.block;

  let pool = Pool.load(POOL_ADDRESS.toHexString());
  if (pool == null) {
    log.info('Pool missing after initPoolIfNeeded at block {}', [
      event.block.number.toString(),
    ]);
    initPoolIfNeeded(POOL_ADDRESS, event.block);
    pool = Pool.load(POOL_ADDRESS.toHexString());
    if (pool == null) {
      log.error(
        'initPoolIfNeeded failed to create Pool; aborting handler for tx {}',
        [event.transaction.hash.toHexString()]
      );
      return;
    } else {
      log.info('Pool created by initPoolIfNeeded at block {}', [
        event.block.number.toString(),
      ]);
    }
  } else {
    log.info('Pool loaded successfully at block {}', [
      event.block.number.toString(),
    ]);
  }

  let tokenIndex = event.params.token_id.toI32();
  let amountRaw = event.params.token_amount;
  if (amountRaw.isZero()) {
    log.info('handleRemoveLiquidityOne: zero amount tokenIndex={} tx={}', [
      tokenIndex.toString(),
      event.transaction.hash.toHexString(),
    ]);
    return;
  }

  let tokenAddr = getTokenAddressFromPool(pool, tokenIndex);
  if (
    tokenAddr ==
    Address.fromString('0x0000000000000000000000000000000000000000')
  ) {
    if (tokenIndex == 0) tokenAddr = WEETH_ADDRESS;
    if (tokenIndex == 1) tokenAddr = WSTETH_ADDRESS;
    if (tokenIndex == 2) tokenAddr = WETH_ADDRESS;
  }

  log.info(
    'handleRemoveLiquidityOne: resolved tokenAddr index={} addr={} tx={}',
    [
      tokenIndex.toString(),
      tokenAddr.toHexString(),
      event.transaction.hash.toHexString(),
    ]
  );

  let decimals = fetchTokenDecimals(tokenAddr);
  let amountDecimal = toDecimal(amountRaw, decimals);

  let rate = fetchRedemptionRate(tokenAddr, block);
  let oracle = getOrCreateOracleRate(tokenAddr, block, rate, 'wrapper-call');

  let amountWETH = amountDecimal.times(oracle.rateToETH);

  let id = makePerTokenId(txHash, logIndex, tokenIndex);
  let w = new Withdrawal(id);
  w.provider = Address.fromString(providerStr);
  w.pool = POOL_ADDRESS.toHexString();
  w.token = tokenAddr;
  w.tokenIndex = tokenIndex;
  w.amountRaw = amountRaw;
  w.amountWETH = amountWETH;
  w.rateToETHId = oracle.id;
  w.blockNumber = block.number;
  w.blockTimestamp = block.timestamp;
  w.transactionHash = event.transaction.hash;
  w.save();

  log.info(
    'saved Withdrawal (one) id={} provider={} tokenIndex={} amountRaw={} tx={}',
    [
      id,
      providerStr,
      tokenIndex.toString(),
      amountRaw.toString(),
      event.transaction.hash.toHexString(),
    ]
  );

  updateUserAggregates(
    providerStr,
    BigDecimal.fromString('0'),
    amountWETH,
    block.number
  );
}
