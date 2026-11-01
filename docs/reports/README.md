# Database-driven reports

The chart icon in the shared navbar navigates to the standalone **گزارش و خروجی**
page (`/page/reports-page.html`). Its right-side **گزارش جدید** action opens the
existing `NavbarPanelDialog` slide-up export panel. Customers, orders, order
items/payments, financial transactions, bank accounts/directory, expense
categories, products, inventory reference lists, documents/accounts, members,
attendance and tasks are supported (15 datasets).

## Saved history

Every successful export is stored automatically, before its download response,
in the internal `generated_reports` SQLite table. Startup creates this table
without changing business tables or deleting existing history. The generated
file and metadata commit in one transaction; a generation/storage failure
leaves no partial entry. Each account sees only its own reports, newest first,
with pagination and authenticated downloads. History is excluded from the
reportable dataset allowlist. Names are optional and default to the dataset
title; date/time is displayed in the Persian calendar and Tehran timezone.

History preserves the original PDF/XLSX bytes, selected query parameters,
record/column counts and size. A later download never re-runs the query, and
remains unchanged after source data edits. Files live inside the configured
SQLite database, so database backups include report history; storage grows
with the generated files. List queries omit file content. The page refreshes
after generation, on browser history restoration, and when a tab becomes
visible; manual refresh also supports retry after connection failures.

Report cards link to `/page/report-details-page.html?id=…`, which displays the
saved metadata and provides the original download and a delete action. Deletion
uses the shared `CurtainDialog` confirmation with cancel focus, a pending guard,
and an inline retryable error. Only the report owner can read its details or
delete it; successful deletion removes that report and its stored file without
changing business data. The list header shows the total report count, updated
after generation/deletion and synchronized between tabs through the existing
data-change mechanism. Refresh uses an accessible icon and tooltip.

Report IDs are positive integers, unique across all active reports and all
accounts. The database primary key enforces uniqueness. After rendering finishes,
allocation reserves SQLite's writer with `BEGIN IMMEDIATE`, finds the smallest
unused positive ID, and saves the file and metadata in the same transaction.
Deletion uses the same write reservation; its ID is released only at commit.
Failed operations roll back without reserving an unused ID or releasing an
active one. Existing IDs and files are preserved without a schema migration.
Cards and details display the assigned ID. The history tests exercise gap reuse,
concurrent generation/deletion, cross-account uniqueness, and rollback behavior.

The larger right navbar and its label-wrapping rules are scoped to the
`.reports-page` body on the list page. Shared navbar CSS retains its original
width, layout, and styling, including on the report details page. Browser checks
verify unchanged desktop/mobile navbars on the other business modules.

Exports made by older versions were temporary downloads and were deleted
from the server after delivery. There is no existing server archive to migrate
or recover; files already downloaded to a user's device remain there.

There is currently no production table or inventory-movement table. Warehouse
reporting uses the actual `products` and `inventory_options` records; it does not
export the warehouse page's placeholder statistics. No production schema, stock
movement, category relationship on products, or other business data is invented.

## Data contract

- `services/report_service.py` reflects the actual connected SQLite database.
  The table allowlist defines report scope, never its columns. All real base
  columns are initially selected, including database columns absent from the
  ORM model. Persian labels are separate from original field names.
- Direct foreign keys retain their original values. Optional columns from the
  referenced business tables use names such as `customer_id.first_name`.
  LEFT JOINs preserve records with null foreign keys and do not multiply parent
  rows. One-to-many order items and payments are independent datasets with their
  original foreign keys; this avoids duplicating order amounts in reports.
- Passwords, auth/session records, biometric templates/photos and internal ID or
  test-data registries cannot be reported. All endpoints use existing auth.
- Previews and exports share the same query, filters and column validation.
  Date bounds support existing ISO dates and Persian `YYYY/MM/DD` input.
  Suggestions use real distinct values; foreign-key suggestions also search
  existing related names. Null and empty-string filters are distinct.
- Soft-deleted records are excluded by default and explicitly opt-in. Related
  historical records remain readable. Reporting never alters business tables,
  indexes or triggers. Its only additional storage is the internal
  generated-report history table.
- Selection persists across pages. “Select all” means every matching result,
  including unloaded pages; individual exclusions remain supported. Changing
  applied filters or datasets clears selection. Column changes preserve it.
  Exports can alternatively use all matching records without changing selection.
  The filter snapshot is re-evaluated at export time, so intervening business
  edits are reflected in the downloaded report.

## Files, fidelity and resource usage

PDF and XLSX contain exactly the requested fields and records in matching order.
PDF uses embedded Vazirmatn with HarfBuzz shaping and bidirectional text. Wide
reports use readable horizontal column bands. Repeated headings and page numbers
support pagination; long values continue onto additional pages without clipping.
XLSX has Persian headers and original field names, RTL view/alignment, frozen
headings, filters, explicit literal strings and typed date/numeric/boolean cells.
The bundled Vazirmatn font is embedded in PDF; Excel can use its own font fallback
if Vazirmatn is not installed on the viewing computer.

Neither PDF text nor Excel cells can represent every database type losslessly.
For this reason PDF includes `report-data.json`; XLSX contains a hidden
**داده خام** sheet with JSON schema and records. Its rows are
`[kind, record_index, chunk_index, JSON_chunk]`; concatenate chunks in index order
before parsing. This preserves JSON structures, null versus empty strings,
64-bit integers, submillisecond timestamps, original identifiers and values.
Integers beyond Excel's 15-digit precision are written as decimal text in the
visible sheet. Values longer than Excel's 32,767-character cell limit are visibly
marked as continued in the raw sheet, with a cell note; the complete value remains
in the raw sheet. These files are business exports, not restorable whole-database
backups, and contain no authentication or biometric data.

Preview pages contain 50 records (API maximum 200). Results are fetched in batches
of 200 into a spool with a 1 MiB memory threshold. The read snapshot/connection is
released before font shaping and file compression, allowing concurrent edits.
Files are generated in unique temporary paths, saved to history after successful
generation, then the temporary copies are deleted after the response. Files are
sent with `Cache-Control: no-store`. Errors also delete temporary output files.
The export limit is 50,000 records per file with an actionable filter message.
PDF's renderer necessarily retains its page content while constructing the PDF;
very large/long reports should use a narrower range or Excel.

## Setup and verification

```sh
python3 -m pip install -r backend/requirements.txt
npm --prefix frontend run build

# The PDF parser is needed only by the integration tests.
python3 -m pip install -r backend/requirements-dev.txt
python3 -m unittest discover -s backend/tests -p 'test_report*.py' -v
python3 -m unittest discover -s backend/tests -v
npm --prefix frontend test
python3 -m unittest discover -s frontend/tests -v
python3 frontend/scripts/build_navigation.py --check

# Playwright/Chromium are test tools, not application dependencies.
KARBON_PLAYWRIGHT_PATH=/path/to/playwright \
KARBON_CHROME_PATH=/path/to/chrome \
python3 frontend/tests/run_reports_browser.py
# Add --production to verify the built frontend/dist/ assets with the same fixture.
```

Every test creates disposable SQLite data. The report integration fixture seeds
1,000 records in **each** of the 15 datasets, exercises both formats with all base
fields, compares PDF JSON attachments and XLSX raw data record-by-record, and
checks selected rows/fields, empty results, pagination, nulls, typed values,
formula-like text, long Persian text, authentication, invalid filters, schema
preservation, each module's available filters, and concurrent edits.

On the development machine, the 1,000-record exports took approximately
0.09–0.26 seconds for XLSX and 0.8–6.6 seconds for PDF, including local HTTP and
file creation. These are synthetic development measurements, not production
latency guarantees. PDF rendering was visually reviewed with Poppler; exported
Excel values, types, style/RTL XML and a rendered range were inspected. Chromium
checks run against both development and built production assets and cover nine
module navigation to the history page, all 15 datasets, cross-page selection,
select-all exclusions, real file downloads, Persian date filtering, error/retry,
history metadata and unchanged downloads after reload, history refresh error/retry,
focus restoration, card details, confirmed deletion/cancel/error/retry, cross-tab
count updates, navbar labels at 320–1440px and 125% text, theme changes and
reduced motion. No native
Excel desktop application was used during verification.
