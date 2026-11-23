import { normalizeDigits, normalizeJalaliDate } from "./customer-utils.js";

const digits = (value) => normalizeDigits(value).replace(/[^0-9]/g, "");
const persian = (value) => value.replace(/[0-9]/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[digit]);

export function initializeCustomerContactDate(group) {
  const fields = [...group.querySelectorAll("input")];

  function setValue(date) {
    const parts = date.split("/");
    fields.forEach((field, index) => {
      field.value = persian(parts[index] ?? "");
    });
  }

  fields.forEach((field, index) => {
    const next = fields[index + 1];
    const select = () => field.select();
    field.addEventListener("focus", select);
    field.addEventListener("click", select);
    field.addEventListener("input", (event) => {
      const beforeCaret = digits(field.value.slice(0, field.selectionStart)).length;
      const value = persian(digits(field.value).slice(0, field.maxLength));
      if (field.value !== value) {
        field.value = value;
        field.setSelectionRange(beforeCaret, beforeCaret);
      }
      if (value.length === field.maxLength && !event.inputType?.startsWith("delete")) next?.focus();
    });
    field.addEventListener("blur", () => {
      if (field.maxLength === 2 && field.value.length === 1) field.value = `۰${field.value}`;
    });
    field.addEventListener("keydown", (event) => {
      if (event.key === "/") {
        event.preventDefault();
        next?.focus();
      }
    });
    field.addEventListener("paste", (event) => {
      const text = normalizeDigits(event.clipboardData.getData("text")).trim();
      const fullDate = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(text) ??
        /^(\d{4})(\d{2})(\d{2})$/.exec(text);
      if (fullDate) {
        event.preventDefault();
        const [, year, month, day] = fullDate;
        setValue(`${year}/${month.padStart(2, "0")}/${day.padStart(2, "0")}`);
      }
    });
  });

  return {
    setValue,
    getValue() {
      const parts = fields.map((field) => field.value);
      return parts.some(Boolean) ? normalizeJalaliDate(parts.join("/")) : null;
    },
    markInvalid() {
      fields.forEach((field) => field.setAttribute("aria-invalid", "true"));
    },
  };
}
