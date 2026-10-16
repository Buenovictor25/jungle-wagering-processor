import { describe, expect, it } from '@jest/globals';
import { Money } from '../value-objects/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const createEntry = (
  overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {},
) =>
  WalletLedgerEntry.create({
    id: 'ledger-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    ...overrides,
  });

describe('WalletLedgerEntry', () => {
  it('creates a balanced debit entry', () => {
    const entry = createEntry();

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
  });

  it('creates a balanced credit entry', () => {
    const entry = createEntry({
      direction: LedgerDirection.Credit,
      balanceAfter: brl('125.00'),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toJSON().amount).toBe('125.00');
  });

  it('rejects an inconsistent debit calculation', () => {
    expect(() =>
      createEntry({
        balanceAfter: brl('80.00'),
      }),
    ).toThrow('UNBALANCED_LEDGER_ENTRY');
  });

  it('rejects an inconsistent credit calculation', () => {
    expect(() =>
      createEntry({
        direction: LedgerDirection.Credit,
        balanceAfter: brl('120.00'),
      }),
    ).toThrow('UNBALANCED_LEDGER_ENTRY');
  });

  it('rejects zero amount', () => {
    expect(() =>
      createEntry({
        money: brl('0.00'),
      }),
    ).toThrow('INVALID_LEDGER_AMOUNT');
  });

  it('rejects negative amount at Money creation', () => {
    expect(() => brl('-1.00')).toThrow('INVALID_MONEY_AMOUNT');
  });

  it('rejects currency mismatch', () => {
    expect(() =>
      createEntry({
        money: Money.from({
          amount: '25.00',
          currency: 'USD',
        }),
      }),
    ).toThrow('UNBALANCED_LEDGER_ENTRY');
  });

  it('rejects a debit exceeding the available balance', () => {
    expect(() =>
      createEntry({
        money: brl('150.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('0.00'),
      }),
    ).toThrow('UNBALANCED_LEDGER_ENTRY');
  });

  it('rejects missing identity', () => {
    expect(() =>
      createEntry({
        transactionId: '',
      }),
    ).toThrow('INVALID_LEDGER_IDENTITY');
  });

  it('rehydrates an existing entry', () => {
    const original = createEntry();

    const restored = WalletLedgerEntry.rehydrate({
      id: original.id,
      walletId: original.walletId,
      transactionId: original.transactionId,
      direction: original.direction,
      money: original.money,
      balanceBefore: original.balanceBefore,
      balanceAfter: original.balanceAfter,
      createdAt: original.createdAt,
    });

    expect(restored.isBalanced()).toBe(true);
    expect(restored.transactionId).toBe(original.transactionId);
  });
});
