import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import mikroOrmConfig from './infrastructure/database/mikro-orm.config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WageringService } from './application/wagering.service';
import {
  ApiController,
  HealthController,
  ProviderIdentityGuard,
} from './http/api.controller';
import { Messaging } from './infrastructure/messaging';
import { Telemetry } from './infrastructure/telemetry';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MikroOrmModule.forRoot(mikroOrmConfig),
  ],
  controllers: [AppController, ApiController, HealthController],
  providers: [
    AppService,
    WageringService,
    Messaging,
    Telemetry,
    ProviderIdentityGuard,
  ],
})
export class AppModule {}
