import { Money } from '../value-objects/money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  balanceBefore: Money;
  balanceAfter: Money;
  amount: Money;
  direction: 'DEBIT' | 'CREDIT';
  walletVersion: number;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    if (!props.id || !props.playerId) {
      throw new Error('INVALID_WALLET_IDENTITY');
    }

    if (props.initialBalance.isNegative()) {
      throw new Error('NEGATIVE_INITIAL_BALANCE');
    }

    const now = new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(amount: Money): WalletMovement {
    this.assertValidMovement(amount);

    if (this._balance.isLessThan(amount)) {
      throw new Error('INSUFFICIENT_FUNDS');
    }

    const before = this._balance;
    const after = before.subtract(amount);

    this.applyBalance(after);

    return {
      balanceBefore: before,
      balanceAfter: after,
      amount,
      direction: 'DEBIT',
      walletVersion: this._version,
    };
  }

  credit(amount: Money): WalletMovement {
    this.assertValidMovement(amount);

    const before = this._balance;
    const after = before.add(amount);

    this.applyBalance(after);

    return {
      balanceBefore: before,
      balanceAfter: after,
      amount,
      direction: 'CREDIT',
      walletVersion: this._version,
    };
  }

  private applyBalance(balance: Money): void {
    if (balance.isNegative()) {
      throw new Error('NEGATIVE_WALLET_BALANCE');
    }

    this._balance = balance;
    this._version += 1;
    this._updatedAt = new Date();
  }

  private assertValidMovement(amount: Money): void {
    this.assertSameCurrency(amount);

    if (!amount.isPositive()) {
      throw new Error('INVALID_MOVEMENT_AMOUNT');
    }
  }

  private assertSameCurrency(amount: Money): void {
    if (this.currency !== amount.currency) {
      throw new Error('CURRENCY_MISMATCH');
    }
  }
}
