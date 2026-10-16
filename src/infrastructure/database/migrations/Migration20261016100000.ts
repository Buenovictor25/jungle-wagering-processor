import { Migration } from '@mikro-orm/migrations';

export class Migration20261016100000 extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger FOR EACH STATEMENT EXECUTE FUNCTION immutable_ledger();
      CREATE FUNCTION enforce_wallet_transition() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency OR NEW.id <> OLD.id THEN RAISE EXCEPTION 'WALLET_IDENTITY_IMMUTABLE'; END IF;
        IF (NEW.balance = OLD.balance AND NEW.version <> OLD.version) OR (NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1) THEN RAISE EXCEPTION 'INVALID_WALLET_VERSION'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER wallet_transition BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION enforce_wallet_transition();
      CREATE FUNCTION check_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE tx wager_transactions; entries bigint;
      BEGIN
        SELECT * INTO tx FROM wager_transactions WHERE id=NEW.id;
        SELECT count(*) INTO entries FROM wallet_ledger WHERE transaction_id=NEW.id;
        IF tx.status='PROCESSED' AND tx.kind<>'LOSS' AND entries<>1 THEN RAISE EXCEPTION 'TRANSACTION_LEDGER_REQUIRED'; END IF;
        IF (tx.status<>'PROCESSED' OR tx.kind='LOSS') AND entries<>0 THEN RAISE EXCEPTION 'UNEXPECTED_TRANSACTION_LEDGER'; END IF;
        RETURN NEW;
      END $$;
      CREATE CONSTRAINT TRIGGER transaction_ledger_consistency AFTER INSERT OR UPDATE ON wager_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
    `);
  }
  override down(): void {
    this
      .addSql(`DROP TRIGGER transaction_ledger_consistency ON wager_transactions;
      DROP FUNCTION check_transaction_ledger();
      DROP TRIGGER wallet_transition ON wallets;
      DROP FUNCTION enforce_wallet_transition();
      DROP TRIGGER ledger_no_truncate ON wallet_ledger;`);
  }
}
