const FRANKFURTER_ECB_URL = 'https://api.frankfurter.dev/v2/rate';

export type ExchangeRateQuote = {
  rate: number;
  rateDate: string;
  provider: 'ECB';
};

// ECB reference rates are a documented fallback, not a substitute for a card's settlement rate.
export async function getHistoricalExchangeRate(input: {
  fromCurrency: string | null;
  toCurrency?: string;
  documentDate: string | null;
}): Promise<ExchangeRateQuote | null> {
  const from = input.fromCurrency?.trim().toUpperCase();
  const to = (input.toCurrency ?? 'GBP').trim().toUpperCase();
  if (!from || from === to) {
    return from ? { rate: 1, rateDate: input.documentDate ?? new Date().toISOString().slice(0, 10), provider: 'ECB' } : null;
  }

  const date = input.documentDate?.slice(0, 10);
  const url = new URL(`${FRANKFURTER_ECB_URL}/${encodeURIComponent(from)}/${encodeURIComponent(to)}`);
  url.searchParams.set('providers', 'ECB');
  if (date) url.searchParams.set('date', date);
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) return null;
  const payload = (await response.json()) as { rate?: unknown; date?: unknown };
  const rate = Number(payload.rate);
  const rateDate = typeof payload.date === 'string' ? payload.date.slice(0, 10) : date;
  return Number.isFinite(rate) && rate > 0 && rateDate ? { rate, rateDate, provider: 'ECB' } : null;
}
