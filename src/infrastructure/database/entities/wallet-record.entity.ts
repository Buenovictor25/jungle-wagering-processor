import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
export class WalletRecord {
  @PrimaryKey({ type: 'string' })
  id!: string;

  @Property({ type: 'string' })
  playerId!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({
    type: 'decimal',
    precision: 18,
    scale: 2,
  })
  balance!: string;

  @Property({ type: 'integer', default: 1 })
  version: number = 1;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();

  @Property({
    type: 'datetime',
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date();
}
