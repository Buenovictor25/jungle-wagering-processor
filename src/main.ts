import { NestFactory } from '@nestjs/core';
import { ConsoleLogger } from '@nestjs/common';
import { AppModule } from './app.module';
import { ApiErrorFilter } from './http/api.controller';
import { Telemetry } from './infrastructure/telemetry';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true }),
  });
  app.useGlobalFilters(new ApiErrorFilter(app.get(Telemetry)));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
