export type SplitMode = 'none' | 'percentage' | 'fixed';
export type SplitPart = { category: string; value: number };
export type AllocationLine = { category: string; netAmount: number; description?: string; taxRateApplied?: string | null };
export type GroupMode = 'none' | 'description' | 'tax';
export type LineItemGroup = { name: string; matchText: string; category: string };

export function validateLineItemGroups(mode: GroupMode, groups: LineItemGroup[]): void {
  if (!['none', 'description', 'tax'].includes(mode)) throw new Error('Choose a valid line-item grouping mode.');
  if (groups.length > 20 || groups.some((group) => !group.name.trim() || !group.matchText.trim() || !group.category.trim())) {
    throw new Error('Each line-item group needs a name, matching text and category (maximum 20 groups).');
  }
}

export function groupExtractedLineItems(input: {
  netAmount: number;
  defaultCategory: string;
  mode: GroupMode;
  groups: LineItemGroup[];
  items: Array<{ description: string; total: number | null; taxAmount: number | null }>;
}): AllocationLine[] {
  validateLineItemGroups(input.mode, input.groups);
  if (input.mode === 'none' || input.items.length === 0 || input.items.length > 100) return [];
  const expected = Math.round(input.netAmount * 100);
  if (!Number.isFinite(expected) || expected <= 0) return [];
  const buckets = new Map<string, { category: string; description: string; taxRateApplied: string | null; pence: number }>();
  let allocated = 0;
  for (const item of input.items) {
    if (!Number.isFinite(item.total) || item.total === null || item.total <= 0) return [];
    const grossPence = Math.round(item.total * 100);
    const taxPence = item.taxAmount === null ? 0 : Math.round(item.taxAmount * 100);
    const netPence = grossPence - taxPence;
    if (netPence <= 0 || taxPence < 0 || taxPence > grossPence) return [];
    allocated += netPence;
    const match = input.groups.find((group) => item.description.toLocaleLowerCase().includes(group.matchText.trim().toLocaleLowerCase()));
    const taxKey = item.taxAmount === null ? 'tax unknown' : `${Math.round(taxPence / netPence * 10000) / 100}% tax`;
    const taxPercent = Math.round(taxPence / netPence * 100);
    const taxRateApplied = item.taxAmount === null ? null : taxPercent === 20 ? '20% Standard' : taxPercent === 5 ? '5% Reduced' : taxPercent === 0 ? '0% Zero' : null;
    const description = match?.name ?? (item.description.trim() || 'Line item');
    const key = input.mode === 'tax' ? taxKey : `${description}|${taxKey}`;
    const category = match?.category ?? input.defaultCategory;
    const bucket = buckets.get(key);
    if (bucket && (bucket.category !== category || bucket.taxRateApplied !== taxRateApplied)) return [];
    if (bucket) bucket.pence += netPence;
    else buckets.set(key, { category, description: input.mode === 'tax' ? taxKey : description, taxRateApplied, pence: netPence });
  }
  if (allocated > expected + 2) return [];
  if (buckets.size > 20) return [];
  const result: AllocationLine[] = [...buckets.values()].map((bucket) => ({ category: bucket.category, description: bucket.description, taxRateApplied: bucket.taxRateApplied, netAmount: bucket.pence / 100 }));
  const remaining = expected - allocated;
  if (remaining < 0) {
    if (result.length === 0 || result[result.length - 1].netAmount * 100 + remaining <= 0) return [];
    result[result.length - 1].netAmount = (Math.round(result[result.length - 1].netAmount * 100) + remaining) / 100;
  } else if (remaining > 0) {
    if (result.length >= 20) return [];
    result.push({ category: input.defaultCategory, description: 'Unallocated document balance', netAmount: remaining / 100 });
  }
  return result;
}

export function validateSplitRule(mode: SplitMode, parts: SplitPart[]): void {
  if (mode === 'none') {
    if (parts.length) throw new Error('Choose a split mode before adding allocations.');
    return;
  }
  if (!['percentage', 'fixed'].includes(mode) || !parts.length || parts.length > 20) throw new Error('Add 1 to 20 split allocations.');
  if (parts.some((part) => !part.category.trim() || !Number.isFinite(part.value) || part.value <= 0 || Math.abs(Math.round(part.value * 100) - part.value * 100) > 0.00001)) {
    throw new Error('Each split needs a category and a positive value with at most two decimals.');
  }
  if (mode === 'percentage' && Math.round(parts.reduce((sum, part) => sum + part.value, 0) * 100) !== 10000) {
    throw new Error('Percentage allocations must total 100%.');
  }
}

export function calculateAllocations(netAmount: number, baseCategory: string, mode: SplitMode, parts: SplitPart[]): AllocationLine[] {
  validateSplitRule(mode, parts);
  const totalPence = Math.round(netAmount * 100);
  if (!Number.isFinite(netAmount) || totalPence < 0) throw new Error('A valid net amount is needed for a split.');
  if (mode === 'none') return [];
  let used = 0;
  const lines = parts.map((part, index) => {
    const pence = mode === 'percentage'
      ? index === parts.length - 1 ? totalPence - used : Math.round(totalPence * part.value / 100)
      : Math.round(part.value * 100);
    used += pence;
    return { category: part.category.trim(), netAmount: pence / 100 };
  });
  if (used > totalPence) throw new Error('Fixed allocations exceed the document net amount.');
  if (used < totalPence) lines.push({ category: baseCategory, netAmount: (totalPence - used) / 100 });
  return lines.filter((line) => line.netAmount > 0);
}

export function suggestApprovedCategory(vendor: string | null, history: Array<{ vendorName: string | null; category: string | null; status: string }>): string | null {
  const name = vendor?.trim().toLocaleLowerCase();
  if (!name) return null;
  const matching = history.filter((item) => item.vendorName?.trim().toLocaleLowerCase() === name && ['Ready', 'Published', 'Paid'].includes(item.status) && item.category && item.category !== 'Uncategorised');
  if (matching.length < 2) return null;
  const counts = new Map<string, number>();
  for (const item of matching) counts.set(item.category!, (counts.get(item.category!) ?? 0) + 1);
  const [category, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return count >= 2 && count / matching.length >= 0.8 ? category : null;
}
