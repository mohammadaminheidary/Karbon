# Configurable inventory units

Implemented in Settings → Units (`واحد`), a standalone sidebar section alongside Inventory (`انبار`) and Products (`کالاها`).

## Standalone Units navigation update

- Added the **واحد** sidebar item as a sibling of **انبار** and **کالاها**, with its own `#units` route, `settings-panel-units` panel, labelled heading, status and refresh control. The overview also has a Units shortcut.
- Moved search, selected-unit count, custom-unit creation and checkboxes into the dedicated panel. Inventory now contains categories only.
- Registered `units` with the existing settings router and initialization lifecycle. Both sections retain existing save, refresh and change-notification behavior.
- Product settings help links directly to `#units`. Purchase entry exposes separate Inventory/category and Units links. Validation guidance points users to the new section.
- Database storage, APIs, enabled-unit rules, existing selections, legacy retention and centralized product/purchase/order behavior remain unchanged. No database migration is required for this navigation update.

Files updated for this navigation change:

- `frontend/page/settings-page.html`: sidebar, overview, separated panels and product help link.
- `frontend/src/js/page/settings.js`: section registration and initialization.
- `frontend/src/js/warehouse/inventory-settings.js`: status, refresh, mutation and visible-panel handling across both sections.
- `frontend/src/inventory-settings.css`: single-column layouts for separate sections.
- `frontend/page/warehouse-page.html`: category and unit settings links.
- `frontend/src/js/orders/order-dialogs.js` and `backend/services/inventory_service.py`: navigation guidance text only.
- `frontend/tests/configured_units_browser.mjs`, `frontend/tests/settings_browser.mjs`, `frontend/tests/warehouse_browser.mjs`: updated routes and standalone-section coverage.

Navigation-update validation results:

| Check | Result |
| --- | --- |
| Dedicated unit browser suite | Passed: sibling hierarchy, panel placement, accessible labels, direct `#units` route, keyboard Enter, overview shortcut, browser Back/Forward, reload, search, selection, persistence, failed-save recovery and centralized product/order/purchase behavior. |
| Full settings browser suite | Passed: all **12** sections at **320/390/768/1024/1440px**, settings CRUD and session/security flows. |
| Warehouse browser suite | Passed: Inventory/category link, separate Units section, saved configuration and purchase dropdown behavior. |
| Backend unit/settings/migration checks | **8 passed**; persistence, restart, disabled/legacy units and API validation unchanged. |
| Frontend Node suite | **82 passed**. |
| Frontend Python suite | **8 passed, 4 launcher tests skipped** because the user's existing service occupied port 8000; that service was left running. |
| Production build | Passed; **117** versioned assets. |
| Whitespace check | `git diff --check` passed. |

All browser and API tests used disposable databases.

## Behavior and data compatibility

- The existing `inventory_options` table remains the central source. Its unit rows are searchable checkboxes; each selection is saved immediately to SQLite through the existing authenticated settings API. Users can also add custom units.
- Startup seeds 15 common units and adopts distinct existing product/invoice-item units once. Existing selections take precedence. A migration marker prevents restarts from reseeding or re-enabling deselected units. Existing product and invoice values are not rewritten.
- New products and product unit changes require an enabled unit. Editing an existing product can retain its original disabled or legacy unit; that unit is explicitly labelled in its dropdown and is unavailable to other new records.
- New orders only offer active products with enabled units. Backend order creation independently checks the unit before any stock or financial mutations. Open order rows refresh when settings change in another tab, clearing an unavailable product's displayed unit and price.
- Saved order items and immutable invoice snapshots keep their original unit strings. Existing order retries, completion, payments, stock restoration, deletion protection, and reporting remain compatible.
- Unit names used by a product or invoice cannot be renamed; they can be disabled. A replacement unit can be added separately. Legacy Arabic/Persian spelling and whitespace normalization allow toggling and retaining old units without rewriting stored strings.
- An empty unit selection is valid. New product and purchase unit dropdowns show configuration guidance, and new order creation cannot use products with disabled units.
- Settings changes and product/order writes share SQLite write serialization, so validation and mutations occur within the same transaction.

## Every updated application page and component

| Page / component | File | Change |
| --- | --- | --- |
| Settings → Inventory / Units / Products | `frontend/page/settings-page.html` | Separate sibling navigation items and panels, Units overview shortcut, unit search/count/checkbox list, product dropdown and link to `#units`. |
| Inventory and Units settings controller | `frontend/src/js/warehouse/inventory-settings.js` | Search across enabled/disabled units, checkbox selection, immediate persistence, pending state and failed-save recovery; initialize and refresh either panel with its own visible status and refresh button. |
| Shared inventory options / unit select | `frontend/src/js/warehouse/inventory-options.js` | Reusable dropdown population with enabled units and an owner's disabled original unit. |
| Settings → Products form and list | `frontend/src/js/orders/product-settings.js` | Fetch central units, use the dropdown for create/edit/reset, validate assignments and retain existing units. |
| Orders → Create Order | `frontend/src/js/orders/order-dialogs.js` | Request a catalog restricted to enabled units; refresh derived unit fields and clear unavailable selections. |
| Units styling | `frontend/src/inventory-settings.css` | Checkbox-list controls and full-width layouts for the separate Inventory and Units panels. |
| Application startup | `backend/app.py` | Invoke the additive unit migration after existing order migrations. |
| Inventory reference model | `backend/models/inventory.py` | Document the shared ownership of units. |
| Product / order-item models | `backend/models/order.py` | Align unit length with the existing 80-character settings catalog; SQLite needs no table rebuild. |
| Product request schemas | `backend/schemas/order_schema.py` | Accept the same unit length as settings; keep existing input normalization. |
| Central unit service | `backend/services/inventory_service.py` | Catalog initialization, enabled-unit validation, history-safe naming and serialized setting mutations. |
| Product / order service | `backend/services/order_service.py` | Validate new assignments, preserve original units, filter the order catalog and enforce unit settings during order creation. |
| Product API | `backend/routes/orders.py` | Add `GET /api/products?for_order=true`; retain existing catalog behavior for other callers. |

## Unit fields using central settings

| Field | Source / behavior |
| --- | --- |
| Product creation `#settingsProductUnit` → `Product.unit` | Enabled settings units only. |
| Product editing `#settingsProductUnit` → `Product.unit` | Enabled settings units, plus that product's current disabled/legacy unit for retention. |
| Purchase entry `#purchaseUnit` | Existing implementation already reads enabled units from the same settings API using option IDs. Verified against the expanded catalog, deselection, reload and empty-selection states; no purchase component code change was needed. |
| New order `.item-unit` → `OrderItem.unit` | Derived from a selected product whose unit is enabled; enforced on both catalog reads and writes. |
| Existing order details, invoices/exports, dashboard inventory and reports | Continue displaying persisted product or invoice units, including disabled units in historical records. No hardcoded assignment lists were found in these displays. |

## Remaining scope limits

- Production is currently a navigation placeholder (`href="#"`), with no production form, unit field, model or API to connect.
- Warehouse stock is currently an empty display with disabled filters; there is no inventory movement editor/API. Product stock remains available through the existing product workflow.
- Purchase entry already uses central settings, but its submit handler only prevents submission and there is no purchase persistence API. This feature does not add a new purchasing subsystem; consequently there is no purchase write endpoint on which to add backend unit validation.
- No other implemented editable physical-unit fields remain outside the central settings flow. Currency labels and dashboard layout measurements are unrelated to inventory units.

## Original unit implementation verification

All API and browser tests use disposable SQLite databases; the application's live database was not modified.

| Check | Result |
| --- | --- |
| Backend regression suite | 147 tests: 146 passed, 1 optional real-face-inference test skipped because reference images were not supplied. |
| Frontend Node suite | 82 passed, including configured dropdown, disabled/missing legacy units and empty-selection coverage. |
| Frontend Python suite | 12 passed: module syntax/asset graph, navigation, private files, launcher lifecycle and production HTTP/build checks. |
| Production build | Passed; 117 versioned assets generated. |
| New `configured_units_browser.mjs` | Passed: search/no results, selection/reload, failed-save rollback, responsive widths 320/390/768/1440, product creation/editing, retained disabled units, cross-tab order refresh, invalid API writes, invoice history/retries, purchase configured/empty states and re-enabling. No application page errors. |
| Existing `warehouse_browser.mjs` | Passed: settings persistence, enabled-only purchase options, empty selections, identity/date fields, retry, navigation and responsive layout. |
| Existing `settings_browser.mjs` | Passed: all 11 settings sections at widths 320/390/768/1024/1440; settings CRUD, unit selection, product dropdown and security/session flows. |
| Existing `orders_quantity_browser.mjs` | Passed at widths 320/390/768/1440: quantities, totals, discount, multi-item orders and saved invoices. |
| Restart/migration tests | Passed: adoption of product/history-only units, preserved inactive settings, unchanged stock/invoice snapshots and repeated process restarts with every unit disabled. |
| Validation tests | Passed: unconfigured/inactive units rejected, categories cannot masquerade as units, owner-only retention, normalization, 80-character units, stable names, re-enabling, atomic rejected orders and foreign-key integrity. |
| Whitespace check | `git diff --check` passed. |

New tests: `backend/tests/test_configured_units.py`, `backend/tests/test_unit_migration.py`, `frontend/tests/test_configured_units.cjs`, `frontend/tests/configured_units_browser.mjs`.

Existing test adaptations: `frontend/tests/test_product_settings.cjs` supplies central-unit dependencies; `frontend/tests/settings_browser.mjs` uses checkboxes/select controls; `frontend/tests/warehouse_browser.mjs` explicitly deselects seeded defaults for its empty-state scenario; `backend/tests/test_reports.py` clears seeded options before inserting its deterministic 1,000-row catalog.

To repeat automated checks:

```sh
python3 -m unittest discover -s backend/tests -v
python3 -m unittest discover -s frontend/tests -p 'test_*.py' -v
npm --prefix frontend test
npm --prefix frontend run build
```

Browser checks use `frontend/tests/serve_customers_fixture.py` and environment variables `KARBON_TEST_URL`, `KARBON_PLAYWRIGHT_PATH` and optionally `KARBON_CHROME_PATH`. Use a fresh fixture per suite; the settings suite changes only its disposable user's credentials. The new unit suite requires `--customers 3 --orders --finance`.
