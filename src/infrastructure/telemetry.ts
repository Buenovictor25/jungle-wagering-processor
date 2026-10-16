import { Injectable } from '@nestjs/common';
@Injectable()
export class Telemetry {
  private readonly counters = new Map<string, number>(
    [
      'transactions_processed_total',
      'transactions_rejected_total',
      'transactions_pending_reference_total',
      'duplicates_total',
      'retries_total',
      'dlq_total',
      'lock_conflicts_total',
      'reconciliation_mismatches_total',
    ].map((k) => [k, 0]),
  );
  private latencySum = 0;
  private latencyCount = 0;
  increment(name: string, n = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + n);
  }
  observe(ms: number) {
    this.latencySum += ms / 1000;
    this.latencyCount++;
  }
  log(event: string, context: Record<string, unknown>) {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        correlationId: null,
        messageId: null,
        transactionId: null,
        walletId: null,
        providerId: null,
        ...context,
      }),
    );
  }
  render(lag: string) {
    return (
      [...this.counters].map(([k, v]) => `wagering_${k} ${v}`).join('\n') +
      `\nwagering_processing_seconds_sum ${this.latencySum}\nwagering_processing_seconds_count ${this.latencyCount}\nwagering_outbox_lag_seconds ${lag}\n`
    );
  }
}
