import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/database/mikro-orm.config';
import {
  query,
  Result,
  WageringService,
} from '../src/application/wagering.service';
import { Messaging } from '../src/infrastructure/messaging';
import { Telemetry } from '../src/infrastructure/telemetry';
import { SendMessageCommand } from '@aws-sdk/client-sqs';

interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}
const ports = [33101, 33102, 33103];
type Child = ReturnType<typeof Bun.spawn>;
const children: Child[] = [];
const logs = new Map<number, Promise<string>>();
function start(port: number, extra: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      WORKERS_ENABLED: 'false',
      NODE_ENV: 'test',
      ...extra,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  logs.set(
    child.pid,
    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).then((s) => s.join('\n')),
  );
  children.push(child);
  return child;
}
async function until<T>(
  action: () => Promise<T>,
  accept: (v: T) => boolean,
  ms = 10000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await action();
      if (accept(value)) return value;
    } catch {
      /* startup or visibility delay */
    }
    await Bun.sleep(100);
  }
  throw new Error('Timed out awaiting observable state');
}
async function request<T>(
  port: number,
  path: string,
  body?: unknown,
  key?: string,
): Promise<{ status: number; body: T }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as T };
}
async function ready(port: number) {
  await until(
    () => request(port, '/health/ready'),
    (r) => r.status === 200,
  );
}

describe('Three real Bun/Nest processes and crash recovery', () => {
  let orm: MikroORM;
  let service: WageringService;
  let messaging: Messaging;
  const wallets: string[] = [];
  beforeAll(async () => {
    orm = await MikroORM.init(config);
    service = new WageringService(orm);
    messaging = new Messaging(orm, service, new Telemetry());
    messaging.queuePrefix = `crash-${randomUUID()}`;
    await messaging.setup();
    ports.forEach((p) => start(p));
    await Promise.all(ports.map(ready));
  }, 20000);
  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
    for (const id of wallets)
      expect((await service.reconcile(id)).consistent).toBe(true);
    await messaging.onApplicationShutdown();
    await orm.close();
  }, 15000);
  async function wallet() {
    const r = await request<WalletResponse>(ports[0], '/wallets', {
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(r.status).toBe(201);
    wallets.push(r.body.id);
    return r.body;
  }
  function bet(w: WalletResponse, amount = '25.00') {
    return {
      providerId: 'process-test',
      externalTransactionId: randomUUID(),
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    };
  }
  it('50 HTTP requests across 3 processes debit exactly once', async () => {
    const w = await wallet();
    const p = bet(w);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        request<Result>(
          ports[i % 3],
          '/wagering/transactions',
          p,
          p.externalTransactionId,
        ),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect((await service.getWallet(w.id)).balance.amount).toBe('75.00');
  });
  it('simultaneous 80.00 BETs across processes preserve 20.00', async () => {
    const w = await wallet();
    const a = bet(w, '80.00');
    const b = bet(w, '80.00');
    const results = await Promise.all([
      request<Result>(
        ports[1],
        '/wagering/transactions',
        a,
        a.externalTransactionId,
      ),
      request<Result>(
        ports[2],
        '/wagering/transactions',
        b,
        b.externalTransactionId,
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect((await service.getWallet(w.id)).balance.amount).toBe('20.00');
  });
  it('HTTP errors distinguish invalid, conflict, pending and business rejection', async () => {
    const w = await wallet();
    const p = bet(w);
    expect((await request(ports[0], '/wagering/transactions', p)).status).toBe(
      400,
    );
    expect(
      (
        await request(
          ports[0],
          '/wagering/transactions',
          { ...p, money: { amount: 25, currency: 'BRL' } },
          p.externalTransactionId,
        )
      ).status,
    ).toBe(400);
    await request(
      ports[0],
      '/wagering/transactions',
      p,
      p.externalTransactionId,
    );
    expect(
      (
        await request(
          ports[1],
          '/wagering/transactions',
          { ...p, roundId: 'other' },
          p.externalTransactionId,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(ports[0], '/wallets', {
          playerId: w.playerId,
          initialBalance: w.balance,
        })
      ).status,
    ).toBe(409);
    const pending = {
      ...bet(w),
      kind: 'REFUND',
      referenceExternalTransactionId: randomUUID(),
    };
    expect(
      (
        await request(
          ports[0],
          '/wagering/transactions',
          pending,
          pending.externalTransactionId,
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await request(
          ports[0],
          `/providers/${p.providerId}/wagering/transactions/${p.externalTransactionId}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (await request(ports[0], `/wallets/${w.id}/ledger?limit=0`)).status,
    ).toBe(400);
    expect((await request(ports[0], '/wallets/missing')).status).toBe(404);
  });
  it('lock contention is bounded, observable, and safely retryable', async () => {
    const w = await wallet();
    const p = bet(w);
    let release!: () => void;
    let acquired!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id=? FOR UPDATE', [w.id]);
      acquired();
      await released;
    });
    await locked;
    try {
      expect(
        (
          await request(
            ports[1],
            '/wagering/transactions',
            p,
            p.externalTransactionId,
          )
        ).status,
      ).toBe(503);
    } finally {
      release();
      await holder;
    }
    expect(
      (
        await request(
          ports[1],
          '/wagering/transactions',
          p,
          p.externalTransactionId,
        )
      ).status,
    ).toBe(200);
    const metrics = await (
      await fetch(`http://127.0.0.1:${ports[1]}/metrics`)
    ).text();
    expect(metrics).toContain('wagering_lock_conflicts_total 1');
    expect(metrics).toContain('wagering_outbox_lag_seconds');
    expect((await service.getWallet(w.id)).balance.amount).toBe('75.00');
  }, 10000);
  it('restart retains idempotency, original balance and reconciliation', async () => {
    const w = await wallet();
    const p = bet(w);
    const original = await request<Result>(
      ports[0],
      '/wagering/transactions',
      p,
      p.externalTransactionId,
    );
    children[0].kill();
    await children[0].exited;
    start(ports[0]);
    await ready(ports[0]);
    const replay = await request<Result>(
      ports[0],
      '/wagering/transactions',
      p,
      p.externalTransactionId,
    );
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(
      (
        await request<{ consistent: boolean }>(
          ports[0],
          `/wallets/${w.id}/reconciliation`,
          {},
        )
      ).body.consistent,
    ).toBe(true);
  }, 15000);
  it('database unavailability returns 503 while liveness remains 200', async () => {
    const unavailable = start(33105, { DB_PORT: '1' });
    try {
      await until(
        () => request(33105, '/health/live'),
        (r) => r.status === 200,
      );
      expect((await request(33105, '/health/ready')).status).toBe(503);
      expect((await request(33105, '/wallets/anything')).status).toBe(503);
    } finally {
      unavailable.kill();
      await unavailable.exited;
    }
  }, 15000);
  it('worker process dies after commit before ack; successor safely receives again', async () => {
    const w = await wallet();
    const p = bet(w);
    const messageId = randomUUID();
    const crashing = start(33104, {
      WORKERS_ENABLED: 'true',
      SQS_QUEUE_PREFIX: messaging.queuePrefix,
      TEST_CRASH_AFTER_COMMIT: 'true',
    });
    await ready(33104);
    await messaging.sqs.send(
      new SendMessageCommand({
        QueueUrl: messaging.queueUrl,
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: { ...p, idempotencyKey: p.externalTransactionId },
        }),
        MessageGroupId: w.id,
        MessageDeduplicationId: randomUUID(),
      }),
    );
    await until(
      () => Promise.resolve(crashing.exitCode),
      (code) => code !== null,
      15000,
    );
    expect(await crashing.exited).toBe(86);
    expect((await service.getWallet(w.id)).balance.amount).toBe('75.00');
    const successor = start(33104, {
      WORKERS_ENABLED: 'true',
      SQS_QUEUE_PREFIX: messaging.queuePrefix,
    });
    await ready(33104);
    await until(
      async () => {
        const [r] = await query<{ n: string }>(
          orm.em.fork(),
          'SELECT count(*)::text n FROM inbox WHERE message_id=?',
          [messageId],
        );
        const { GetQueueAttributesCommand } =
          await import('@aws-sdk/client-sqs');
        const attrs = await messaging.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: messaging.queueUrl,
            AttributeNames: [
              'ApproximateNumberOfMessages',
              'ApproximateNumberOfMessagesNotVisible',
            ],
          }),
        );
        return (
          r.n === '1' &&
          attrs.Attributes?.ApproximateNumberOfMessages === '0' &&
          attrs.Attributes?.ApproximateNumberOfMessagesNotVisible === '0'
        );
      },
      Boolean,
      40000,
    );
    successor.kill();
    await successor.exited;
    const output = await logs.get(successor.pid)!;
    expect(output).toContain('message_committed');
    expect((await service.getWallet(w.id)).balance.amount).toBe('75.00');
    expect((await service.getLedger(w.id)).items).toHaveLength(2);
  }, 60000);
});
