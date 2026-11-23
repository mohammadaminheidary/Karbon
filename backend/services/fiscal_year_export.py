"""Persian PDFs and a related workbook, rendered only from the frozen year."""
from collections import Counter
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile

from fpdf import FPDF
from fpdf.fonts import FontFace
from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from services.fiscal_snapshot import METHODS, MONTHS, group_rows, month_index
from services.report_export import font_bytes
from services.report_service import LABELS, canonical


DIGITS = str.maketrans("0123456789,", "۰۱۲۳۴۵۶۷۸۹٬")
BLUE = (25, 72, 154)
TEAL = (13, 129, 120)
INK = (29, 44, 66)
MUTED = (77, 96, 120)
GRID = (214, 225, 236)
PALE = (239, 245, 252)
STATUSES = {"active": "فعال", "completed": "تکمیل‌شده"}


def number(value):
    return f"{int(value):,}".translate(DIGITS)


def digits(value):
    return str(value).translate(DIGITS)


def ltr(value):
    return f"\u2066{value}\u2069"


def account_name(row):
    if row["is_cash"]:
        return row["name"]
    return f"{row['bank_name'] or row['name']} · {ltr(row['account_number'][-6:])}"


class FiscalPDF(FPDF):
    def __init__(self, data, title, font):
        super().__init__(orientation="L", format="A4")
        self.title_text = title
        self.period = data["period"]
        self.statement_context = None
        self.set_margins(13, 12, 13)
        self.set_auto_page_break(True, margin=13)
        self.add_font("Vazirmatn", fname=str(font))
        self.set_font("Vazirmatn", size=10)
        self.set_text_shaping(True)
        self.set_title(f"{title} {self.period['year']}")
        self.set_creator("Karbon")
        self.set_lang("fa-IR")

    def header(self):
        self.set_text_color(*BLUE)
        self.set_font_size(10)
        self.cell(0, 6, f"کاربن | {self.title_text} {digits(self.period['year'])}", align="R", new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(*GRID)
        self.line(self.l_margin, self.y + 1, self.w - self.r_margin, self.y + 1)
        self.ln(5)
        if self.statement_context:
            self.set_font_size(9)
            self.set_text_color(*MUTED)
            self.multi_cell(0, 5, self.statement_context, align="R", new_x="LMARGIN", new_y="NEXT")
            self.ln(3)

    def footer(self):
        self.set_y(-10)
        self.set_text_color(*MUTED)
        self.set_font_size(8)
        self.cell(0, 5, f"سال مالی {digits(self.period['year'])} | صفحه {number(self.page_no())}", align="C")

    def reserve(self, height):
        if self.will_page_break(height):
            self.add_page()

    def heading(self, text, size=13):
        self.reserve(35)
        self.set_font_size(size)
        self.set_text_color(*BLUE)
        self.multi_cell(0, 7.5, text, align="R", new_x="LMARGIN", new_y="NEXT")
        self.ln(1)

    def body(self, text):
        self.set_font_size(10)
        self.set_text_color(*MUTED)
        self.multi_cell(0, 5.5, text, align="R", new_x="LMARGIN", new_y="NEXT")
        self.ln(2)

    def grid(self, headings, rows, widths=None):
        self.set_font_size(9)
        self.set_text_color(*INK)
        self.set_draw_color(*GRID)
        self.set_fill_color(255, 255, 255)
        with self.table(
            text_align="RIGHT", line_height=4.7, padding=(1.3, 2), wrapmode="CHAR",
            headings_style=FontFace(emphasis="", color=(255, 255, 255), fill_color=BLUE),
            cell_fill_color=PALE, cell_fill_mode="ROWS",
            col_widths=tuple(reversed(widths)) if widths else None,
        ) as table:
            table.row(tuple(reversed(headings)))
            for row in rows:
                table.row(tuple(str(value) if value is not None and value != "" else "-" for value in reversed(row)))
        self.ln(4)

    def fit(self, value, width):
        if self.get_string_width(value) <= width:
            return value
        while self.get_string_width(value + "…") > width:
            value = value[:-1]
        return value + "…"

    def monthly_chart(self, title, series, unit):
        """Render independent axes for orders and money, with months right to left."""
        self.reserve(62)
        self.heading(title)
        self.set_font_size(8)
        right = self.w - self.r_margin
        y = self.y
        legend_unit = f"واحد {unit}"
        width = self.get_string_width(legend_unit) + 3
        self.set_xy(right - width, y)
        self.set_text_color(*MUTED)
        self.cell(width, 5, legend_unit, align="R")
        right -= width + 7
        for index, (name, _) in enumerate(series):
            self.set_fill_color(*(BLUE, TEAL)[index])
            self.rect(right - 3, y + 1.1, 3, 2.8, "F")
            width = self.get_string_width(name) + 3
            self.set_xy(right - width - 4, y)
            self.set_text_color(*INK)
            self.cell(width, 5, name, align="R")
            right -= width + 8
        self.set_xy(self.l_margin, y + 8)
        top = self.y
        bottom = top + 29
        maximum = max((value for _, values in series for value in values), default=0)
        target = max(1, (maximum + 2) // 3)
        magnitude = 10 ** (len(str(target)) - 1)
        step = next(magnitude * scale for scale in (1, 2, 5, 10) if magnitude * scale >= target)
        axis = step * 3
        left = self.l_margin + 38
        right = self.w - self.r_margin
        plot_width = right - left
        for index in range(4):
            tick = step * index
            y = bottom - (bottom - top) * index / 3
            self.set_draw_color(*GRID)
            self.line(left, y, right, y)
            self.set_text_color(*MUTED)
            self.set_xy(self.l_margin, y - 2.5)
            self.cell(36, 5, number(tick), align="R")
        group_width = plot_width / 12
        bar_width = group_width * 0.62 / len(series)
        for month, name in enumerate(MONTHS):
            center = right - (month + 0.5) * group_width
            for index, (_, values) in enumerate(series):
                height = (bottom - top) * values[month] / axis
                if height:
                    self.set_fill_color(*(BLUE, TEAL)[index])
                    self.rect(center + (index - len(series) / 2) * bar_width, bottom - height, bar_width - 0.6, height, "F")
            self.set_text_color(*INK)
            self.set_xy(center - group_width / 2, bottom + 1)
            self.cell(group_width, 5, name, align="C")
        self.set_xy(self.l_margin, bottom + 8)

    def amount_chart(self, title, rows):
        self.heading(title)
        if not rows:
            self.body("داده‌ای در این دوره ثبت نشده است.")
            return
        maximum = max(1, *(abs(value) for _, value in rows))
        negative = any(value < 0 for _, value in rows)
        self.set_font_size(8.5)
        chart_left, chart_right = self.l_margin + 44, self.w - self.r_margin - 82
        axis = (chart_left + chart_right) / 2 if negative else chart_left
        span = chart_right - axis
        for name, amount in rows:
            if self.will_page_break(7):
                self.add_page()
                self.heading(title)
            self.set_font_size(8.5)
            y = self.y
            self.set_draw_color(*GRID)
            self.line(chart_left, y + 3.5, chart_right, y + 3.5)
            self.line(axis, y, axis, y + 7)
            width = span * amount / maximum
            self.set_fill_color(*(BLUE if amount >= 0 else TEAL))
            if width:
                self.rect(min(axis, axis + width), y + 1.2, abs(width), 4.5, "F")
            self.set_xy(self.l_margin, y)
            self.set_text_color(*INK)
            self.cell(42, 7, f"{number(amount)} تومان", align="R")
            self.set_xy(chart_right + 2, y)
            self.cell(80, 7, self.fit(name, 77), align="R")
            self.set_xy(self.l_margin, y + 7)
        self.ln(4)


def totals_table(pdf, headings, values):
    pdf.grid(headings, [tuple(number(v) for v in values)])


def monthly_table(pdf, months, *columns):
    fields = ("ماه", *(label for _, label in columns))
    rows = [(name, *(number(month[key]) for key, _ in columns)) for name, month in zip(MONTHS, months)]
    pdf.grid(fields + fields, (first + second for first, second in zip(rows[:6], rows[6:])))


def carryover_chapter(pdf, data):
    s, period = data["summary"], data["period"]
    pdf.add_page()
    pdf.heading("مانده‌های انتقالی مشتریان", 18)
    pdf.body(f"سال مالی {digits(period['year'])}  |  تاریخ قطع حساب {digits(period['end_jalali'])}  |  مبالغ به تومان")
    totals_table(pdf, ("مشتریان دارای مانده", "فاکتورهای باز", "مطالبات", "بستانکاری مشتریان"),
                 (s["carryover_customers"], s["open_invoices"], s["receivables"], s["credits"]))
    pdf.body("هر مشتری دارای مطالبات یا بستانکاری یک‌بار شمرده می‌شود. دریافت تخصیص‌نیافته، پیش‌دریافت فاکتور صادرنشده و اضافه‌پرداخت ثبت‌شده، بستانکاری مشتری است.")
    customers = {row["id"]: row for row in data["customers"]}
    opening = {row["customer_id"]: row for row in data["opening_customer_accounts"]}
    carried = {row["order_id"]: row["amount"] for row in data["closing_invoices"]}
    opening_invoices = {row["order_id"]: row["amount"] for row in data["opening_invoices"]}
    orders = group_rows(data["orders"], "customer_id")
    items = group_rows(data["order_items"], "order_id")
    allocated = group_rows(data["payments"], "order_id")
    unapplied = group_rows(allocated[None], "customer_id")
    for closing in data["closing_customer_accounts"]:
        cid = closing["customer_id"]
        c = customers[cid]
        name = f"{c['first_name']} {c['last_name']}"
        start = opening.get(cid, {"receivable": 0, "credit": 0})
        pdf.statement_context = name
        pdf.reserve(44)
        pdf.heading(name)
        pdf.grid(("کد مشتری", "شماره‌های تماس", "مطالبات افتتاحیه", "بستانکاری افتتاحیه",
                  "مطالبات پایان سال و انتقالی", "بستانکاری پایان سال و انتقالی"), [
            (digits(c["customer_code"]), "، ".join(ltr(digits(phone)) for phone in c["phone_numbers"]),
             number(start["receivable"]), number(start["credit"]), number(closing["receivable"]), number(closing["credit"]))
        ], (17, 34, 27, 27, 33, 34))
        for order in orders[cid]:
            oid = order["id"]
            invoice_heading = f"فاکتور {ltr(order['invoice_code'])}"
            pdf.statement_context = f"{name} | {invoice_heading}"
            pdf.reserve(52)
            pdf.heading(invoice_heading, 11)
            pdf.grid(("شماره سفارش", "شماره فاکتور", "سال مبدأ", "تاریخ صدور", "سررسید اصلی"), [
                (order["order_number"], order["invoice_code"], digits(order["source_year"]),
                 digits(order["jalali_date"]), digits(order["jalali_payment_date"]))
            ])
            totals_table(pdf, ("جمع اقلام", "تخفیف فاکتور", "مبلغ نهایی", "مطالبات افتتاحیه",
                               "پرداخت تا قطع حساب", "مانده پایان سال", "مبلغ انتقالی"),
                         (order["subtotal"], order["discount"], order["total"], opening_invoices.get(oid, 0),
                          order["paid"], order["remaining"], carried.get(oid, 0)))
            pdf.grid(("ردیف", "کالا یا خدمت", "واحد", "تعداد", "بهای واحد", "جمع ردیف"), (
                (number(item["position"]), item["product_name"], item["unit"], number(item["quantity"]),
                 number(item["unit_price"]), number(item["total"])) for item in items[oid]
            ), (10, 47, 16, 13, 24, 26))
            if allocated[oid]:
                payments_table(pdf, allocated[oid])
            else:
                pdf.body("پرداختی تا تاریخ قطع حساب ثبت نشده است.")
        if unapplied[cid]:
            pdf.statement_context = name
            pdf.heading("دریافت‌های تخصیص‌نیافته", 11)
            payments_table(pdf, unapplied[cid])
    pdf.statement_context = None


def payments_table(pdf, rows):
    pdf.grid(("تاریخ دریافت", "مبلغ دریافت", "روش", "شماره پیگیری"), (
        (digits(row["jalali_date"]), number(row["amount"]), METHODS[row["method"]], row["tracking_number"])
        for row in rows
    ))


def monthly_data(data):
    months = [Counter() for _ in MONTHS]
    for order in data["orders"]:
        if order["in_period"]:
            month = months[month_index(order["invoice_date"])]
            month["orders"] += 1
            month["sales"] += order["total"]
    for tx in data["transactions"]:
        if tx["in_period"]:
            months[month_index(tx["transaction_date"])][tx["kind"]] += tx["amount"]
    for customer in data["customers"]:
        if customer["new_in_period"]:
            months[month_index(customer["created_date"])]["customers"] += 1
    for purchase in data["purchases"]:
        months[month_index(purchase["purchase_date"])]["purchases"] += purchase["total"]
    return months


def sales_chapter(pdf, data, months):
    pdf.reserve(92)
    pdf.heading("سفارش‌ها و فروش", 17)
    s = data["summary"]
    totals_table(pdf, ("سفارش‌ها", "فعال", "تکمیل‌شده", "فروش ناخالص", "تخفیف", "فروش خالص"),
                 (s["orders"], s["active_orders"], s["completed_orders"], s["gross_sales"], s["discounts"], s["net_sales"]))
    pdf.monthly_chart("تعداد سفارش ماهانه", [("سفارش", [m["orders"] for m in months])], "سفارش")
    pdf.monthly_chart("فروش خالص ماهانه", [("فروش خالص", [m["sales"] for m in months])], "تومان")
    monthly_table(pdf, months, ("orders", "تعداد سفارش"), ("sales", "فروش خالص (تومان)"))
    current_orders = {row["id"] for row in data["orders"] if row["in_period"]}
    products = Counter()
    categories = Counter()
    product_quantities = Counter()
    category_quantities = Counter()
    names = {}
    for item in data["order_items"]:
        if item["order_id"] in current_orders:
            pid = item["product_id"]
            names[pid] = item["product_name"]
            product = (pid, item["unit"])
            category = (item["category_path"] or "بدون دسته", item["unit"])
            products[product] += item["total"]
            product_quantities[product] += item["quantity"]
            categories[category] += item["total"]
            category_quantities[category] += item["quantity"]
    top = Counter()
    for (pid, _), value in products.items():
        top[pid] += value
    top_rows = [(names[pid], total) for pid, total in top.most_common(10)]
    pdf.amount_chart("پرفروش‌ترین کالاها بر پایه فروش ناخالص", top_rows)
    pdf.grid(("کالا", "فروش ناخالص (تومان)"), ((name, number(total)) for name, total in top_rows))
    pdf.body("ارزش فروش کالا و دسته‌بندی پیش از تخفیف فاکتور است. تعداد برای هر واحد جداگانه گزارش می‌شود.")
    pdf.grid(("کالا", "واحد", "تعداد", "ارزش (تومان)"), (
        (names[pid], unit, number(product_quantities[pid, unit]), number(total))
        for (pid, unit), total in products.most_common()
    ))
    pdf.grid(("دسته‌بندی کالا", "واحد", "تعداد", "ارزش (تومان)"), (
        (name, unit, number(category_quantities[name, unit]), number(total))
        for (name, unit), total in categories.most_common()
    ))


def transactions_chapter(pdf, data, months):
    pdf.reserve(96)
    pdf.heading("تراکنش‌ها و حساب‌ها", 17)
    s = data["summary"]
    totals_table(pdf, ("کل تراکنش‌ها", "تعداد دریافت", "مبلغ دریافت", "تعداد پرداخت", "مبلغ پرداخت"),
                 (s["transactions"], s["income_count"], s["income"], s["expense_count"], s["expense"]))
    pdf.monthly_chart("دریافت و پرداخت ماهانه",
                      [("دریافت", [m["income"] for m in months]), ("پرداخت", [m["expense"] for m in months])], "تومان")
    monthly_table(pdf, months, ("income", "دریافت (تومان)"), ("expense", "پرداخت (تومان)"))
    money_by_method, count_by_method = Counter(), Counter()
    expense, expense_count = Counter(), Counter()
    for tx in data["transactions"]:
        if not tx["in_period"]:
            continue
        key = (tx["kind"], tx["method"])
        money_by_method[key] += tx["amount"]
        count_by_method[key] += 1
        if tx["kind"] == "expense":
            category = (tx["expense_category_id"], tx["document_account_id"], tx["expense_category"])
            expense[category] += tx["amount"]
            expense_count[category] += 1
    pdf.heading("تفکیک روش پرداخت")
    pdf.grid(("نوع", "روش", "تعداد", "مبلغ (تومان)"), (
        ("دریافت" if key[0] == "income" else "پرداخت", METHODS[key[1]], number(count_by_method[key]), number(value))
        for key, value in money_by_method.most_common()
    ))
    pdf.amount_chart("هزینه‌ها به تفکیک دسته", [(key[2], value) for key, value in expense.most_common()])
    pdf.grid(("دسته هزینه", "تعداد", "مبلغ (تومان)"), (
        (key[2], number(expense_count[key]), number(value)) for key, value in expense.most_common()
    ))
    pdf.amount_chart("مانده پایان سال حساب‌ها و صندوق",
                     [(account_name(row), row["closing_balance"]) for row in data["accounts"]])
    pdf.grid(("حساب", "افتتاحیه", "دریافت", "پرداخت", "مانده پایان سال"), (
        (account_name(a), number(a["opening_balance"]), number(a["income"]),
         number(a["expense"]), number(a["closing_balance"])) for a in data["accounts"]
    ))


def purchases_chapter(pdf, data, months):
    pdf.reserve(92)
    pdf.heading("خرید و موجودی", 17)
    s = data["summary"]
    totals_table(pdf, ("تعداد فاکتور خرید", "ارزش خرید (تومان)"), (s["purchase_count"], s["purchase_value"]))
    pdf.monthly_chart("ارزش خرید ماهانه", [("خرید", [m["purchases"] for m in months])], "تومان")
    monthly_table(pdf, months, ("purchases", "ارزش خرید (تومان)"))
    amounts = Counter()
    purchases = {p["id"]: p for p in data["purchases"]}
    for item in data["purchase_items"]:
        category = " / ".join(v for v in (item["category_parent_name"], item["category_name"]) if v)
        amounts[category] += item["total"]
    pdf.amount_chart("ارزش خرید به تفکیک دسته کالا", amounts.most_common())
    pdf.grid(("دسته کالا", "ارزش خرید (تومان)"), ((name, number(value)) for name, value in amounts.most_common()))
    pdf.heading("اقلام فاکتورهای خرید")
    pdf.grid(("شماره فاکتور", "تاریخ خرید", "کالا", "تعداد", "واحد", "بهای واحد", "جمع (تومان)"), (
        (purchases[item["purchase_id"]]["invoice_number"], digits(purchases[item["purchase_id"]]["jalali_date"]),
         item["product_name"], number(item["quantity"]), item["unit"], number(item["purchase_price"]), number(item["total"]))
        for item in data["purchase_items"]
    ), (22, 19, 36, 14, 13, 21, 24))
    pdf.heading("موجودی پایان سال")
    inventory = data["inventory"]
    if inventory["available"]:
        pdf.grid(("کد کالا", "نام کالا", "واحد", "تعداد پایان سال"),
                 ((i["product_code"], i["name"], i["unit"], number(i["quantity"])) for i in inventory["rows"]))
    else:
        pdf.body(inventory["reason"])


def full_report(pdf, data):
    s, period = data["summary"], data["period"]
    months = monthly_data(data)
    pdf.add_page()
    pdf.heading(f"گزارش جامع سال مالی {digits(period['year'])}", 20)
    pdf.body(f"از {digits(period['start_jalali'])} تا {digits(period['end_jalali'])}  |  مبالغ به تومان")
    pdf.heading("خلاصه مدیریتی")
    totals_table(pdf, ("فروش ناخالص", "تخفیف", "فروش خالص", "دریافت", "پرداخت", "خرید"),
                 (s["gross_sales"], s["discounts"], s["net_sales"], s["income"], s["expense"], s["purchase_value"]))
    totals_table(pdf, ("فاکتور باز", "مشتریان دارای مانده", "مطالبات انتقالی", "بستانکاری انتقالی"),
                 (s["open_invoices"], s["carryover_customers"], s["receivables"], s["credits"]))
    pdf.heading("مشتریان")
    pdf.body("کل مشتریان یعنی پرونده‌های ثبت‌شده و فعال تا پایان سال. گروه تسویه‌شده شامل مشتری دارای فاکتور این سال یا مطالبه افتتاحیه است که در قطع حساب فاکتور باز ندارد.")
    totals_table(pdf, ("کل مشتریان پایان سال", "مشتریان جدید", "مشتریان سفارش‌دهنده", "مشتریان تسویه‌شده", "مشتریان دارای مانده"),
                 (s["customers"], s["new_customers"], s["ordering_customers"], s["settled_customers"], s["carryover_customers"]))
    pdf.monthly_chart("مشتریان جدید ماهانه", [("مشتری جدید", [m["customers"] for m in months])], "مشتری")
    monthly_table(pdf, months, ("customers", "مشتریان جدید"))
    sales_chapter(pdf, data, months)
    transactions_chapter(pdf, data, months)
    purchases_chapter(pdf, data, months)
    pdf.heading("سررسید مطالبات انتقالی")
    overdue = [("سررسید گذشته", s["overdue"]), ("در موعد یا پیش از سررسید", s["not_due"])]
    pdf.amount_chart("مطالبات بر پایه سررسید اصلی فاکتور در تاریخ قطع حساب", overdue)
    pdf.grid(("وضعیت سررسید", "تعداد فاکتور", "مطالبات (تومان)"), (
        (name, number(sum(row["overdue"] == (index == 0) for row in data["closing_invoices"])), number(value))
        for index, (name, value) in enumerate(overdue)
    ))
    carryover_chapter(pdf, data)


def dataset_fields(model, *extra, omit=()):
    return [key for key in model.__table__.columns.keys() if key not in omit] + list(extra)


def datasets(data):
    from models.customer import Customer
    from models.document import Document, DocumentAccount
    from models.finance import BankAccount, FinancialTransaction
    from models.inventory import InventoryOption, Purchase, PurchaseItem
    from models.order import Order, OrderItem, OrderPayment, Product

    yield "summary", ["metric", "value"], [{"metric": k, "value": v} for k, v in data["summary"].items()]
    columns = {
        "customers": dataset_fields(Customer, "created_date", "at_year_end", "new_in_period"),
        "orders": dataset_fields(Order, "source_year", "in_period", "total", "paid", "remaining", "jalali_date",
                                  "jalali_payment_date", omit={"request_id", "request_fingerprint", "invoice_snapshot", "deleted_at"}),
        "order_items": dataset_fields(OrderItem, "total", "category_path", "product_code"),
        "invoices": "order_id invoice_code order_number customer_id source_year in_period issue_date due_date subtotal discount total paid outstanding issued_customer".split(),
        "payments": "transaction_id customer_id order_id bank_id date jalali_date amount method tracking_number in_period".split(),
        "allocations": dataset_fields(OrderPayment, "amount", "in_period"),
        "transactions": dataset_fields(FinancialTransaction, "in_period", "method", "jalali_date", "bank_name",
                                       "expense_category", "order_id", omit={"request_id", "deleted_at"}),
        "documents": dataset_fields(Document, "in_period", omit={"request_id", "last_request_id", "request_fingerprint", "deleted_at"}),
        "accounts": dataset_fields(BankAccount, "bank_name", "is_cash", "income", "expense", "closing_balance"),
        "purchases": dataset_fields(Purchase, "jalali_date", "total", omit={"request_id", "request_fingerprint"}),
        "purchase_items": dataset_fields(PurchaseItem, "total"),
        "products": dataset_fields(Product, omit={"stock", "revision"}),
        "product_categories": dataset_fields(InventoryOption),
        "expense_categories": ["id", "title"],
        "document_accounts": dataset_fields(DocumentAccount),
    }
    for key, fields in columns.items():
        yield key, fields, data[key]
    for key in ("opening_customer_accounts", "closing_customer_accounts"):
        yield key, ["customer_id", "receivable", "credit"], data[key]
    for key in ("opening_invoices", "closing_invoices"):
        yield key, ["order_id", "customer_id", "source_year", "paid", "amount", "overdue"], data[key]
    for key in ("opening_inventory", "inventory"):
        yield key, ["product_id", "product_code", "name", "unit", "quantity"], data[key]["rows"]


FIELD_DEFINITIONS = {
    "in_period": "True for activity dated within the fiscal year. False rows join period records to earlier or later records.",
    "at_year_end": "Customer registered and present at the cutoff by recorded timestamps.",
    "new_in_period": "Customer registered during the period, where a registration record is still available.",
    "source_year": "Jalali year of the original invoice issue date.",
    "paid": "Invoice allocation amounts through the applicable cutoff. Applies to opening and closing invoice tables.",
    "remaining": "Invoice total less allocations through the fiscal cutoff.",
    "receipt_date": "Fiscal period follows the posted date of each financial transaction.",
    "receivable": "Sum of the customer's positive outstanding invoice balances.",
    "credit": "Unallocated receipts, deposits for invoices not yet issued at the cutoff, and historical excess allocations.",
    "overdue": "True when the original due date precedes the applicable cutoff.",
    "method": "pos, cash, transfer, or unknown when no method is recorded.",
    "settled_customers": "Distinct customers with a period invoice or opening receivable and no remaining invoice debt at cutoff.",
    "carryover_customers": "Distinct customers with a closing receivable or credit.",
    "opening_invoices.amount": "Amount brought forward from the preceding cutoff.",
    "closing_invoices.amount": "Outstanding amount carried into the next fiscal year.",
    "orders.payment_date": "Original due date on the issued invoice.",
    "inventory": "Quantities at fiscal year end by product. See inventory availability.",
}
REFERENCES = {
    "customer_id": "customers.id", "order_id": "orders.id", "transaction_id": "transactions.id",
    "bank_id": "accounts.id", "purchase_id": "purchases.id", "product_id": "products.id", "document_id": "documents.id",
    "category_id": "product_categories.id", "expense_category_id": "expense_categories.id",
    "document_account_id": "document_accounts.id",
}


def workbook_value(value):
    if isinstance(value, (dict, list)):
        value = canonical(value)
    if type(value) is int and abs(value) >= 10**15:
        value = str(value)
    return ILLEGAL_CHARACTERS_RE.sub(lambda match: f"\\u{ord(match[0]):04x}", value) if isinstance(value, str) else value


def data_zip(data):
    workbook = Workbook(write_only=True)
    style = dict(font=Font(name="Vazirmatn", bold=True, color="FFFFFF"),
                 fill=PatternFill("solid", fgColor="19489A"), alignment=Alignment(horizontal="right", readingOrder=2))
    manifest = {
        "schema_version": data["schema_version"], "period": data["period"], "amount_unit": "toman",
        "date_encoding": "Gregorian ISO 8601 unless the field specifies Jalali",
        "inventory": {key: {label: data[key][label] for label in ("available", "reason")}
                      for key in ("inventory", "opening_inventory")},
        "definitions": FIELD_DEFINITIONS, "references": REFERENCES, "worksheets": {},
    }
    for key, fields, rows in datasets(data):
        sheet = workbook.create_sheet(key)
        sheet.sheet_view.rightToLeft = True
        sheet.freeze_panes = "A2"
        for index, field in enumerate(fields, 1):
            sheet.column_dimensions[get_column_letter(index)].width = max(16, len(field) + 3)
        header = []
        for field in fields:
            cell = WriteOnlyCell(sheet, value=field)
            for name, value in style.items():
                setattr(cell, name, value)
            header.append(cell)
        sheet.append(header)
        sheet.auto_filter.ref = f"A1:{get_column_letter(len(fields))}{len(rows) + 1}"
        for row in rows:
            cells = []
            for field in fields:
                value = workbook_value(row.get(field))
                cell = WriteOnlyCell(sheet, value=value)
                if isinstance(value, str):
                    cell.data_type = "s"
                cells.append(cell)
            sheet.append(cells)
        manifest["worksheets"][key] = {"records": len(rows), "fields": fields,
                                      "labels_fa": {field: LABELS[field] for field in fields if field in LABELS}}
    with BytesIO() as sheet_file, BytesIO() as result:
        workbook.save(sheet_file)
        with ZipFile(result, "w", ZIP_DEFLATED) as archive:
            archive.writestr(f"karbon-{data['period']['year']}.xlsx", sheet_file.getvalue())
            archive.writestr("manifest.json", canonical(manifest))
        return result.getvalue()


def render_exports(data):
    with TemporaryDirectory(prefix="karbon-fiscal-report-") as directory:
        font = Path(directory) / "Vazirmatn.ttf"
        font.write_bytes(font_bytes())
        report = FiscalPDF(data, "گزارش جامع سال مالی", font)
        full_report(report, data)
        carryover = FiscalPDF(data, "مانده‌های انتقالی", font)
        carryover_chapter(carryover, data)
        return {"summary": bytes(report.output()), "carryover": bytes(carryover.output()), "data": data_zip(data)}
