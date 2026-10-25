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
