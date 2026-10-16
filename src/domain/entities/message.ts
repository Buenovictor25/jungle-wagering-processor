export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private processed?: Date,
  ) {}
  static receive(
    messageId: string,
    consumerName: string,
    payloadHash: string,
  ): InboxMessage {
    if (!messageId || !consumerName || !payloadHash)
      throw new Error('INVALID_INBOX_IDENTITY');
    return new InboxMessage(messageId, consumerName, payloadHash, new Date());
  }
  static rehydrate(
    messageId: string,
    consumerName: string,
    payloadHash: string,
    receivedAt: Date,
    processedAt?: Date,
  ): InboxMessage {
    return new InboxMessage(
      messageId,
      consumerName,
      payloadHash,
      receivedAt,
      processedAt,
    );
  }
  get processedAt(): Date | undefined {
    return this.processed;
  }
  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }
  markProcessed(at: Date): void {
    if (!this.processed) this.processed = at;
  }
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    private count: number,
    private next: Date,
    private published?: Date,
  ) {}
  static enqueue(id: string, now = new Date()): OutboxMessage {
    return new OutboxMessage(id, 0, now);
  }
  static rehydrate(
    id: string,
    attempts: number,
    nextAttemptAt: Date,
    publishedAt?: Date,
  ): OutboxMessage {
    return new OutboxMessage(id, attempts, nextAttemptAt, publishedAt);
  }
  get attempts(): number {
    return this.count;
  }
  get nextAttemptAt(): Date {
    return this.next;
  }
  get publishedAt(): Date | undefined {
    return this.published;
  }
  isDue(now: Date): boolean {
    return !this.published && this.next <= now;
  }
  markPublished(now: Date): void {
    this.assertPending();
    this.count++;
    this.published = now;
  }
  scheduleRetry(now: Date): void {
    this.assertPending();
    this.count++;
    this.next = new Date(
      now.getTime() + Math.min(300, 2 ** Math.min(this.count, 9)) * 1000,
    );
  }
  private assertPending() {
    if (this.published) throw new Error('OUTBOX_ALREADY_PUBLISHED');
  }
}
