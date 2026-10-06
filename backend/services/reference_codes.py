"""Contiguous display codes. Database identifiers and foreign keys never move.

Call while holding the SQLite write lock, in the same transaction as deletion.
"""
from sqlalchemy import text


def compact_customer_codes(db):
    rows = db.execute(text("SELECT id FROM customers WHERE deleted_at IS NULL ORDER BY id")).scalars().all()
    # Two passes prevent the unique index from colliding with old codes.
    db.execute(text("UPDATE customers SET customer_code = -id"))
    for code, record_id in enumerate(rows, 1001):
        db.execute(text("UPDATE customers SET customer_code=:code WHERE id=:id"), {"code": code, "id": record_id})
        db.execute(text("UPDATE financial_transactions SET account_code=:code WHERE customer_id=:id"), {"code": str(code), "id": record_id})


def compact_category_codes(db):
    rows = db.execute(text("SELECT id FROM expense_categories WHERE deleted_at IS NULL ORDER BY display_code IS NULL, display_code, id")).scalars().all()
    for code, record_id in enumerate(rows, 1):
        db.execute(text("UPDATE expense_categories SET display_code=:code WHERE id=:id"), {"code": code, "id": record_id})
        db.execute(text("UPDATE financial_transactions SET account_code=:code WHERE expense_category_id=:id"), {"code": f"E-{code:06d}", "id": record_id})


def compact_transaction_numbers(db):
    rows = db.execute(text("SELECT id FROM financial_transactions WHERE deleted_at IS NULL ORDER BY id")).scalars().all()
    for number, record_id in enumerate(rows, 1):
        db.execute(text("UPDATE financial_transactions SET transaction_number=:number WHERE id=:id"), {"number": number, "id": record_id})
