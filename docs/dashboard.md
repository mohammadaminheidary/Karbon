# Dashboard

The home page (`/index.html`) reports on Karbon's existing SQLite data through authenticated `GET /api/dashboard`. No sample records, secondary ledger, new tables, or runtime dependencies are introduced. The existing Persian RTL layout, Vazirmatn font, color palette, and floating navigation are retained.

## Sources and definitions

| Report | Source and calculation |
| --- | --- |
| Revenue / expenses | Undeleted `financial_transactions`, grouped by `transaction_date`. Order receipts and document rows are already in this ledger and are counted once. |
| Net cash flow | Period revenue minus period expenses. This is not accounting profit; the project has no cost-of-goods model. |
| Sales | Undeleted orders: `subtotal - discount`, grouped by `invoice_date`. This is separate from money received. |
| Receivables | Each undeleted invoice total minus its undeleted linked receipts, floored at zero per invoice. Current receivables cover all invoices, independent of the selected date range. Overdue means `payment_date < today` in the configured application timezone. |
| Inventory | Undeleted tracked products: sum of current `stock * price`, including inactive products that still hold inventory. `stock = NULL` denotes an untracked item/service and is excluded. This is current selling-price value, not acquisition cost. |
| Banks | Nondeleted accounts, including inactive accounts and the cash drawer: opening balance plus all undeleted income minus expenses. No bank account numbers are sent by the dashboard endpoint. |
| Customers | Current nondeleted customer count, new registrations by creation date converted from UTC into the application timezone, and current debtors. |
| Product sales | Saved invoice item quantity and historical unit price, grouped by product/name/unit. Gross values precede invoice-wide discounts; these discounts are not arbitrarily allocated to products. |
| Tasks | Count by scheduled date and current status. Completion describes the current state of tasks scheduled for that date, not a historical completion event. |
| Attendance | Daily explicitly recorded present and absent entries; attendance rate uses recorded entries only. An unrecorded day is not an absence. Current members and today's recorded presence are separate snapshot metrics. |
| Documents | Nondeleted documents by document date and type. Their ledger amounts are already included in revenue/expenses. |

The project has no stock movement or inventory price history. The top inventory chart therefore displays **current value by product**, with quantity and unit price in its tooltip. It does not reconstruct or fabricate past inventory values. Bank balances, outstanding debt, current members, total customers, and inventory remain current when selecting historical report dates. The UI labels these snapshot metrics accordingly.

## API and consistency

Optional ISO `start_date` and `end_date` select an inclusive interval of up to 366 days. The default is the last 30 days ending today in `APP_TIMEZONE`. Rolling ranges send `days=7/30/90/365`, so the server resolves the current date independently of the browser clock. A previous interval of equal length supports comparisons. Daily zero buckets mean no matching records exist; a failed request never becomes a zero report. All aggregates use the underlying tables rather than paginated list responses.

An explicit SQLite read transaction makes the report internally consistent even if another connection writes during generation. The endpoint is read-only, uses existing authentication/error handling, and sets `Cache-Control: no-store`. Monetary values are decimal strings and the UI formats them with `BigInt`, preserving exact values above JavaScript's safe integer range. Only SVG coordinates and abbreviated axis labels use floating point.

## Interaction and refresh

Bar and line charts support exact hover/tap inspection, click-to-pin, zoom buttons, Ctrl/Command + wheel zoom, mouse drag to pan, independently adjustable start/end sliders, and complete data tables. Focus the plot and use left/right arrows or Home/End to inspect; +/− zoom and Escape resets. The expense-share doughnut supports pointer and keyboard inspection and a complete data table; its percentages are calculated from actual expense totals. Blue gradients based on Karbon’s Persian blue, rounded bar caps, subdued axes, circular KPI icons, and blue tooltips retain the visualization styling of the supplied [visual reference](https://cdn.dribbble.com/userupload/14595440/file/original-049d10b591be129d39d5048b49a40b0c.png?resize=1024x768&vertical=center).

## Layout editor

All 18 widgets (12 charts, four KPIs, receivables, and follow-up items) share a single grid. Choose **ویرایش چیدمان** to reveal drag handles and resize corners. Drag the top handle to move a widget and its lower-left corner to resize it in the RTL layout. The handles also accept arrow keys. Neighbouring widgets move down when cells become occupied, and widget dimensions snap to the grid. Escape cancels an active pointer gesture. The editor includes Save, Cancel, and Reset this view actions.

The grid uses 12 columns on desktop (at least 1150px), eight on tablet (700–1149px), and four on mobile. Each view has an independent saved layout, so mobile edits preserve desktop positions. Save writes versioned, validated geometry to browser local storage under the signed-in username; no token or report data is stored in the layout preferences. Preferences are local to that account and browser. A storage failure keeps the editor open with a visible retry message. Invalid or outdated layouts fall back to safe defaults.

The SVGs recalculate both dimensions using ResizeObserver, including while dragging a resize corner. Widget container queries adapt typography and controls. Axes account for label widths, large monetary labels can use scientific notation when necessary, and exact values remain available in tooltips/tables. Content-based minimum heights protect labels, legends, and controls; tables and longer legends scroll within their assigned area. Expanding a data table can grow the widget and push neighbours down. Current widget nodes are retained during data refreshes, preserving editing controls, saved geometry, and chart interaction state.

Reports refresh on Karbon's existing data-change events, cross-tab storage changes, focus/visibility restoration, manual refresh, and every 30 seconds while visible. Polling bypasses the API cache and covers changes made outside the frontend. Superseded requests are aborted; older results cannot overwrite a newer filter. Failed background refreshes preserve the last successful report and mark it as stale, with a retry action.

## Verification

```sh
npm exec -- tailwindcss -i ./src/input.css -o ./src/output.css
python3 -m unittest discover -s tests -v
for file in tests/test_*.cjs; do node "$file" || exit 1; done
```

The dashboard integration tests use a disposable SQLite database and the actual authenticated HTTP API. They cover money reconciliation, partial payments, discounts, deleted invoices/documents/receipts, stock restoration, inactive inventory, values above JavaScript's safe integer range, UTC/Tehran date boundaries, leap-year ranges, unrecorded attendance, and datasets exceeding page limits.

For browser checks, start the isolated fixture, then run the test with an installed Playwright and Chromium (or supply `KARBON_PLAYWRIGHT_PATH` / `KARBON_CHROME_PATH`):

```sh
python3 tests/serve_customers_fixture.py --backend-port 8026 --frontend-port 5526 --customers 25 --bank-ledger 25 --orders --members 3
node tests/dashboard_browser.mjs
```

Only the fixture database receives test records. Browser checks cover all 12 charts, exact totals, zoom/pan/wheel, pinned selection, keyboard inspection, tables, custom dates, request races, cross-tab mutation refresh, periodic polling, initial errors, retry, and widths 390/768/1024/1440/1920. Desktop/mobile screenshots are saved under `/tmp/karbon-dashboard-*.png`.

Layout geometry checks run with `node tests/test_dashboard_layout.cjs`. They cover all breakpoints, occupied-cell moves, boundary clamping, 3,600 random move/resize operations, round-trip restoration, and corrupted storage. Browser verification also covered all 18 widgets at minimum sizes, pointer movement/resizing, keyboard editing, save/reload persistence, mobile/desktop isolation, cancellation, default reset, chart inspection after resizing, open data tables, live refresh while retaining geometry, and widths 320/390/768/1024/1150/1440/1920. No widget overlap, page overflow, surface overflow, or clipped SVG labels was found. A real fixture product valued above JavaScript's safe integer range also retained exact display and fitting axis labels at the smallest desktop chart width.
