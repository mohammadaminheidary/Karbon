# Product purchases

Open **انبار → خرید کالا** (`warehouse-page.html#purchase`). The date defaults to
today in Tehran's Persian calendar and can be edited using Persian, Arabic or
Latin digits. The final receipt uses a server-generated number such as
`PUR-000001`. The displayed number before saving is a preview; concurrent saves
may receive a different final number.

Rows use the same sheet, sticky table headers, cell styling, add button and ×
remove action as **ثبت سند**. Each horizontal row follows RTL reading order:
category, product, quantity, unit, purchase price, total price. Small screens scroll
within the sheet. Adding a row focuses its category; removing one focuses the next
row, or the previous row when removing the last. At least one row remains and
invoices support at most 100 rows. Row totals, total quantity, row count and invoice
amount update immediately. Incomplete or invalid rows block saving.

Categories come
from **تنظیمات → انبار**; each product's category and unit are selected in
**تنظیمات → کالاها**. Product choices are restricted to the selected active
category and active, stock-tracked products with enabled units. The unit is read-only.
Services with untracked (`NULL`) stock retain their existing sales behavior.

Saving an invoice adds all row quantities to `products.stock` and increments each
affected product revision in the same SQLite transaction that creates its receipt
and line items. Repeated products are aggregated before checking stock limits.
Purchase price is recorded on the receipt; the product's sales price is preserved.
This form has no payment fields and does not post a financial payment.

## Persistence and compatibility

- `POST /api/purchases` accepts a UUID `request_id`, Jalali `purchase_date`,
  and a `rows` array (1–100 items). Each row has `category_id`, `product_id`,
  integer `quantity` and integer `purchase_price`. Older single-row payloads remain
  accepted, including retries of receipts created before the line-item upgrade.
- `GET /api/purchases/next-number` previews a number; `GET /api/purchases/{id}`
  retrieves the saved receipt, ordered `rows` with individual `total` amounts,
  `row_count`, `total_quantity`, invoice `total` and historical product/category/unit names.
- Quantities must be 1–1,000,000, prices nonnegative, receipt totals at most
  999,999,999,999 and resulting stock at most 1,000,000,000. Exact calendar and
  reference validation runs on the server. Every endpoint requires authentication.
- A unique request ID, payload fingerprint, unique receipt number and serialized
  transaction prevent duplicate receipts and stock changes on concurrent retries.
  An uncertain browser request is retained in session storage for its authenticated
  session. Reloading can retry that exact purchase; **فرم جدید** becomes available
  after the result is confirmed. Confirmed receipts cannot be resubmitted from the form.
- Purchase references protect products from deletion; deactivation remains available.
- Startup adds `products.category_id` and the `purchases` table. A one-time migration
  assigns existing products to the Settings category **عمومی**, preserving stock,
  units, prices, order history and invoice snapshots. Older product API clients
  that omit a category retain the product's category or use the existing **عمومی**
  category. They must select a category explicitly if that fallback is unavailable.
  Restarts preserve subsequent category choices and activation settings. A second
  migration adds `purchase_items` and copies each historical receipt into its first
  row without replaying inventory movements or changing invoice numbers. Existing
  receipt columns remain intact for compatibility.

## Verification

Backend coverage is in `test_purchases.py` and `test_purchase_migration.py`, using
temporary SQLite databases. It includes exact date validation, persistence,
sales using purchased stock, concurrency, idempotency, rollback, catalog changes,
authentication, deletion protection and legacy upgrades.

Browser checks use the existing disposable fixture:

```sh
python3 frontend/tests/serve_customers_fixture.py --backend-port 8047 --frontend-port 5547 --orders --customers 2
KARBON_TEST_URL=http://127.0.0.1:5547 node frontend/tests/purchase_workflow_browser.mjs
KARBON_TEST_URL=http://127.0.0.1:5547 node frontend/tests/purchase_transition_browser.mjs
```

Set `KARBON_PLAYWRIGHT_PATH` and optionally `KARBON_CHROME_PATH` to installed
Playwright/Chrome locations. Workflow checks create categories and products via
Settings, add/remove rows and check focus, verify calculations and validation,
purchase multiple products (including repeated products), verify stock and receipts, simulate a lost
save response followed by reload/retry, and check the field order and overflow
at widths 320, 390, 768, 1024 and 1440. Transition checks retain existing animation,
history, reduced-motion, slow-reference-loading and form-retention coverage.
