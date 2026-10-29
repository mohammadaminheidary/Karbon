"""Contiguous display codes. Database identifiers and foreign keys never move.

Call while holding the SQLite write lock, in the same transaction as deletion.
"""
from sqlalchemy import text


def compact_customer_codes(db):
    rows = db.execute(text("SELECT id, customer_code FROM customers WHERE deleted_at IS NULL ORDER BY id")).all()
    codes = [{"code": code, "id": record_id} for code, (record_id, _) in enumerate(rows, 1001)]
    changed = [item for item, (_, old) in zip(codes, rows) if item["code"] != old]
    # Two passes prevent the unique index from colliding with old codes.
    if changed:
        db.execute(text("UPDATE customers SET customer_code = -id WHERE id=:id"), [{"id": item["id"]} for item in changed])
        db.execute(text("UPDATE customers SET customer_code=:code WHERE id=:id"), changed)
    if codes:
        db.execute(text("UPDATE financial_transactions SET account_code=:code WHERE customer_id=:id AND account_code!=:code"), [{**item, "code": str(item["code"])} for item in codes])


def compact_category_codes(db):
    rows = db.execute(text("SELECT id, display_code FROM expense_categories WHERE deleted_at IS NULL ORDER BY display_code IS NULL, display_code, id")).all()
    codes = [{"code": code, "id": record_id} for code, (record_id, _) in enumerate(rows, 1)]
    changed = [item for item, (_, old) in zip(codes, rows) if item["code"] != old]
    if changed:
        db.execute(text("UPDATE expense_categories SET display_code=:code WHERE id=:id"), changed)
    if codes:
        db.execute(text("UPDATE financial_transactions SET account_code=:code WHERE expense_category_id=:id AND account_code!=:code"), [{**item, "code": f"E-{item['code']:06d}"} for item in codes])


def compact_transaction_numbers(db):
    rows = db.execute(text("SELECT id, transaction_number FROM financial_transactions WHERE deleted_at IS NULL ORDER BY id")).all()
    changed = [{"number": number, "id": record_id} for number, (record_id, old) in enumerate(rows, 1) if number != old]
    if changed:
        db.execute(text("UPDATE financial_transactions SET transaction_number=:number WHERE id=:id"), changed)
