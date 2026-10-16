import { WagerRules } from './wager-rules';
import { LedgerDirection } from './entities/wallet-ledger-entry';
import { Money } from './value-objects/money';
describe('Financial settlement rules', () => {
  const ref = {
    kind: 'BET',
    walletId: 'w',
    playerId: 'p',
    roundId: 'r',
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
  };
  it('BET debits; WIN and REFUND credit', () => {
    expect(WagerRules.direction('BET')).toBe(LedgerDirection.Debit);
    expect(WagerRules.direction('WIN')).toBe(LedgerDirection.Credit);
    expect(WagerRules.direction('REFUND', 'BET')).toBe(LedgerDirection.Credit);
  });
  it('ROLLBACK inverts BET, WIN and REFUND', () => {
    expect(WagerRules.direction('ROLLBACK', 'BET')).toBe(
      LedgerDirection.Credit,
    );
    expect(WagerRules.direction('ROLLBACK', 'WIN')).toBe(LedgerDirection.Debit);
    expect(WagerRules.direction('ROLLBACK', 'REFUND')).toBe(
      LedgerDirection.Debit,
    );
  });
  it('LOSS can reference BET but not WIN', () => {
    expect(
      WagerRules.referenceFailure({ ...ref, kind: 'LOSS' }, ref),
    ).toBeUndefined();
    expect(
      WagerRules.referenceFailure(
        { ...ref, kind: 'LOSS' },
        { ...ref, kind: 'WIN' },
      ),
    ).toBe('INVALID_REFERENCE_KIND');
  });
  it('REFUND requires full original BET value', () => {
    expect(
      WagerRules.referenceFailure({ ...ref, kind: 'REFUND' }, ref),
    ).toBeUndefined();
    expect(
      WagerRules.referenceFailure(
        {
          ...ref,
          kind: 'REFUND',
          money: Money.from({ amount: '24.99', currency: 'BRL' }),
        },
        ref,
      ),
    ).toBe('REVERSAL_AMOUNT_MISMATCH');
  });
  it('rejects cross wallet, player, round and currency references', () => {
    for (const change of [
      { walletId: 'other' },
      { playerId: 'other' },
      { roundId: 'other' },
      { money: Money.from({ amount: '25.00', currency: 'USD' }) },
    ])
      expect(
        WagerRules.referenceFailure({ ...ref, kind: 'REFUND', ...change }, ref),
      ).toBe('REFERENCE_MISMATCH');
  });
  it('ROLLBACK cannot reverse LOSS or another ROLLBACK', () => {
    for (const kind of ['LOSS', 'ROLLBACK'])
      expect(
        WagerRules.referenceFailure(
          { ...ref, kind: 'ROLLBACK' },
          { ...ref, kind },
        ),
      ).toBe('INVALID_REFERENCE_KIND');
  });
  it('distinguishes a spent win reversal from insufficient betting funds', () => {
    expect(WagerRules.insufficientFunds('BET')).toBe('INSUFFICIENT_FUNDS');
    expect(WagerRules.insufficientFunds('ROLLBACK')).toBe(
      'REVERSAL_INSUFFICIENT_FUNDS',
    );
  });
});
