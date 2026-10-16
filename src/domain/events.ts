export interface EventProps {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: Readonly<Record<string, unknown>>;
}
export abstract class IntegrationEvent {
  abstract readonly eventType: string;
  readonly version = 1;
  protected constructor(protected readonly props: EventProps) {}
  toJSON() {
    return {
      ...this.props,
      occurredAt: this.props.occurredAt.toISOString(),
      eventType: this.eventType,
      version: this.version,
    };
  }
}
export class WagerTransactionProcessed extends IntegrationEvent {
  readonly eventType = 'WagerTransactionProcessed';
  static create(p: EventProps) {
    return new WagerTransactionProcessed(p);
  }
}
export class WagerTransactionRejected extends IntegrationEvent {
  readonly eventType = 'WagerTransactionRejected';
  static create(p: EventProps) {
    return new WagerTransactionRejected(p);
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent {
  readonly eventType = 'WagerTransactionPendingReference';
  static create(p: EventProps) {
    return new WagerTransactionPendingReference(p);
  }
}
export class WalletBalanceChanged extends IntegrationEvent {
  readonly eventType = 'WalletBalanceChanged';
  static create(p: EventProps) {
    return new WalletBalanceChanged(p);
  }
}
