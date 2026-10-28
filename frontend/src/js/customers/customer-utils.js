export const numberFormatter = new Intl.NumberFormat("fa-IR");
export const formatNumber = (value) => numberFormatter.format(value);
export const fullName = (customer) =>
  `${customer.first_name} ${customer.last_name}`;
export const genderLabel = (gender) =>
  gender === "male" ? "آقا" : gender === "female" ? "خانم" : "ثبت نشده";
export const normalizeDigits = (value) =>
  String(value)
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
export const normalizeText = (value) =>
  normalizeDigits(value)
    .trim()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\s+/g, " ");
export function normalizePhone(value) {
  let phone = normalizeDigits(value).replace(/[\s()\-]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  if (phone.startsWith("+98")) phone = `0${phone.slice(3)}`;
  return phone;
}
const dateFormatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Tehran",
});
export function formatDate(value) {
  if (!value) return "ثبت نشده";
  return dateFormatter.format(new Date(`${value}T12:00:00+03:30`));
}

export function formatJalaliInput(value) {
  if (!value) return "";
  const parts = Object.fromEntries(
    dateFormatter
      .formatToParts(new Date(`${value}T12:00:00+03:30`))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}/${parts.month}/${parts.day}`;
}

export function normalizeJalaliDate(value) {
  let text = normalizeDigits(value).trim();
  if (!text) return null;
  // Numeric keyboards can enter eight digits without needing a slash key.
  if (/^[0-9]{8}$/.test(text))
    text = `${text.slice(0, 4)}/${text.slice(4, 6)}/${text.slice(6)}`;
  const match = /^([0-9]{4})[/-]([0-9]{1,2})[/-]([0-9]{1,2})$/.exec(text);
  if (!match) throw new Error("تاریخ شمسی را به صورت ۱۴۰۵/۰۷/۱۴ وارد کنید.");
  const [, year, month, day] = match.map(Number);
  if (
    year < 1 ||
    year > 9377 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (month <= 6 ? 31 : 30)
  )
    throw new Error("تاریخ شمسی واردشده معتبر نیست.");
  // Exact Esfand/leap-year validation and conversion use jdatetime on the server.
  return `${String(year).padStart(4, "0")}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}
export const statusMeta = (status) =>
  ({
    debtor: {
      label: "بدهکار",
      classes: "bg-alizarin-crimson/10 text-alizarin-crimson",
    },
    settled: {
      label: "تسویه شده",
      classes: "bg-eucalyptus/10 text-eucalyptus",
    },
    no_payment: {
      label: "بدون پرداختی",
      classes: "bg-french-gray/30 text-mirage/70",
    },
  })[status];

export function element(tag, classes = "", text = "") {
  const node = document.createElement(tag);
  node.className = classes;
  node.textContent = text;
  return node;
}

export function createSummary(summary, { compact = false } = {}) {
  const grid = element(
    "dl",
    compact
      ? "grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-french-gray/20 sm:grid-cols-4"
      : "grid grid-cols-2 gap-3 border-t border-french-gray/25 pt-4 sm:grid-cols-4",
  );
  [
    ["تعداد سفارش‌ها", summary.order_count, "text-mirage"],
    ["مجموع سفارش‌ها", summary.total_orders, "text-mirage"],
    ["پرداختی", summary.paid, "text-eucalyptus"],
    ["بدهی", summary.debt, "text-alizarin-crimson"],
  ].forEach(([label, value, color]) => {
    const cell = element(
      "div",
      compact
        ? "flex min-w-0 items-center justify-between gap-2 bg-alabaster px-3 py-2"
        : "min-w-0",
    );
    cell.append(
      element(
        "dt",
        compact
          ? "text-[10px] leading-4 text-mirage/50"
          : "text-xs text-mirage/50",
        label,
      ),
      element(
        "dd",
        compact
          ? `min-w-0 break-words text-xs font-bold tabular-nums ${color}`
          : `mt-2 break-words text-sm font-bold ${color}`,
        formatNumber(value),
      ),
    );
    grid.append(cell);
  });
  return grid;
}
