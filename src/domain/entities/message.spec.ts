import { InboxMessage, OutboxMessage } from './message';
describe('Durable message states', () => {
  it('inbox preserves first processing timestamp and detects hash conflict', () => {
    const m = InboxMessage.receive('m', 'consumer', 'hash');
    const now = new Date();
    m.markProcessed(now);
    m.markProcessed(new Date(now.getTime() + 10));
    expect(m.processedAt).toBe(now);
    expect(m.matchesPayload('different')).toBe(false);
  });
  it('outbox retries exponentially and caps at five minutes', () => {
    const now = new Date();
    const m = OutboxMessage.enqueue('event', now);
    m.scheduleRetry(now);
    expect(m.nextAttemptAt.getTime() - now.getTime()).toBe(2000);
    for (let i = 0; i < 20; i++) m.scheduleRetry(now);
    expect(m.nextAttemptAt.getTime() - now.getTime()).toBe(300000);
    expect(m.isDue(now)).toBe(false);
  });
  it('published outbox cannot be rescheduled', () => {
    const m = OutboxMessage.enqueue('event');
    m.markPublished(new Date());
    expect(() => m.scheduleRetry(new Date())).toThrow(
      'OUTBOX_ALREADY_PUBLISHED',
    );
  });
});
