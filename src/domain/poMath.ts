/** Money is cents. Half-up, away from zero, so 10% of 3333.33 is 333.33. */
export function roundMoney(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 100 + 1e-8)) / 100;
}

export function grossFromPercent(currentAmount: number, pctComplete: number, priorGross: number): number {
  return roundMoney(currentAmount * (pctComplete / 100) - priorGross);
}
