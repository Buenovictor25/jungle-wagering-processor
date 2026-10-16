import { LedgerDirection } from './entities/wallet-ledger-entry';
import { TransactionKind } from './entities/wager-transaction';
import { Money } from './value-objects/money';

export interface ReferenceContext {
  kind: string;
  walletId: string;
  playerId: string;
  roundId: string;
  money: Money;
}
export class WagerRules {
  private constructor() {}
  static direction(
    kind: TransactionKind,
    referenceKind?: string,
  ): LedgerDirection {
    return kind === 'BET' || (kind === 'ROLLBACK' && referenceKind !== 'BET')
      ? LedgerDirection.Debit
      : LedgerDirection.Credit;
  }
  static referenceFailure(
    operation: ReferenceContext,
    reference: ReferenceContext,
  ): string | undefined {
    if (
      operation.walletId !== reference.walletId ||
      operation.playerId !== reference.playerId ||
      operation.roundId !== reference.roundId ||
      operation.money.currency !== reference.money.currency
    )
      return 'REFERENCE_MISMATCH';
    if (
      ['REFUND', 'WIN', 'LOSS'].includes(operation.kind) &&
      reference.kind !== 'BET'
    )
      return 'INVALID_REFERENCE_KIND';
    if (
      operation.kind === 'ROLLBACK' &&
      !['BET', 'WIN', 'REFUND'].includes(reference.kind)
    )
      return 'INVALID_REFERENCE_KIND';
    if (
      ['REFUND', 'ROLLBACK'].includes(operation.kind) &&
      !operation.money.equals(reference.money)
    )
      return 'REVERSAL_AMOUNT_MISMATCH';
  }
  static insufficientFunds(kind: TransactionKind): string {
    return kind === 'BET'
      ? 'INSUFFICIENT_FUNDS'
      : 'REVERSAL_INSUFFICIENT_FUNDS';
  }
}
