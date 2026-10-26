const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function formatUserCredits(value: string): string {
  return numberFormat.format(Number(value));
}
