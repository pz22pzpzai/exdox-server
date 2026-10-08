import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateAllocations, groupExtractedLineItems, suggestApprovedCategory } from '../src/aws/shared/documentAutomation.js';

test('percentage split keeps the exact net amount through rounding', () => {
  assert.deepEqual(calculateAllocations(10.01, 'Other', 'percentage', [
    { category: 'Travel', value: 50 }, { category: 'Meals', value: 50 },
  ]), [{ category: 'Travel', netAmount: 5.01 }, { category: 'Meals', netAmount: 5 }]);
});

test('fixed split leaves a remainder and rejects an over-allocation', () => {
  assert.deepEqual(calculateAllocations(10, 'Other', 'fixed', [{ category: 'Travel', value: 3.25 }]), [
    { category: 'Travel', netAmount: 3.25 }, { category: 'Other', netAmount: 6.75 },
  ]);
  assert.throws(() => calculateAllocations(10, 'Other', 'fixed', [{ category: 'Travel', value: 11 }]), /exceed/);
});

test('learning requires two approved matching supplier decisions and consensus', () => {
  const history = [
    { vendorName: 'Example Store', category: 'Travel', status: 'Ready' },
    { vendorName: 'example store', category: 'Travel', status: 'Published' },
    { vendorName: 'Example Store', category: 'Meals', status: 'Review' },
  ];
  assert.equal(suggestApprovedCategory('EXAMPLE STORE', history), 'Travel');
  assert.equal(suggestApprovedCategory('Other Store', history), null);
  assert.equal(suggestApprovedCategory('Example Store', history.slice(0, 1)), null);
});

test('extracted lines group by configured descriptions and preserve exact net', () => {
  assert.deepEqual(groupExtractedLineItems({
    netAmount: 15,
    defaultCategory: 'Other',
    mode: 'description',
    groups: [{ name: 'Travel', matchText: 'ticket', category: 'Travel' }],
    items: [
      { description: 'Train ticket', total: 6, taxAmount: 1 },
      { description: 'Bus ticket', total: 12, taxAmount: 2 },
    ],
  }), [{ category: 'Travel', description: 'Travel', taxRateApplied: '20% Standard', netAmount: 15 }]);
});

test('unreconciled extracted lines stay out of automatic posting', () => {
  assert.deepEqual(groupExtractedLineItems({
    netAmount: 5,
    defaultCategory: 'Other',
    mode: 'tax',
    groups: [],
    items: [{ description: 'Wrong total', total: 20, taxAmount: 0 }],
  }), []);
});
