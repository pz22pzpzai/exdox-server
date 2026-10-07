export type SplitMode = 'none' | 'percentage' | 'fixed';
export type SplitPart = { category: string; value: number };
export type AllocationLine = { category: string; netAmount: number };

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
