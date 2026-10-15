import { describe, expect, it } from '@jest/globals';
import { Money } from './money';

describe('Money', () => {
  it('normalizes valid decimal amounts', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  it('adds money without floating-point errors', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });

    expect(a.add(b).toJSON().amount).toBe('0.30');
  });

  it('rejects different currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow('CURRENCY_MISMATCH');
  });

  it.each(['-10.00', '1.234', '1e3', 'NaN', 'Infinity', '', '01.00'])(
    'rejects invalid input: %s',
    (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
        'INVALID_MONEY_AMOUNT',
      );
    },
  );

  it('supports immutable subtraction', () => {
    const original = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    const result = original.subtract(
      Money.from({ amount: '80.00', currency: 'BRL' }),
    );

    expect(result.toJSON().amount).toBe('20.00');
    expect(original.toJSON().amount).toBe('100.00');
  });

  it('represents negative internal results', () => {
    const amount = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    expect(amount.negate().toJSON().amount).toBe('-10.00');
  });
});
