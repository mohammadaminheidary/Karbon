# Karbon test-data generator

A separate third workspace section beside Frontend and Backend. Open
`Karbon.code-workspace` and run **Tasks → Run Task → Test Data Generator: Open interface**,
or from the project root:

```sh
python3 test_data_generator/app.py
```

Use the Python interpreter with `backend/requirements.txt` installed. Tkinter
ships with Python.org Python; on Linux install the distribution's `python3-tk`.
The backend does not need to be running, but start Karbon once beforehand so its
existing database and migrations are ready. No backend or frontend code is changed.

The window shows the selected database. It uses `backend/config.py` and the same
`KARBON_DATABASE_PATH` and `KARBON_TIMEZONE` settings as the root launcher;
relative database overrides resolve from `backend/`. A missing database or outdated
schema fails without creating a replacement database or migrating application tables.

Quantity means **customers**, default 1,000 (range 1–100,000). Each has a validated
order/invoice, item, purchase expense document, operating expense and production
task. Payments alternate between unpaid, half paid and settled; prices and discounts
use integer toman. Dates cover the last 28 days, with Persian names and addresses.
Products have stock remaining after the generated sales. There are also dedicated
synthetic bank and document accounts, an expense category, inventory options,
members and attendance. Generated funds, products and reference data never reuse
real accounts, customers or inventory. Refresh the dashboard to see the results.

**Schema limits:** Karbon currently has no persisted purchase or production entities;
the warehouse purchase form does not save records. Purchases are represented by
existing expense documents and production by existing tasks referencing order numbers.
These do not claim to be an inventory movement history. Final stock is seeded
directly; invoice snapshots use Karbon's serializer and its batch relationship loader.
No users, credentials or biometric templates are generated.

All records are marked in the dedicated `karbon_test_data_records` ownership table,
with batch UUID, table, primary key and a digest of the stored record. Descriptive
fields also show `TEST` identifiers where supported. Names and notes alone never
identify records for deletion. Each operation holds a SQLite write lock and commits
once; any error rolls back the complete operation. Inserts and tracking use batches
of 250, and workers report progress through a queue to the Tk main thread. SQLite
allows only one writer; other writes can briefly wait while a batch runs.

**Delete all data** clears every business table in reverse foreign-key order,
including real data, generated data, edited records, old records without ownership
markers, soft-deleted records, member photos/templates and tracking entries. This
is a full dashboard reset. Only login accounts (`users`) and the bundled bank catalog
(`bank_directory`) remain so the application remains usable. Foreign keys stay
enabled, schema and ID sequences remain intact, and the complete reset rolls back
if any step fails. The window displays this destructive behavior beside the button.
The reset happens only when the button is clicked; installing or testing this tool
does not permanently clear the database.

**Generate fake data** adds exactly the entered number of customers, each with its
related records. For example, 100 means 100 new customers and 100 invoices, plus
items, financial records and tasks. The success message distinguishes customer
quantity from the total number of rows. Each click adds another batch; use Delete
all data first for a fresh dashboard with exactly the requested customer count.

For optional programmatic cleanup of generated records only,
`Generator.delete_generated()` retains the ownership and digest safety checks.
The GUI delete button uses `Generator.delete()`, the complete business reset.

Run rollback-only integration verification **on the existing configured database**:

```sh
python3 -m unittest discover -s test_data_generator/tests -v
```

Tests hold one outer transaction and use savepoints for operations. They exercise
1,000 customers, invoice serialization, dashboard totals, foreign keys, financial
arithmetic, two generation/deletion cycles, failures, changed rows, cascading and
restricting real references, and unchanged original rows for generated-only cleanup.
Additional tests verify that full reset empties all dashboard metrics, preserves
login/catalog rows, removes unmarked records, rolls back failures and supports
repeated reset/generate cycles with exactly the specified customer counts. They create no database
and roll back all changes, including test tracking-table creation. Run when other
writers are idle. For a GUI smoke check without generating anything:

```sh
python3 -c 'from test_data_generator.app import *; r=tk.Tk(); Application(r); r.update(); r.destroy()'
```
