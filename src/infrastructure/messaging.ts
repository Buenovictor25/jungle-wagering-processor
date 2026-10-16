import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { ApplicationError, identifier, object } from '../application/contracts';
import { query, WageringService } from '../application/wagering.service';
import { Telemetry } from './telemetry';

@Injectable()
export class Messaging
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  readonly sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    maxAttempts: 2,
  });
  queueUrl = '';
  queuePrefix = process.env.SQS_QUEUE_PREFIX ?? 'wager';
  dlqUrl = '';
  eventsUrl = '';
  private stopping = false;
  private timer?: ReturnType<typeof setTimeout>;
  private active: Promise<void> = Promise.resolve();
  constructor(
    private readonly orm: MikroORM,
    private readonly wagering: WageringService,
    private readonly telemetry: Telemetry,
  ) {}
  async setup() {
    const queue = async (name: string) =>
      (
        await this.sqs.send(
          new CreateQueueCommand({
            QueueName: name,
            Attributes: {
              FifoQueue: 'true',
              ContentBasedDeduplication: 'false',
            },
          }),
        )
      ).QueueUrl!;
    this.dlqUrl = await queue(`${this.queuePrefix}-transactions-dlq.fifo`);
    this.queueUrl = await queue(`${this.queuePrefix}-transactions.fifo`);
    this.eventsUrl = await queue(`${this.queuePrefix}-events.fifo`);
    const attrs = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.dlqUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    await this.sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: attrs.Attributes!.QueueArn,
            maxReceiveCount: 3,
          }),
        },
      }),
    );
  }
  onApplicationBootstrap() {
    if (process.env.WORKERS_ENABLED === 'false') return;
    const run = () => {
      this.active = this.tick()
        .catch((e) =>
          this.telemetry.log('worker_error', {
            code: e instanceof Error ? e.name : 'UNKNOWN',
          }),
        )
        .finally(() => {
          if (!this.stopping) this.timer = setTimeout(run, 500);
        });
    };
    run();
  }
  private async tick() {
    if (!this.queueUrl) await this.setup();
    const retries = await this.wagering.retryPending();
    this.telemetry.increment('retries_total', retries);
    await this.publish();
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    for (const message of response.Messages ?? []) {
      if (this.stopping) {
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );
        continue;
      }
      await this.consume(message);
    }
  }
  async consume(message: Message) {
    const start = performance.now();
    let context: Record<string, unknown> = { messageId: message.MessageId };
    try {
      let envelope: Record<string, unknown>;
      try {
        envelope = object(JSON.parse(message.Body ?? ''));
      } catch {
        throw new ApplicationError('INVALID_ENVELOPE', 400);
      }
      if (
        envelope.type !== 'WagerTransactionRequested' ||
        typeof envelope.occurredAt !== 'string' ||
        !Number.isFinite(Date.parse(envelope.occurredAt))
      )
        throw new ApplicationError('INVALID_ENVELOPE', 400);
      const data = object(envelope.data);
      const messageId = identifier(envelope.messageId);
      context = {
        messageId,
        correlationId: messageId,
        walletId: data.walletId,
        providerId: data.providerId,
      };
      const result = await this.wagering.submit(
        data,
        data.idempotencyKey,
        messageId,
      );
      context.transactionId = result.transactionId;
      this.telemetry.increment(
        `transactions_${result.status.toLowerCase()}_total`,
      );
      if (result.idempotentReplay) this.telemetry.increment('duplicates_total');
      this.telemetry.log('message_committed', context);
      // Test-only crash point: durable SQL commit has completed, receipt is not acknowledged.
      if (
        process.env.TEST_CRASH_AFTER_COMMIT === 'true' &&
        process.env.NODE_ENV === 'test'
      )
        process.exit(86);
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch (error) {
      const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
      if (
        (error instanceof ApplicationError &&
          [400, 409].includes(error.httpStatus)) ||
        attempts >= 3
      ) {
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: this.dlqUrl,
            MessageBody: message.Body ?? '{}',
            MessageGroupId: 'failed',
            MessageDeduplicationId: message.MessageId ?? crypto.randomUUID(),
          }),
        );
        await this.sqs.send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
        this.telemetry.increment('dlq_total');
        this.telemetry.log('message_dlq', {
          ...context,
          code:
            error instanceof ApplicationError ? error.code : 'RETRY_EXHAUSTED',
        });
      } else {
        this.telemetry.increment('retries_total');
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: Math.min(300, 2 ** attempts),
          }),
        );
      }
    } finally {
      this.telemetry.observe(performance.now() - start);
    }
  }
  async publish(): Promise<number> {
    // SKIP LOCKED distributes work. Network IO holds only outbox row locks, never wallet locks.
    return this.orm.em.fork().transactional(async (em) => {
      const rows = await query<{
        id: string;
        aggregate_id: string;
        payload: object;
        attempts: number;
      }>(
        em,
        `SELECT * FROM outbox WHERE published_at IS NULL AND next_attempt_at<=now() ORDER BY occurred_at LIMIT 20 FOR UPDATE SKIP LOCKED`,
      );
      for (const row of rows) {
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: this.eventsUrl,
              MessageBody: JSON.stringify(row.payload),
              MessageGroupId: row.aggregate_id,
              MessageDeduplicationId: row.id,
            }),
          );
          await em.execute(
            'UPDATE outbox SET published_at=now(),attempts=attempts+1 WHERE id=?',
            [row.id],
          );
        } catch {
          await em.execute(
            `UPDATE outbox SET attempts=attempts+1,next_attempt_at=now()+(? * interval '1 second') WHERE id=?`,
            [Math.min(300, 2 ** Math.min(row.attempts + 1, 9)), row.id],
          );
          this.telemetry.increment('retries_total');
        }
      }
      return rows.length;
    });
  }
  async ready() {
    await this.orm.em.fork().execute('SELECT 1');
    const q = await this.sqs.send(
      new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }),
    );
    await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: q.QueueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    return { status: 'ready' };
  }
  async onApplicationShutdown() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
    this.sqs.destroy();
  }
}
