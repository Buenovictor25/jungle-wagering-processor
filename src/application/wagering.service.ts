import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Money, MoneyProps } from '../domain/value-objects/money';
import { Wallet } from '../domain/entities/wallet';
import { WagerRules } from '../domain/wager-rules';
import { InboxMessage } from '../domain/entities/message';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../domain/entities/wallet-ledger-entry';
import {
  TransactionStatus,
  WagerTransaction,
} from '../domain/entities/wager-transaction';
import {
  IntegrationEvent,
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events';
import {
  ApplicationError,
  canonicalHash,
  identifier,
  object,
  parseMoney,
  parseTransaction,
  TransactionInput,
} from './contracts';

export interface Result {
  transactionId: string;
  status: TransactionStatus;
  balance: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}
interface TransactionRow {
  id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  payload: TransactionInput;
  status: TransactionStatus;
  kind: string;
  result: Result;
  attempts: number;
  reference_id?: string;
}
interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}
export function query<T extends object>(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return em.execute<T[]>(sql, params);
}

@Injectable()
export class WageringService {
  constructor(private readonly orm: MikroORM) {}
  private transaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(async (em) => {
      await em.execute(`SET LOCAL lock_timeout = '5s'`);
      await em.execute(`SET LOCAL statement_timeout = '10s'`);
      return work(em);
    });
  }
  async createWallet(value: unknown) {
    const p = object(value);
    const playerId = identifier(p.playerId);
    const money = parseMoney(p.initialBalance);
    return this.transaction(async (em) => {
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId,
        initialBalance: money,
      });
      await em.execute(
        'INSERT INTO wallets(id,player_id,currency,balance,version,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
        [
          wallet.id,
          playerId,
          money.currency,
          money.toJSON().amount,
          wallet.createdAt,
          wallet.updatedAt,
        ],
      );
      if (money.isPositive()) {
        const id = randomUUID();
        const payload = {
          providerId: 'internal',
          externalTransactionId: id,
          walletId: wallet.id,
          playerId,
          roundId: 'opening',
          gameId: 'internal',
          kind: 'OPENING',
          money: money.toJSON(),
        };
        const result = {
          transactionId: id,
          status: 'PROCESSED',
          balance: money.toJSON(),
          idempotentReplay: false,
        };
        await em.execute(
          `INSERT INTO wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,payload,kind,status,result,processed_at) VALUES (?,?,?,?,?,?,?::jsonb,'OPENING','PROCESSED',?::jsonb,now())`,
          [
            id,
            'internal',
            id,
            `internal:${id}`,
            canonicalHash(payload),
            wallet.id,
            JSON.stringify(payload),
            JSON.stringify(result),
          ],
        );
        await this.ledger(
          em,
          wallet,
          id,
          LedgerDirection.Credit,
          money,
          Money.zero(money.currency),
        );
        await this.event(
          em,
          WagerTransactionProcessed.create({
            eventId: randomUUID(),
            aggregateId: wallet.id,
            correlationId: id,
            occurredAt: new Date(),
            data: result,
          }),
        );
      }
      return {
        id: wallet.id,
        playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
  async submit(
    value: unknown,
    key: unknown,
    messageId?: string,
  ): Promise<Result> {
    const p = parseTransaction(value);
    const idempotencyKey = identifier(key);
    const hash = canonicalHash(p);
    return this.transaction(async (em) => {
      // Lock the wallet before any transaction row: all paths use the same order.
      const wallet = await this.lockWallet(em, p.walletId);
      let [row] = await query<TransactionRow>(
        em,
        'SELECT * FROM wager_transactions WHERE idempotency_key=? OR (provider_id=? AND external_transaction_id=?)',
        [idempotencyKey, p.providerId, p.externalTransactionId],
      );
      if (row) {
        if (row.payload_hash !== hash || row.idempotency_key !== idempotencyKey)
          throw new ApplicationError('IDEMPOTENCY_CONFLICT', 409);
        await this.inbox(em, messageId, hash, row.id);
        return { ...row.result, idempotentReplay: true };
      }
      const id = randomUUID();
      // ON CONFLICT also handles keys racing across different wallets.
      const inserted = await query<{ id: string }>(
        em,
        `INSERT INTO wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,payload,kind,status) VALUES (?,?,?,?,?,?,?::jsonb,?,'PENDING') ON CONFLICT DO NOTHING RETURNING id`,
        [
          id,
          p.providerId,
          p.externalTransactionId,
          idempotencyKey,
          hash,
          p.walletId,
          JSON.stringify(p),
          p.kind,
        ],
      );
      if (!inserted.length)
        throw new ApplicationError('IDEMPOTENCY_CONFLICT', 409);
      [row] = await query<TransactionRow>(
        em,
        'SELECT * FROM wager_transactions WHERE id=?',
        [id],
      );
      const result = await this.apply(em, row, wallet);
      await this.inbox(em, messageId, hash, id);
      return result;
    });
  }
  private async inbox(
    em: EntityManager,
    messageId: string | undefined,
    hash: string,
    id: string,
  ) {
    if (!messageId) return;
    const inbox = InboxMessage.receive(identifier(messageId), 'wagering', hash);
    inbox.markProcessed(new Date());
    await em.execute(
      `INSERT INTO inbox(consumer_name,message_id,payload_hash,transaction_id,received_at,processed_at) VALUES ('wagering',?,?,?,?,?) ON CONFLICT DO NOTHING`,
      [
        inbox.messageId,
        inbox.payloadHash,
        id,
        inbox.receivedAt,
        inbox.processedAt,
      ],
    );
    const [existing] = await query<{
      payload_hash: string;
      transaction_id: string;
    }>(
      em,
      `SELECT payload_hash,transaction_id FROM inbox WHERE consumer_name='wagering' AND message_id=?`,
      [messageId],
    );
    if (existing.payload_hash !== hash || existing.transaction_id !== id)
      throw new ApplicationError('INBOX_CONFLICT', 409);
  }
  private async lockWallet(em: EntityManager, id: string): Promise<Wallet> {
    const [row] = await query<WalletRow>(
      em,
      'SELECT * FROM wallets WHERE id=? FOR UPDATE',
      [id],
    );
    if (!row) throw new ApplicationError('WALLET_NOT_FOUND', 404);
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      currency: row.currency,
      balance: Money.from({ amount: row.balance, currency: row.currency }),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  private async apply(
    em: EntityManager,
    row: TransactionRow,
    wallet: Wallet,
  ): Promise<Result> {
    const p = row.payload;
    const money = Money.from(p.money);
    const tx = WagerTransaction.rehydrate(row.status);
    let failure: string | undefined;
    let reference: TransactionRow | undefined;
    let waiting = false;
    let direction = WagerRules.direction(p.kind);
    if (p.playerId !== wallet.playerId) failure = 'PLAYER_MISMATCH';
    else if (money.currency !== wallet.currency) failure = 'CURRENCY_MISMATCH';
    if (!failure && p.referenceExternalTransactionId) {
      [reference] = await query<TransactionRow>(
        em,
        'SELECT * FROM wager_transactions WHERE provider_id=? AND external_transaction_id=?',
        [p.providerId, p.referenceExternalTransactionId],
      );
      if (p.referenceExternalTransactionId === p.externalTransactionId)
        failure = 'INVALID_REFERENCE';
      else if (
        !reference ||
        ['PENDING', 'PENDING_REFERENCE'].includes(reference.status)
      ) {
        if (row.attempts >= 8) failure = 'REFERENCE_NOT_FOUND';
        else {
          tx.transition('PENDING_REFERENCE');
          waiting = true;
        }
      } else if (reference.status !== 'PROCESSED')
        failure = 'REFERENCE_NOT_PROCESSED';
      else {
        failure = WagerRules.referenceFailure(
          { ...p, money },
          { ...reference.payload, money: Money.from(reference.payload.money) },
        );
        if (!failure && ['REFUND', 'ROLLBACK'].includes(p.kind)) {
          const reversed = await query(
            em,
            `SELECT id FROM wager_transactions WHERE reference_id=? AND kind=? AND status='PROCESSED'`,
            [reference.id, p.kind],
          );
          if (reversed.length) failure = 'ALREADY_REVERSED';
          direction = WagerRules.direction(p.kind, reference.kind);
        }
      }
    }
    if (!failure && !waiting && p.kind !== 'LOSS') {
      if (
        direction === LedgerDirection.Debit &&
        wallet.balance.isLessThan(money)
      )
        failure = WagerRules.insufficientFunds(p.kind);
      else if (
        direction === LedgerDirection.Credit &&
        wallet.balance.add(money).toJSON().amount.split('.')[0].length > 16
      )
        failure = 'BALANCE_LIMIT_EXCEEDED';
      else {
        const before = wallet.balance;
        if (direction === LedgerDirection.Debit) wallet.debit(money);
        else wallet.credit(money);
        await em.execute(
          'UPDATE wallets SET balance=?,version=?,updated_at=? WHERE id=?',
          [
            wallet.balance.toJSON().amount,
            wallet.version,
            wallet.updatedAt,
            wallet.id,
          ],
        );
        await this.ledger(em, wallet, row.id, direction, money, before);
      }
    }
    if (failure) tx.transition('REJECTED', failure);
    else if (!waiting) tx.transition('PROCESSED');
    const result: Result = {
      transactionId: row.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      ...(failure ? { failureCode: failure } : {}),
      idempotentReplay: false,
    };
    await em.execute(
      `UPDATE wager_transactions SET status=?,reference_id=?,failure_code=?,result=?::jsonb,attempts=attempts+1,next_attempt_at=now()+(? * interval '1 second'),processed_at=? WHERE id=?`,
      [
        tx.status,
        reference?.id ?? null,
        failure ?? null,
        JSON.stringify(result),
        Math.min(300, 2 ** (row.attempts + 1)),
        tx.isTerminal() ? new Date() : null,
        row.id,
      ],
    );
    // Emit the pending event only on entering the state, not on every retry.
    if (
      tx.status !== 'PENDING_REFERENCE' ||
      row.status !== 'PENDING_REFERENCE'
    ) {
      const type =
        tx.status === 'PROCESSED'
          ? WagerTransactionProcessed
          : tx.status === 'REJECTED'
            ? WagerTransactionRejected
            : WagerTransactionPendingReference;
      await this.event(
        em,
        type.create({
          eventId: randomUUID(),
          aggregateId: wallet.id,
          correlationId: row.id,
          occurredAt: new Date(),
          data: { ...result, providerId: p.providerId },
        }),
      );
    }
    return result;
  }
  private async ledger(
    em: EntityManager,
    wallet: Wallet,
    id: string,
    direction: LedgerDirection,
    money: Money,
    before: Money,
  ) {
    const entry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: id,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: wallet.balance,
    });
    await em.execute(
      'INSERT INTO wallet_ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after) VALUES (?,?,?,?,?,?,?,?)',
      [
        entry.id,
        wallet.id,
        id,
        direction,
        money.toJSON().amount,
        money.currency,
        before.toJSON().amount,
        wallet.balance.toJSON().amount,
      ],
    );
    await this.event(
      em,
      WalletBalanceChanged.create({
        eventId: randomUUID(),
        aggregateId: wallet.id,
        correlationId: id,
        occurredAt: new Date(),
        data: {
          walletId: wallet.id,
          transactionId: id,
          direction,
          money: money.toJSON(),
          balanceBefore: before.toJSON(),
          balanceAfter: wallet.balance.toJSON(),
          walletVersion: wallet.version,
        },
      }),
    );
  }
  private async event(em: EntityManager, event: IntegrationEvent) {
    const p = event.toJSON();
    await em.execute(
      'INSERT INTO outbox(id,aggregate_id,event_type,payload) VALUES (?,?,?,?::jsonb)',
      [p.eventId, p.aggregateId, p.eventType, JSON.stringify(p)],
    );
  }
  async retryPending(): Promise<number> {
    const rows = await query<{ id: string; wallet_id: string }>(
      this.orm.em.fork(),
      `SELECT id,wallet_id FROM wager_transactions WHERE status='PENDING_REFERENCE' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 50`,
    );
    for (const item of rows)
      await this.transaction(async (em) => {
        const wallet = await this.lockWallet(em, item.wallet_id);
        const [row] = await query<TransactionRow>(
          em,
          `SELECT * FROM wager_transactions WHERE id=? AND status='PENDING_REFERENCE' AND next_attempt_at<=now()`,
          [item.id],
        );
        if (row) await this.apply(em, row, wallet);
      });
    return rows.length;
  }
  async getWallet(id: string) {
    const [r] = await query<WalletRow>(
      this.orm.em.fork(),
      'SELECT * FROM wallets WHERE id=?',
      [id],
    );
    if (!r) throw new ApplicationError('WALLET_NOT_FOUND', 404);
    return {
      id: r.id,
      playerId: r.player_id,
      balance: { amount: r.balance, currency: r.currency },
      version: r.version,
    };
  }
  async getTransaction(id: string, providerId?: string) {
    const [r] = await query<TransactionRow>(
      this.orm.em.fork(),
      providerId
        ? 'SELECT * FROM wager_transactions WHERE provider_id=? AND external_transaction_id=?'
        : 'SELECT * FROM wager_transactions WHERE id=?',
      providerId ? [providerId, id] : [id],
    );
    if (!r) throw new ApplicationError('TRANSACTION_NOT_FOUND', 404);
    return {
      ...r.result,
      ...r.payload,
      referenceTransactionId: r.reference_id,
    };
  }
  async getLedger(id: string, cursor?: string, limitText?: string) {
    await this.getWallet(id);
    const limit = limitText === undefined ? 50 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApplicationError('INVALID_LIMIT', 400);
    let sequence = '0';
    if (cursor) {
      try {
        const decoded = object(
          JSON.parse(Buffer.from(cursor, 'base64url').toString()),
        );
        if (
          decoded.walletId !== id ||
          typeof decoded.sequence !== 'string' ||
          !/^\d{1,19}$/.test(decoded.sequence) ||
          BigInt(decoded.sequence) > 9223372036854775807n
        )
          throw new Error();
        sequence = decoded.sequence;
      } catch {
        throw new ApplicationError('INVALID_CURSOR', 400);
      }
    }
    const rows = await query<{
      id: string;
      sequence: string;
      transaction_id: string;
      direction: string;
      amount: string;
      currency: string;
      balance_before: string;
      balance_after: string;
      created_at: Date;
    }>(
      this.orm.em.fork(),
      'SELECT * FROM wallet_ledger WHERE wallet_id=? AND sequence>?::bigint ORDER BY sequence LIMIT ?',
      [id, sequence, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        transactionId: r.transaction_id,
        direction: r.direction,
        money: { amount: r.amount, currency: r.currency },
        balanceBefore: { amount: r.balance_before, currency: r.currency },
        balanceAfter: { amount: r.balance_after, currency: r.currency },
        createdAt: r.created_at,
      })),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                walletId: id,
                sequence: String(page[page.length - 1].sequence),
              }),
            ).toString('base64url')
          : null,
    };
  }
  async reconcile(id: string) {
    return this.transaction(async (em) => {
      const w = await this.lockWallet(em, id);
      const [r] = await query<{ balance: string; count: string }>(
        em,
        `SELECT COALESCE(sum(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0)::numeric(18,2)::text balance,count(*)::text count FROM wallet_ledger WHERE wallet_id=?`,
        [id],
      );
      const calculated = Money.from({
        amount: r.balance,
        currency: w.currency,
      });
      return {
        walletId: id,
        storedBalance: w.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: w.balance.subtract(calculated).toJSON(),
        consistent: w.balance.equals(calculated),
        checkedEntries: Number(r.count),
      };
    });
  }
}
