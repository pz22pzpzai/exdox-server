export const euroCountries = ['AT', 'BE', 'BG', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES', 'AD', 'MC', 'SM', 'VA', 'XK', 'ME'] as const;
export type WorkspaceCountry = 'GB' | 'US' | 'AU' | 'CA' | typeof euroCountries[number];

export function workspaceCountry(value: unknown): WorkspaceCountry {
  return value === 'US' || value === 'AU' || value === 'CA' || euroCountries.includes(value as typeof euroCountries[number]) ? value as WorkspaceCountry : 'GB';
}

export function workspaceCountryDefaults(country: WorkspaceCountry) {
  switch (country) {
    case 'US': return { baseCurrency: 'USD', defaultTaxRate: 'Review sales tax', mileageRate: 0 };
    case 'AU': return { baseCurrency: 'AUD', defaultTaxRate: 'Review GST', mileageRate: 0 };
    case 'CA': return { baseCurrency: 'CAD', defaultTaxRate: 'Review GST/HST', mileageRate: 0 };
    case 'GB': return { baseCurrency: 'GBP', defaultTaxRate: '20% Standard', mileageRate: 0.45 };
    default: return { baseCurrency: 'EUR', defaultTaxRate: euroCountries.slice(0, 21).includes(country as typeof euroCountries[number]) ? 'Review local VAT' : 'Review local tax', mileageRate: 0 };
  }
}

export function workspaceCountryLocale(country: WorkspaceCountry) {
  const locales: Partial<Record<WorkspaceCountry, string>> = {
    GB: 'en-GB', US: 'en-US', AU: 'en-AU', CA: 'en-CA', IE: 'en-IE',
    AT: 'de-AT', BE: 'nl-BE', BG: 'bg-BG', HR: 'hr-HR', CY: 'el-CY',
    EE: 'et-EE', FI: 'fi-FI', FR: 'fr-FR', DE: 'de-DE', GR: 'el-GR',
    IT: 'it-IT', LV: 'lv-LV', LT: 'lt-LT', LU: 'fr-LU', MT: 'mt-MT',
    NL: 'nl-NL', PT: 'pt-PT', SK: 'sk-SK', SI: 'sl-SI', ES: 'es-ES',
  };
  return locales[country] ?? 'en-GB';
}
