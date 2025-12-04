import {
  CommitNewAdmin,
  NewAdmin,
} from '../../generated/CurveMetaRegistry/MetaRegistry';
import { log } from '@graphprotocol/graph-ts';

/**
 * Minimal handlers for MetaRegistry events.
 * Keep these small and defensive; expand as you need to persist registry state.
 */

export function handleCommitNewAdmin(event: CommitNewAdmin): void {
  log.info('handleCommitNewAdmin called block={} tx={}', [
    event.block.number.toString(),
    event.transaction.hash.toHexString(),
  ]);
  // placeholder: implement registry state updates if needed
}

export function handleNewAdmin(event: NewAdmin): void {
  log.info('handleNewAdmin called block={} tx={}', [
    event.block.number.toString(),
    event.transaction.hash.toHexString(),
  ]);
  // placeholder: implement registry state updates if needed
}
