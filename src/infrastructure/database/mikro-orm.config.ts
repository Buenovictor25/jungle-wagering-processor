import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletRecord } from './entities/wallet-record.entity';

export default defineConfig({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5433),
  user: process.env.DB_USER ?? 'jungle',
  password: process.env.DB_PASSWORD ?? 'jungle_dev',
  dbName: process.env.DB_NAME ?? 'wagering',

  entities: [WalletRecord],

  extensions: [Migrator],

  migrations: {
    path: './dist/infrastructure/database/migrations',
    pathTs: './src/infrastructure/database/migrations',
    tableName: 'mikro_orm_migrations',
    transactional: true,
    allOrNothing: true,
  },

  // Financial SQL parameters must never enter application logs.
  debug: false,
});
