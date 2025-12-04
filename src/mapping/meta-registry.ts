import {
  CommitNewAdmin,
  NewAdmin,
} from '../../generated/CurveMetaRegistry/MetaRegistry';
import { log } from '@graphprotocol/graph-ts';

export function handleCommitNewAdmin(event: CommitNewAdmin): void {
  log.info('handleCommitNewAdmin called at block {}', [
    event.block.number.toString(),
  ]);
}

export function handleNewAdmin(event: NewAdmin): void {
  log.info('handleNewAdmin called at block {}', [
    event.block.number.toString(),
  ]);
}
