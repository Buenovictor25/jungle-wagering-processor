import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/database/mikro-orm.config';
import { query, WageringService } from '../src/application/wagering.service';
import { TransactionInput } from '../src/application/contracts';
import { Messaging } from '../src/infrastructure/messaging';
import { Telemetry } from '../src/infrastructure/telemetry';
import {
  ReceiveMessageCommand,
  SendMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';

describe('Real PostgreSQL and SQS', () => {
  let orm: MikroORM;
  let service: WageringService;
  let messaging: Messaging;
  const wallets: string[] = [];
  beforeAll(async () => {
    orm = await MikroORM.init(config);
    service = new WageringService(orm);
    messaging = new Messaging(orm, service, new Telemetry());
    messaging.queuePrefix = `test-${randomUUID()}`;
    await messaging.setup();
  });
  afterAll(async () => {
    for (const id of wallets)
      expect((await service.reconcile(id)).consistent).toBe(true);
    await messaging.onApplicationShutdown();
    await orm.close();
  });
  async function wallet(amount = '100.00') {
    const w = await service.createWallet({
      playerId: randomUUID(),
      initialBalance: { amount, currency: 'BRL' },
    });
    wallets.push(w.id);
    return w;
  }
  function input(
    w: { id: string; playerId: string },
    kind: TransactionInput['kind'] = 'BET',
    amount = '25.00',
    ref?: string,
  ): TransactionInput {
    return {
      providerId: 'test-provider',
      externalTransactionId: randomUUID(),
      walletId: w.id,
      playerId: w.playerId,
      roundId: 'round',
      gameId: 'game',
      kind,
      money: { amount, currency: 'BRL' },
      ...(ref ? { referenceExternalTransactionId: ref } : {}),
    };
  }
  const submit = (p: TransactionInput) =>
    service.submit(p, `${p.providerId}:${p.externalTransactionId}`);
  it('OPENING, duplicate wallet, zero balance, immutable ledger and schema checks', async () => {
    const w = await wallet();
    expect((await service.getLedger(w.id)).items).toHaveLength(1);
    await expect(
      service.createWallet({ playerId: w.playerId, initialBalance: w.balance }),
    ).rejects.toThrow();
    const zero = await wallet('0.00');
    expect((await service.getLedger(zero.id)).items).toHaveLength(0);
    await expect(
      orm.em.fork().execute('UPDATE wallets SET balance=-1 WHERE id=?', [w.id]),
    ).rejects.toThrow();
    await expect(
      orm.em
        .fork()
        .execute('UPDATE wallets SET balance=101 WHERE id=?', [w.id]),
    ).rejects.toThrow('WALLET_LEDGER_MISMATCH');
    await expect(
      orm.em
        .fork()
        .execute('UPDATE wallet_ledger SET amount=1 WHERE wallet_id=?', [w.id]),
    ).rejects.toThrow('LEDGER_IMMUTABLE');
    await expect(
      orm.em
        .fork()
        .execute('DELETE FROM wallet_ledger WHERE wallet_id=?', [w.id]),
    ).rejects.toThrow('LEDGER_IMMUTABLE');
  });
  it('50 parallel duplicates produce one debit and historical replay', async () => {
    const w = await wallet();
    const p = input(w);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => submit(p)),
    );
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    await submit(input(w, 'WIN', '10.00'));
    expect((await submit(p)).balance.amount).toBe('75.00');
    expect((await service.getWallet(w.id)).balance.amount).toBe('85.00');
    await expect(
      service.submit(
        { ...p, money: { amount: '26.00', currency: 'BRL' } },
        `${p.providerId}:${p.externalTransactionId}`,
      ),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('two concurrent BET 80 over 100: one processed, one rejected, one debit', async () => {
    const w = await wallet();
    const results = await Promise.all([
      submit(input(w, 'BET', '80.00')),
      submit(input(w, 'BET', '80.00')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'PROCESSED',
      'REJECTED',
    ]);
    expect(results.find((r) => r.status === 'REJECTED')?.failureCode).toBe(
      'INSUFFICIENT_FUNDS',
    );
    expect((await service.getWallet(w.id)).balance.amount).toBe('20.00');
    expect(
      (await service.getLedger(w.id)).items.filter(
        (r) => r.direction === 'DEBIT',
      ),
    ).toHaveLength(1);
  });
  it('WIN, LOSS, REFUND, ROLLBACK and duplicate reversal rules', async () => {
    const w = await wallet();
    const bet = input(w);
    await submit(bet);
    const loss = await submit(input(w, 'LOSS', '0.00'));
    expect(loss.balance.amount).toBe('75.00');
    expect((await service.getWallet(w.id)).version).toBe(2);
    const refund = input(w, 'REFUND', '25.00', bet.externalTransactionId);
    expect((await submit(refund)).balance.amount).toBe('100.00');
    expect(
      (await submit(input(w, 'REFUND', '25.00', bet.externalTransactionId)))
        .failureCode,
    ).toBe('ALREADY_REVERSED');
    expect(
      (
        await submit(
          input(w, 'ROLLBACK', '25.00', refund.externalTransactionId),
        )
      ).balance.amount,
    ).toBe('75.00');
    const win = input(w, 'WIN', '50.00');
    await submit(win);
    expect(
      (await submit(input(w, 'ROLLBACK', '50.00', win.externalTransactionId)))
        .balance.amount,
    ).toBe('75.00');
    expect(
      (await submit(input(w, 'ROLLBACK', '25.00', bet.externalTransactionId)))
        .balance.amount,
    ).toBe('100.00');
  });
  it('reversal insufficient funds and invalid references remain auditable', async () => {
    const w = await wallet('0.00');
    const win = input(w, 'WIN', '80.00');
    await submit(win);
    await submit(input(w, 'BET', '80.00'));
    expect(
      (await submit(input(w, 'ROLLBACK', '80.00', win.externalTransactionId)))
        .failureCode,
    ).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(
      (await submit(input(w, 'REFUND', '80.00', win.externalTransactionId)))
        .failureCode,
    ).toBe('INVALID_REFERENCE_KIND');
    expect(
      (
        await submit({
          ...input(w),
          money: { amount: '1.00', currency: 'USD' },
        })
      ).failureCode,
    ).toBe('CURRENCY_MISMATCH');
    expect((await submit({ ...input(w), playerId: 'other' })).failureCode).toBe(
      'PLAYER_MISMATCH',
    );
    expect(
      (await submit(input(w, 'ROLLBACK', '1.00', win.externalTransactionId)))
        .failureCode,
    ).toBe('REVERSAL_AMOUNT_MISMATCH');
  });
  it('out of order reference resolves and exhaustion rejects', async () => {
    const w = await wallet();
    const bet = input(w);
    const refund = input(w, 'REFUND', '25.00', bet.externalTransactionId);
    const r = await submit(refund);
    expect(r.status).toBe('PENDING_REFERENCE');
    await submit(bet);
    await orm.em
      .fork()
      .execute(
        'UPDATE wager_transactions SET next_attempt_at=now() WHERE id=?',
        [r.transactionId],
      );
    await service.retryPending();
    expect((await submit(refund)).status).toBe('PROCESSED');
    expect((await service.getWallet(w.id)).balance.amount).toBe('100.00');
    const missing = await submit(
      input(w, 'REFUND', '1.00', 'missing-' + randomUUID()),
    );
    await orm.em
      .fork()
      .execute(
        'UPDATE wager_transactions SET attempts=8,next_attempt_at=now() WHERE id=?',
        [missing.transactionId],
      );
    await service.retryPending();
    expect(
      (await service.getTransaction(missing.transactionId)).failureCode,
    ).toBe('REFERENCE_NOT_FOUND');
  });
  it('inbox conflict rolls back all financial effects and events', async () => {
    const w = await wallet();
    const p = input(w);
    const messageId = randomUUID();
    await service.submit(p, p.externalTransactionId, messageId);
    expect(
      (await service.submit(p, p.externalTransactionId, messageId))
        .idempotentReplay,
    ).toBe(true);
    const other = input(w);
    await expect(
      service.submit(other, other.externalTransactionId, messageId),
    ).rejects.toThrow('INBOX_CONFLICT');
    expect((await service.getWallet(w.id)).balance.amount).toBe('75.00');
    const rows = await query(
      orm.em.fork(),
      'SELECT * FROM wager_transactions WHERE external_transaction_id=?',
      [other.externalTransactionId],
    );
    expect(rows).toHaveLength(0);
    const events = await query(
      orm.em.fork(),
      'SELECT * FROM outbox WHERE aggregate_id=?',
      [w.id],
    );
    expect(events).toHaveLength(4);
  });
  it('stable pagination and parallel independent wallets', async () => {
    const ws = await Promise.all(Array.from({ length: 5 }, () => wallet()));
    await Promise.all(ws.map((w) => submit(input(w))));
    const a = await service.getLedger(ws[0].id, undefined, '1');
    const b = await service.getLedger(ws[0].id, a.nextCursor!, '1');
    expect(a.items[0].id).not.toBe(b.items[0].id);
    expect(b.nextCursor).toBeNull();
  });
  it('SQS redelivery before ack does not duplicate debit', async () => {
    const w = await wallet();
    const p = input(w);
    const messageId = randomUUID();
    await messaging.sqs.send(
      new SendMessageCommand({
        QueueUrl: messaging.queueUrl,
        MessageGroupId: w.id,
        MessageDeduplicationId: randomUUID(),
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: { ...p, idempotencyKey: p.externalTransactionId },
        }),
      }),
    );
    const first = await messaging.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: messaging.queueUrl,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
      }),
    );
    expect(first.Messages?.length).toBe(1);
    await service.submit(p, p.externalTransactionId, messageId);
    await messaging.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: messaging.queueUrl,
        ReceiptHandle: first.Messages![0].ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
    const redelivery = await messaging.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: messaging.queueUrl,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    await messaging.consume(redelivery.Messages![0]);
    expect((await service.getWallet(w.id)).balance.amount).toBe('75.00');
  });
  it('permanent malformed message reaches real DLQ', async () => {
    await messaging.sqs.send(
      new SendMessageCommand({
        QueueUrl: messaging.queueUrl,
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
        MessageBody: 'invalid-json',
      }),
    );
    const incoming = await messaging.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: messaging.queueUrl,
        WaitTimeSeconds: 1,
      }),
    );
    await messaging.consume(incoming.Messages![0]);
    const dlq = await messaging.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: messaging.dlqUrl,
        WaitTimeSeconds: 1,
      }),
    );
    expect(dlq.Messages?.length).toBeGreaterThan(0);
  });
  it('two publishers drain committed outbox with stable event identities', async () => {
    const other = new Messaging(orm, service, new Telemetry());
    other.eventsUrl = messaging.eventsUrl;
    try {
      for (let i = 0; i < 30; i++) {
        await Promise.all([messaging.publish(), other.publish()]);
        const [r] = await query<{ n: string }>(
          orm.em.fork(),
          'SELECT count(*)::text n FROM outbox WHERE published_at IS NULL',
        );
        if (r.n === '0') break;
      }
      const [r] = await query<{ n: string }>(
        orm.em.fork(),
        'SELECT count(*)::text n FROM outbox WHERE published_at IS NULL',
      );
      expect(r.n).toBe('0');
    } finally {
      await other.onApplicationShutdown();
    }
  }, 30000);
});
