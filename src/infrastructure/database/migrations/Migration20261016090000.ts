import { Migration } from '@mikro-orm/migrations';

export class Migration20261016090000 extends Migration {
  override up(): void {
    this.addSql(`
      ALTER TABLE wallets ADD CONSTRAINT wallets_nonnegative CHECK (balance >= 0 AND version >= 1);
      CREATE TABLE wager_transactions (
        id varchar(255) PRIMARY KEY, provider_id varchar(255) NOT NULL,
        external_transaction_id varchar(255) NOT NULL, idempotency_key varchar(512) NOT NULL UNIQUE,
        payload_hash char(64) NOT NULL, wallet_id varchar(255) NOT NULL REFERENCES wallets(id),
        payload jsonb NOT NULL, kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        reference_id varchar(255) REFERENCES wager_transactions(id), failure_code text,
        result jsonb, attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz, UNIQUE(provider_id, external_transaction_id)
      );
      CREATE UNIQUE INDEX unique_reversal ON wager_transactions(reference_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE INDEX pending_references ON wager_transactions(next_attempt_at) WHERE status = 'PENDING_REFERENCE';
      CREATE TABLE wallet_ledger (
        id varchar(255) PRIMARY KEY, sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
        wallet_id varchar(255) NOT NULL REFERENCES wallets(id),
        transaction_id varchar(255) NOT NULL REFERENCES wager_transactions(id),
        direction text NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),
        amount numeric(18,2) NOT NULL CHECK(amount > 0), currency varchar(3) NOT NULL,
        balance_before numeric(18,2) NOT NULL CHECK(balance_before >= 0),
        balance_after numeric(18,2) NOT NULL CHECK(balance_after >= 0),
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(wallet_id, transaction_id),
        CHECK(balance_after = balance_before + CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)
      );
      CREATE INDEX ledger_page ON wallet_ledger(wallet_id, sequence);
      CREATE TABLE inbox (
        consumer_name text NOT NULL, message_id varchar(255) NOT NULL, payload_hash char(64) NOT NULL,
        transaction_id varchar(255) NOT NULL REFERENCES wager_transactions(id),
        received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(consumer_name, message_id)
      );
      CREATE TABLE outbox (
        id varchar(255) PRIMARY KEY, aggregate_id varchar(255) NOT NULL, event_type text NOT NULL,
        payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
        attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
      );
      CREATE INDEX outbox_due ON outbox(next_attempt_at) WHERE published_at IS NULL;
      CREATE FUNCTION immutable_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'LEDGER_IMMUTABLE'; END $$;
      CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION immutable_ledger();
      CREATE FUNCTION terminal_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN RAISE EXCEPTION 'TRANSACTION_TERMINAL'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER transaction_terminal BEFORE UPDATE OR DELETE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION terminal_transaction();
      CREATE FUNCTION check_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE wid text; stored numeric; calculated numeric;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN wid := NEW.id; ELSE wid := NEW.wallet_id; END IF;
        SELECT balance INTO stored FROM wallets WHERE id = wid;
        SELECT COALESCE(sum(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0) INTO calculated FROM wallet_ledger WHERE wallet_id=wid;
        IF stored <> calculated THEN RAISE EXCEPTION 'WALLET_LEDGER_MISMATCH'; END IF;
        IF EXISTS (SELECT 1 FROM wallet_ledger l JOIN wallets w ON w.id=l.wallet_id JOIN wager_transactions t ON t.id=l.transaction_id WHERE l.wallet_id=wid AND (l.currency<>w.currency OR t.wallet_id<>wid OR t.status<>'PROCESSED' OR t.kind='LOSS')) THEN RAISE EXCEPTION 'INVALID_LEDGER_TRANSACTION'; END IF;
        RETURN NEW;
      END $$;
      CREATE CONSTRAINT TRIGGER wallet_ledger_consistency AFTER INSERT OR UPDATE ON wallets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();
      CREATE CONSTRAINT TRIGGER ledger_wallet_consistency AFTER INSERT ON wallet_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();
    `);
  }
  override down(): void {
    this.addSql(`DROP TRIGGER wallet_ledger_consistency ON wallets;
      DROP TABLE inbox, outbox, wallet_ledger, wager_transactions;
      DROP FUNCTION check_wallet_ledger(), immutable_ledger(), terminal_transaction();
      ALTER TABLE wallets DROP CONSTRAINT wallets_nonnegative;`);
  }
}
