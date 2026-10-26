// Canonical DECIMAL(18,9); reject values that would require SQL rounding or overflow.
export function exactDecimal18_9(source: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) return null;
  const digits = (match[2]! + (match[3] ?? "")).replace(/^0+/, "");
  if (!digits) return "0";
  const sign = match[1]!;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent)) return null;
  const scale = (match[3]?.length ?? 0) - exponent;
  const significant = digits.replace(/0+$/, "");
  const fractionalDigits = Math.max(0, scale - (digits.length - significant.length));
  const integerDigits = Math.max(0, digits.length - scale);
  if (integerDigits > 9 || fractionalDigits > 9) return null;
  const padded = scale > 0 ? digits.padStart(scale + 1, "0") : digits + "0".repeat(-scale);
  if (scale <= 0) return sign + padded;
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return sign + (fraction ? `${whole}.${fraction}` : whole);
}

const DECIMAL38_PATTERN = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const DECIMAL38_SCALE = 1_000_000_000n;
const MAX_DECIMAL38_INPUT_LENGTH = 128;

export class DecimalOverflowError extends RangeError {
  readonly code = "decimal_overflow";

  constructor() {
    super("The exact decimal result exceeds DECIMAL(38,9).");
    this.name = "DecimalOverflowError";
  }
}

export function exactDecimal38_9(source: string): string | null {
  if (source.length > MAX_DECIMAL38_INPUT_LENGTH) return null;
  const match = DECIMAL38_PATTERN.exec(source);
  if (!match) return null;

  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent)) return null;

  const digits = (match[2]! + (match[3] ?? "")).replace(/^0+/, "");
  if (digits.length === 0) return "0";

  const significant = digits.replace(/0+$/, "");
  const trailingZeros = digits.length - significant.length;
  const scale = (match[3]?.length ?? 0) - exponent - trailingZeros;
  const integerDigits = Math.max(0, significant.length - scale);
  if (integerDigits > 29 || scale > 9) return null;

  const sign = match[1]!;
  if (scale <= 0) return sign + significant + "0".repeat(-scale);
  if (significant.length <= scale) {
    return `${sign}0.${"0".repeat(scale - significant.length)}${significant}`;
  }
  const point = significant.length - scale;
  const fraction = significant.slice(point);
  return `${sign}${significant.slice(0, point)}.${fraction}`;
}

function decimal38ToScaledInteger(value: string): bigint {
  if (!DECIMAL38_PATTERN.test(value)) throw new TypeError("Expected an exact decimal value.");
  const canonical = exactDecimal38_9(value);
  if (canonical === null) throw new DecimalOverflowError();
  const negative = canonical.startsWith("-");
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [whole, fraction = ""] = unsigned.split(".");
  const scaled = BigInt(whole!) * DECIMAL38_SCALE + BigInt(fraction.padEnd(9, "0") || "0");
  return negative ? -scaled : scaled;
}

function roundedQuotient(numerator: bigint, denominator: bigint): bigint {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const dividend = numerator < 0n ? -numerator : numerator;
  const divisor = denominator < 0n ? -denominator : denominator;
  let quotient = dividend / divisor;
  if ((dividend % divisor) * 2n >= divisor) quotient += 1n;
  return negative ? -quotient : quotient;
}

function scaledIntegerToDecimal(value: bigint): string {
  const negative = value < 0n;
  const unsigned = negative ? -value : value;
  const whole = (unsigned / DECIMAL38_SCALE).toString();
  if (whole.length > 29) throw new DecimalOverflowError();
  const fraction = (unsigned % DECIMAL38_SCALE).toString().padStart(9, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function averageDecimal(total: string, count: number): string | null {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Count must be a non-negative safe integer.");
  if (count === 0) return null;
  return scaledIntegerToDecimal(roundedQuotient(decimal38ToScaledInteger(total), BigInt(count)));
}

export function percentageDecimal(numerator: string, denominator: string): string | null {
  const numeratorScaled = decimal38ToScaledInteger(numerator);
  const denominatorScaled = decimal38ToScaledInteger(denominator);
  if (denominatorScaled === 0n) return null;
  return scaledIntegerToDecimal(roundedQuotient(numeratorScaled * 100n * DECIMAL38_SCALE, denominatorScaled));
}
