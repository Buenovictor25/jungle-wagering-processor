import { Client } from 'pg';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/database/mikro-orm.config';
// A fresh, uniquely named database: never rolls back the user's wagering database.
const name = `wagering_migration_test_${Date.now()}`;
const admin = new Client({
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: config.dbName,
});
await admin.connect();
await admin.query(`CREATE DATABASE "${name}"`);
await admin.end();
const orm = await MikroORM.init({
  ...config,
  dbName: name,
  migrations: { ...config.migrations, snapshot: false },
});
try {
  await orm.migrator.up();
  await orm.em.fork().execute('SELECT * FROM wallet_ledger LIMIT 1');
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
  await orm.em.fork().execute('SELECT * FROM outbox LIMIT 1');
  console.log(
    JSON.stringify({
      test: 'migration_up_down_up',
      status: 'passed',
      database: name,
      retained: true,
    }),
  );
} finally {
  await orm.close();
}
