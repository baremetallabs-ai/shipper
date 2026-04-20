function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

export function formatCompactTokens(total: number): string {
  if (total < 1_000) {
    return String(total);
  }

  if (total < 1_000_000) {
    return `${trimTrailingZero((total / 1_000).toFixed(1))}k`;
  }

  return `${trimTrailingZero((total / 1_000_000).toFixed(1))}M`;
}
