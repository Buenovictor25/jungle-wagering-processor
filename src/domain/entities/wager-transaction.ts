export type TransactionStatus =
  'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export type TransactionKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

export class WagerTransaction {
  private constructor(
    private state: TransactionStatus,
    private code?: string,
  ) {}
  static create(): WagerTransaction {
    return new WagerTransaction('PENDING');
  }
  static rehydrate(status: TransactionStatus, code?: string): WagerTransaction {
    return new WagerTransaction(status, code);
  }
  get status(): TransactionStatus {
    return this.state;
  }
  get failureCode(): string | undefined {
    return this.code;
  }
  isTerminal(): boolean {
    return ['PROCESSED', 'REJECTED', 'FAILED'].includes(this.state);
  }
  transition(status: TransactionStatus, code?: string): void {
    if (this.isTerminal() || status === 'PENDING')
      throw new Error('INVALID_TRANSACTION_STATE');
    if (['REJECTED', 'FAILED'].includes(status) && !code)
      throw new Error('FAILURE_CODE_REQUIRED');
    this.state = status;
    this.code = code;
  }
}
