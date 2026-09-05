const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/u;

export const X18 = 10n ** 18n;
export const ONE_MILLION = 1_000_000n;

export function parseUnsignedDecimalX18(value: string, field: string): bigint {
  const match = DECIMAL.exec(value);
  if (match === null) throw new Error(`${field} is not an unsigned decimal`);
  const fraction = match[2] ?? "";
  if (fraction.length > 18) {
    throw new Error(`${field} has more than 18 decimal places`);
  }
  return BigInt(match[1]!) * X18 + BigInt(fraction.padEnd(18, "0") || "0");
}

export function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function signedPpm(value: bigint, reference: bigint): bigint {
  if (reference <= 0n) throw new Error("PPM reference must be positive");
  return (value - reference) * ONE_MILLION / reference;
}

export function deviationPpm(value: bigint, reference: bigint): bigint {
  return absolute(signedPpm(value, reference));
}

export function percentile(
  values: readonly bigint[],
  numerator: number,
): bigint | null {
  if (values.length === 0) return null;
  if (!Number.isInteger(numerator) || numerator < 1 || numerator > 100) {
    throw new Error("Percentile must be between 1 and 100");
  }
  const sorted = [...values].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return sorted[Math.ceil(sorted.length * numerator / 100) - 1]!;
}
