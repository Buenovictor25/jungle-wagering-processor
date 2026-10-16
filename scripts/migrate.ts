import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/database/mikro-orm.config';
const orm = await MikroORM.init(config);
try {
  const direction = process.argv[2] ?? 'up';
  if (direction === 'up') await orm.migrator.up();
  else if (direction === 'down') await orm.migrator.down();
  else if (direction === 'list')
    console.log(await orm.migrator.getPendingMigrations());
  else throw new Error('Use up, down or list');
} finally {
  await orm.close();
}
