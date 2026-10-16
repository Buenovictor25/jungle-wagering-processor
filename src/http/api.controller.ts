import {
  ArgumentsHost,
  Body,
  CanActivate,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Headers,
  HttpException,
  Injectable,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { MikroORM } from '@mikro-orm/postgresql';
import { ApplicationError } from '../application/contracts';
import { query, WageringService } from '../application/wagering.service';
import { Messaging } from '../infrastructure/messaging';
import { Telemetry } from '../infrastructure/telemetry';

/** Extension point: replace with OIDC/JWKS verification and provider claim binding. */
@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  constructor(private readonly telemetry: Telemetry) {}
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const dbCode =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
    let status = 503;
    let code = 'INFRASTRUCTURE_UNAVAILABLE';
    if (error instanceof ApplicationError) {
      status = error.httpStatus;
      code = error.code;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = status === 400 ? 'INVALID_PAYLOAD' : 'HTTP_ERROR';
    } else if (dbCode === '23505') {
      status = 409;
      code = 'UNIQUENESS_CONFLICT';
    }
    if (['55P03', '40P01', '40001'].includes(dbCode))
      this.telemetry.increment('lock_conflicts_total');
    this.telemetry.log('request_failed', { code, dbCode });
    response.status(status).json({ failureCode: code });
  }
}

@Controller()
@UseGuards(ProviderIdentityGuard)
export class ApiController {
  constructor(
    private readonly wagering: WageringService,
    private readonly telemetry: Telemetry,
  ) {}
  @Post('wallets') create(@Body() body: unknown) {
    return this.wagering.createWallet(body);
  }
  @Get('wallets/:id') wallet(@Param('id') id: string) {
    return this.wagering.getWallet(id);
  }
  @Get('wallets/:id/ledger') ledger(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.wagering.getLedger(id, cursor, limit);
  }
  @Get('wagering/transactions/:id') transaction(@Param('id') id: string) {
    return this.wagering.getTransaction(id);
  }
  @Get('providers/:providerId/wagering/transactions/:id') external(
    @Param('id') id: string,
    @Param('providerId') providerId: string,
  ) {
    return this.wagering.getTransaction(id, providerId);
  }
  @Post('wagering/transactions') async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const start = performance.now();
    try {
      const result = await this.wagering.submit(body, key);
      response.status(
        result.status === 'REJECTED'
          ? 422
          : result.status === 'PENDING_REFERENCE'
            ? 202
            : 200,
      );
      this.telemetry.increment(
        `transactions_${result.status.toLowerCase()}_total`,
      );
      if (result.idempotentReplay) this.telemetry.increment('duplicates_total');
      const ctx = body as Record<string, unknown>;
      this.telemetry.log('transaction_result', {
        correlationId: result.transactionId,
        transactionId: result.transactionId,
        walletId: ctx.walletId,
        providerId: ctx.providerId,
        status: result.status,
      });
      return result;
    } finally {
      this.telemetry.observe(performance.now() - start);
    }
  }
  @Post('wallets/:id/reconciliation') async reconcile(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.status(200);
    const result = await this.wagering.reconcile(id);
    if (!result.consistent) {
      this.telemetry.increment('reconciliation_mismatches_total');
      this.telemetry.log('reconciliation_mismatch', { walletId: id });
    }
    return result;
  }
}
@Controller()
export class HealthController {
  constructor(
    private readonly messaging: Messaging,
    private readonly telemetry: Telemetry,
    private readonly orm: MikroORM,
  ) {}
  @Get('health/live') live() {
    return { status: 'alive' };
  }
  @Get('health/ready') ready() {
    return this.messaging.ready();
  }
  @Get('metrics') async metrics(@Res() response: Response) {
    const [r] = await query<{ lag: string }>(
      this.orm.em.fork(),
      `SELECT COALESCE(EXTRACT(epoch FROM now()-min(occurred_at)),0)::text lag FROM outbox WHERE published_at IS NULL`,
    );
    response.type('text/plain').send(this.telemetry.render(r.lag));
  }
}
