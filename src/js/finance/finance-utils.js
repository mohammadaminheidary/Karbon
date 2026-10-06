import {
  normalizeDigits,
  formatJalaliInput,
  normalizeJalaliDate,
} from "../customers/customer-utils.js";
export { normalizeDigits, formatJalaliInput, normalizeJalaliDate };

export const money = (value) =>
  `${new Intl.NumberFormat("fa-IR").format(value)} تومان`;
export const fullDate = (value) =>
  new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Tehran",
  }).format(new Date(`${value}T12:00:00+03:30`));
export function todayKey() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tehran",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function shiftDay(day, offset) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
export function amountValue(value, { signed = false, allowZero = false } = {}) {
  const raw = normalizeDigits(value).replace(/[,٬\s]/g, "");
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(raw))
    throw new Error("مبلغ را به صورت عدد صحیح وارد کنید.");
  const number = Number(raw);
  if (
    !Number.isSafeInteger(number) ||
    Math.abs(number) > 999999999999 ||
    (!signed && (allowZero ? number < 0 : number <= 0))
  )
    throw new Error("مبلغ باید مثبت و حداکثر ۹۹۹٬۹۹۹٬۹۹۹٬۹۹۹ تومان باشد.");
  return number;
}
export function bindAmount(input, signed = false) {
  input.addEventListener("input", () => {
    const start = input.selectionStart ?? input.value.length;
    const before = normalizeDigits(input.value.slice(0, start)).replace(
      /[^\d]/g,
      "",
    ).length;
    const normalized = normalizeDigits(input.value);
    const sign = signed && normalized.startsWith("-") ? "-" : "";
    const digits = normalized.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
    input.value = sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    let caret = sign.length,
      count = 0;
    while (caret < input.value.length && count < before) {
      if (/\d/.test(input.value[caret])) count++;
      caret++;
    }
    input.setSelectionRange(caret, caret);
  });
}
export function node(tag, classes = "", text = "") {
  const element = document.createElement(tag);
  element.className = classes;
  element.textContent = text;
  return element;
}
