import Decimal from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string') {
      throw new Error('INVALID_MONEY_AMOUNT');
    }

    if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(props.amount)) {
      throw new Error('INVALID_MONEY_AMOUNT');
    }

    if (
      typeof props.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(props.currency)
    ) {
      throw new Error('INVALID_CURRENCY');
    }

    const value = new Decimal(props.amount);

    if (!value.isFinite() || value.isNegative()) {
      throw new Error('INVALID_MONEY_AMOUNT');
    }

    return new Money(value, props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return this.fromDecimal(this.value.plus(other.value));
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return this.fromDecimal(this.value.minus(other.value));
  }

  negate(): Money {
    return this.fromDecimal(this.value.negated());
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private fromDecimal(value: Decimal): Money {
    return new Money(value, this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error('CURRENCY_MISMATCH');
    }
  }
}
