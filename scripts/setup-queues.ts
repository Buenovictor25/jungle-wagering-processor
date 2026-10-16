import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/database/mikro-orm.config';
import { Messaging } from '../src/infrastructure/messaging';
import { WageringService } from '../src/application/wagering.service';
import { Telemetry } from '../src/infrastructure/telemetry';
const orm = await MikroORM.init(config);
const messaging = new Messaging(orm, new WageringService(orm), new Telemetry());
try {
  await messaging.setup();
  console.log('Queues ready');
} finally {
  await messaging.onApplicationShutdown();
  await orm.close();
}
