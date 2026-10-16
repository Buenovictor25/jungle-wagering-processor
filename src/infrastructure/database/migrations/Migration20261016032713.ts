import { Migration } from '@mikro-orm/migrations';

export class Migration20261016032713 extends Migration {
  override name = 'Migration20261016032713';

  override up(): void | Promise<void> {
    this.addSql(
      `create table "wallets" ("id" varchar(255) not null, "player_id" varchar(255) not null, "currency" varchar(3) not null, "balance" numeric(18,2) not null, "version" int not null default 1, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "wallets" add constraint "wallets_player_id_currency_unique" unique ("player_id", "currency");`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallets" cascade;`);
  }
}
