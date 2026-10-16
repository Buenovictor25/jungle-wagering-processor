import { canonicalHash, parseMoney, parseTransaction } from './contracts';
import { WagerTransaction } from '../domain/entities/wager-transaction';
describe('Transaction contracts', () => {
  const input = {
    providerId: 'p',
    externalTransactionId: 'e',
    walletId: 'w',
    playerId: 'u',
    roundId: 'r',
    gameId: 'g',
    kind: 'BET',
    money: { amount: '1.00', currency: 'BRL' },
  };
  it('canonicalizes nested key ordering', () =>
    expect(canonicalHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalHash({ a: { c: 3, d: 4 }, b: 2 }),
    ));
  it('ignores transport metadata and normalizes money', () =>
    expect(
      canonicalHash(
        parseTransaction({
          ...input,
          money: { amount: '1', currency: 'BRL' },
          transport: 'ignored',
        }),
      ),
    ).toBe(canonicalHash(parseTransaction(input))));
  it('detects divergent business payload', () =>
    expect(
      canonicalHash(parseTransaction({ ...input, roundId: 'other' })),
    ).not.toBe(canonicalHash(parseTransaction(input))));
  it('rejects numeric money', () =>
    expect(() => parseMoney({ amount: 1, currency: 'BRL' })).toThrow());
  it('rejects amounts exceeding storage precision', () =>
    expect(() =>
      parseMoney({ amount: '10000000000000000.00', currency: 'BRL' }),
    ).toThrow());
  it('rejects external OPENING', () =>
    expect(() => parseTransaction({ ...input, kind: 'OPENING' })).toThrow());
  it('requires reversal reference', () =>
    expect(() => parseTransaction({ ...input, kind: 'ROLLBACK' })).toThrow());
  it('allows zero LOSS', () =>
    expect(
      parseTransaction({
        ...input,
        kind: 'LOSS',
        money: { amount: '0.00', currency: 'BRL' },
      }).kind,
    ).toBe('LOSS'));
  it('rejects zero BET', () =>
    expect(() =>
      parseTransaction({
        ...input,
        money: { amount: '0.00', currency: 'BRL' },
      }),
    ).toThrow());
  it('terminal states cannot transition', () => {
    for (const status of ['PROCESSED', 'REJECTED', 'FAILED'] as const) {
      const t = WagerTransaction.create();
      t.transition(status, 'reason');
      expect(() => t.transition('PROCESSED')).toThrow(
        'INVALID_TRANSACTION_STATE',
      );
    }
  });
  it('pending references can resolve or reject', () => {
    const t = WagerTransaction.create();
    t.transition('PENDING_REFERENCE');
    t.transition('PROCESSED');
    expect(t.isTerminal()).toBe(true);
  });
});
