import { describe, expect, it } from '@jest/globals';
import { Money } from '../value-objects/money';
import { Wallet } from './wallet';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const openWallet = (amount = '100.00'): Wallet =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(amount),
  });

describe('Wallet', () => {
  it('opens with version 1', () => {
    const wallet = openWallet();

    expect(wallet.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
  });

  it('debits and increments the version', () => {
    const wallet = openWallet();

    const movement = wallet.debit(brl('25.00'));

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(movement.direction).toBe('DEBIT');
    expect(movement.balanceBefore.toJSON().amount).toBe('100.00');
    expect(movement.balanceAfter.toJSON().amount).toBe('75.00');
  });

  it('credits and increments the version', () => {
    const wallet = openWallet();

    const movement = wallet.credit(brl('50.00'));

    expect(wallet.balance.toJSON().amount).toBe('150.00');
    expect(wallet.version).toBe(2);
    expect(movement.direction).toBe('CREDIT');
  });

  it('rejects insufficient funds without changing state', () => {
    const wallet = openWallet();

    expect(() => wallet.debit(brl('150.00'))).toThrow('INSUFFICIENT_FUNDS');

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('allows debiting the exact balance', () => {
    const wallet = openWallet();

    wallet.debit(brl('100.00'));

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  it('rejects different currencies', () => {
    const wallet = openWallet();
    const usd = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(() => wallet.credit(usd)).toThrow('CURRENCY_MISMATCH');
    expect(wallet.version).toBe(1);
  });

  it('rejects zero movements', () => {
    const wallet = openWallet();

    expect(() => wallet.debit(brl('0.00'))).toThrow('INVALID_MOVEMENT_AMOUNT');
    expect(() => wallet.credit(brl('0.00'))).toThrow('INVALID_MOVEMENT_AMOUNT');

    expect(wallet.version).toBe(1);
  });

  it('rejects negative movements', () => {
    const wallet = openWallet();

    expect(() => wallet.credit(brl('10.00').negate())).toThrow(
      'INVALID_MOVEMENT_AMOUNT',
    );
    expect(wallet.version).toBe(1);
  });

  it('rejects negative opening balances', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-2',
        playerId: 'player-2',
        initialBalance: brl('10.00').negate(),
      }),
    ).toThrow('NEGATIVE_INITIAL_BALANCE');
  });

  it('rehydrates persisted state without incrementing version', () => {
    const now = new Date('2026-10-15T12:00:00.000Z');

    const wallet = Wallet.rehydrate({
      id: 'wallet-3',
      playerId: 'player-3',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: now,
      updatedAt: now,
    });

    expect(wallet.balance.toJSON().amount).toBe('42.00');
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toEqual(now);
  });
});
