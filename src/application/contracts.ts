import { createHash } from 'node:crypto';
import { Money, MoneyProps } from '../domain/value-objects/money';
import { TransactionKind } from '../domain/entities/wager-transaction';

export class ApplicationError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(code);
  }
}
export interface TransactionInput {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: TransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApplicationError('INVALID_PAYLOAD', 400);
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 255 ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new ApplicationError('INVALID_IDENTIFIER', 400);
  return value;
}
export function parseMoney(value: unknown): Money {
  const p = object(value);
  try {
    const m = Money.from({
      amount: p.amount as string,
      currency: p.currency as string,
    });
    if (m.toJSON().amount.split('.')[0].length > 16)
      throw new Error('AMOUNT_OUT_OF_RANGE');
    return m;
  } catch {
    throw new ApplicationError('INVALID_MONEY', 400);
  }
}
export function parseTransaction(value: unknown): TransactionInput {
  const p = object(value);
  const kind = p.kind as TransactionKind;
  if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(kind))
    throw new ApplicationError('INVALID_KIND', 400);
  const money = parseMoney(p.money);
  if (kind !== 'LOSS' && !money.isPositive())
    throw new ApplicationError('POSITIVE_AMOUNT_REQUIRED', 400);
  const reference =
    p.referenceExternalTransactionId === undefined
      ? undefined
      : identifier(p.referenceExternalTransactionId);
  if (['REFUND', 'ROLLBACK'].includes(kind) && !reference)
    throw new ApplicationError('REFERENCE_REQUIRED', 400);
  return {
    providerId: identifier(p.providerId),
    externalTransactionId: identifier(p.externalTransactionId),
    walletId: identifier(p.walletId),
    playerId: identifier(p.playerId),
    roundId: identifier(p.roundId),
    gameId: identifier(p.gameId),
    kind,
    money: money.toJSON(),
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  };
}
export function canonicalHash(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b, 'en'))
          .map(([k, x]) => [k, canonical(x)]),
      );
    return v;
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
