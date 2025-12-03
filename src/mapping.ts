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
  Transfer as TransferEvent,
} from '../generated/MisconfiguredPool/CurveStableSwap';

import { Deposit, Withdrawal, Pool } from '../generated/schema';

import { WeETH } from '../generated/MisconfiguredPool/WeETH';

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
} from './helpers';

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
    let w = WeETH.bind(tokenAddr);
    let tryDecimalConv = w.try_decimalConversionRate();
    if (!tryDecimalConv.reverted) {
      return toDecimal(tryDecimalConv.value, 18);
    }
    return BigDecimal.fromString('1');
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

  let pool = Pool.load(POOL_ADDRESS.toHexString());
  let amounts = event.params.token_amounts;

  for (let i = 0; i < amounts.length; i++) {
    let tokenIndex = i;
    let amountRaw = amounts[i];
    if (amountRaw.isZero()) {
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
  let amounts = event.params.token_amounts;

  for (let i = 0; i < amounts.length; i++) {
    let tokenIndex = i;
    let amountRaw = amounts[i];
    if (amountRaw.isZero()) {
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

  let tokenIndex = event.params.token_id.toI32();
  let amountRaw = event.params.token_amount;
  if (amountRaw.isZero()) {
    return;
  }

  let pool = Pool.load(POOL_ADDRESS.toHexString());
  let tokenAddr = getTokenAddressFromPool(pool, tokenIndex);
  if (
    tokenAddr ==
    Address.fromString('0x0000000000000000000000000000000000000000')
  ) {
    if (tokenIndex == 0) tokenAddr = WEETH_ADDRESS;
    if (tokenIndex == 1) tokenAddr = WSTETH_ADDRESS;
    if (tokenIndex == 2) tokenAddr = WETH_ADDRESS;
  }

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

  updateUserAggregates(
    providerStr,
    BigDecimal.fromString('0'),
    amountWETH,
    block.number
  );
}

export function handleTransfer(event: TransferEvent): void {
  // Minimal, defensive Transfer handler to avoid string allocation crashes.
  // Log only a short tx prefix and the block number.
  let txHashFull = event.transaction.hash.toHexString();
  let txPrefix = txHashFull.length > 12 ? txHashFull.substr(0, 12) : txHashFull;
  log.info('handleTransfer: txPrefix={} block={}', [
    txPrefix,
    event.block.number.toString(),
  ]);
}
