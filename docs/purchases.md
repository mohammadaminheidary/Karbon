# Product purchases

Open **انبار → خرید کالا** to use the registration and payment dialogs shared
with **ایجاد سفارش**. Select an optional supplier and choose a warehouse category
inside each row's product picker. The picker shows the number of eligible products
per category and supports searching by name, brand or product code. Add rows for
products from any warehouse category. The file `warehouse-page.html#purchase`
opens the registration dialog directly.

Enter quantities and unit purchase prices, then choose a fixed or percentage
discount. Row subtotals and the invoice total update as you edit. Incomplete rows
block proceeding to **پرداخت**. The payment dialog offers **ویرایش فاکتور** to
return to your entries and **پرداخت نهایی** to save and open the issued invoice.

Manage warehouse categories in **تنظیمات → انبار → دسته‌بندی انبار کالا** and
register products in **تنظیمات → انبار → کالا (انبار)**. Warehouse and sales products
have separate records. The same name and brand may exist once in each catalog.
The purchase picker offers active warehouse products with warehouse categories
and enabled units.
Warehouse eligibility is independent of sales stock tracking. Selecting a product
fills its read-only unit.
Services with untracked (`NULL`) stock retain their existing sales behavior.

Saving an invoice posts all row quantities to the warehouse scope of the append-only
inventory journal in the same SQLite transaction that creates its receipt and line items.
Warehouse balances are calculated from that scope. Repeated products are aggregated
before checking stock limits. The invoice stores purchase prices, the optional
discount and notes, and the calculated total. Purchase entries affect warehouse stock.

The invoice and payment dialogs show the total, discount, paid amount, remaining
balance and payment status. The payment amount starts at zero. Optional payments
can use one or more source bank accounts or the existing cash account. Each payment creates an expense in the shared ledger
and reduces its source account balance. A purchase saved without payments adds to
warehouse stock and opens a payable for the remaining amount. The dashboard shows
purchase expenses in the selected date range and supplier obligations as of the
end of that range. Both reports link to the related invoice.

Open **فاکتورهای خرید** from the warehouse to view purchase invoices, including
invoices from earlier fiscal periods. Edit or cancel a purchase in the
open fiscal period. An edit keeps the receipt number and posts the reversal and
replacement together. Cancellation removes the purchased quantity and keeps
the original receipt for history. Stock balances can be negative.
Open **گردش موجودی** beside a warehouse product to see posted entries.
Open **نمایش فاکتور خرید** to view, add, edit or delete payments. Editing a payment
updates the original linked expense. Deleting a payment uses password confirmation.
Cancelling an open receipt also reverses its posted payments. Payments from a closed
fiscal year remain locked, and outstanding receipts can receive new payments in the
active year.

## Persistence and compatibility

- `POST /api/purchases` accepts a UUID `request_id`, Jalali `purchase_date`,
  and a `rows` array (1–100 items). Each row has `category_id`, `product_id`,
  integer `quantity` and integer `purchase_price`. An optional whole-toman `discount`
  overrides the configured default and `description` stores up to 1,000 characters.
  Older single-row payloads remain
  accepted, including retries of receipts created before the line-item upgrade.
  The warehouse screen sends warehouse category IDs. Legacy clients can still
  send the product category ID.
  The optional `unit` must match the product's configured unit.
- An optional `payments` array posts initial payments in the same transaction.
  Later payments use `POST /api/purchases/{id}/payments`. Editing uses
  `PUT /api/purchases/{id}/payments/{payment_id}` with the payment revision, and
  deletion uses the same path with password confirmation. Payment creation and
  editing accept a UUID to support safe retries. Invoice balances are calculated
  from live expense entries.
- `PUT /api/purchases/{id}` accepts the same rows with the current receipt `revision`.
  `DELETE /api/purchases/{id}` uses the existing password confirmation contract.
- `GET /api/purchases/next-number` previews a number; `GET /api/purchases/{id}`
  retrieves the saved receipt, ordered `rows` with individual `total` amounts,
  `row_count`, `total_quantity`, invoice `total` and historical product/category/unit names.
- `GET /api/purchases?history=true` includes invoices from past fiscal periods.
  `GET /api/inventory/products` and `GET /api/inventory/movements` expose warehouse balances and movements.
- Quantities must be 1–1,000,000, prices nonnegative, receipt totals at most
  999,999,999,999 and resulting stock at most 1,000,000,000. Exact calendar and
  reference validation runs on the server. Every endpoint requires authentication.
- A unique request ID, payload fingerprint, unique receipt number and serialized
  transaction prevent duplicate receipts and stock changes on concurrent retries.
  An uncertain browser request is retained in session storage for its authenticated
  session. Reloading can retry that exact purchase in the payment dialog.
- Purchase references protect products from deletion; deactivation remains available.
- The warehouse migration copies existing category names and hierarchy into the
  warehouse catalog and links existing products once. Previous receipt category
  IDs and names are retained. Confirmed deletion clears warehouse assignments,
  and the deleted category's ID remains available to historical receipts.
  Backups include both catalogs and assignments.
- The catalog split creates warehouse records for existing warehouse products.
  It rekeys warehouse movements to those records and retains the original
  identifiers and snapshots on issued invoices.
- The stock split carries forward current per-product balances and imports recorded
  purchase movements once. Legacy receipts without a journal entry provide the
  latest recorded quantities. Earlier sales and their journal remain intact.
  SQLite backups preserve receipts and both journal scopes.
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

Backend coverage includes `test_purchases.py`, `test_purchase_migration.py`,
`test_purchase_payments.py` and `test_backup.py`. Temporary SQLite fixtures cover
independent inventory and sales, bank and cash payments, later settlements, expense
reports, rollback, concurrent retries, legacy upgrades and backup restoration.

Browser checks use the existing disposable fixture:

```sh
python3 frontend/tests/serve_customers_fixture.py --backend-port 8047 --frontend-port 5547 --orders --finance --customers 2
KARBON_TEST_URL=http://127.0.0.1:5547 node frontend/tests/purchase_workflow_browser.mjs
KARBON_TEST_URL=http://127.0.0.1:5547 node frontend/tests/purchase_transition_browser.mjs
KARBON_TEST_URL=http://127.0.0.1:5547 node frontend/tests/purchase_finance_browser.mjs
```

Set `KARBON_PLAYWRIGHT_PATH` and optionally `KARBON_CHROME_PATH` to installed
Playwright/Chrome locations. Workflow checks cover multiple warehouse products,
percentage discounts, form retention between payment and editing, and a lost save
response followed by a reload and retry. Transition checks compare purchase and
sales registration animations, payment layout, mobile sizing and browser history.
