// Form estimates use the ledger's whole-toman units. Issuance recomputes the
// numbers under the write lock and verifies the settings revision.
const rateOf = (amount, basisPoints) => Number((BigInt(amount) * BigInt(basisPoints) + 5000n) / 10000n);

export function estimateInvoice(subtotal, defaults, override) {
  const discount = override ?? (defaults?.discount_kind === "percent" ? rateOf(subtotal, defaults.discount_value)
    : Math.min(subtotal, defaults?.discount_value ?? 0));
  const tax = defaults?.tax_enabled ? rateOf(Math.max(0, subtotal - discount), defaults.tax_rate) : 0;
  const shipping = defaults?.shipping ?? 0;
  return { discount, tax, shipping, total: subtotal - discount + tax + shipping };
}
