import assert from 'node:assert/strict';
import test from 'node:test';

import { euroCountries, workspaceCountry, workspaceCountryDefaults, workspaceCountryLocale } from '../src/aws/shared/workspaceCountry.js';

test('legacy UK workspaces retain their GBP, VAT and mileage defaults', () => {
  assert.equal(workspaceCountry(undefined), 'GB');
  assert.deepEqual(workspaceCountryDefaults('GB'), {
    baseCurrency: 'GBP', defaultTaxRate: '20% Standard', mileageRate: 0.45,
  });
  assert.equal(workspaceCountryLocale('GB'), 'en-GB');
});

test('US, Australia and Canada use distinct currencies and review defaults', () => {
  assert.deepEqual(['US', 'AU', 'CA'].map((country) => workspaceCountryDefaults(workspaceCountry(country))), [
    { baseCurrency: 'USD', defaultTaxRate: 'Review sales tax', mileageRate: 0 },
    { baseCurrency: 'AUD', defaultTaxRate: 'Review GST', mileageRate: 0 },
    { baseCurrency: 'CAD', defaultTaxRate: 'Review GST/HST', mileageRate: 0 },
  ]);
});

test('every supported euro country uses EUR without assuming a shared VAT law', () => {
  assert.equal(euroCountries.length, 27);
  for (const country of euroCountries) {
    assert.equal(workspaceCountry(country), country);
    assert.equal(workspaceCountryDefaults(country).baseCurrency, 'EUR');
  }
  assert.equal(workspaceCountryDefaults('IE').defaultTaxRate, 'Review local VAT');
  assert.equal(workspaceCountryDefaults('ME').defaultTaxRate, 'Review local tax');
});
