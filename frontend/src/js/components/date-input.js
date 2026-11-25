import { normalizeDigits } from "../customers/customer-utils.js";

const digits = (value) => normalizeDigits(value).replace(/[^0-9]/g, "");
const persian = (value) => value.replace(/[0-9]/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[digit]);
const parts = [
  { label: "سال", length: 4, width: "4.5ch" },
  { label: "ماه", length: 2, width: "3ch" },
  { label: "روز", length: 2, width: "3ch" },
];
let nextId = 0;

export function normalizeGregorianDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000") ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) throw new Error("تاریخ میلادی واردشده معتبر نیست.");
  return value;
}

function padPart(value, index) {
  return index && value ? value.padStart(2, "0") : value;
}

export function initializeDateSegments(group, { separator = "/" } = {}) {
  const fields = [...group.querySelectorAll("input")];
  const first = fields[0];
  const spaced = new RegExp(`^(\\d{4})${"[/-](\\d{1,2})".repeat(fields.length - 1)}$`);
  const compact = new RegExp(`^(\\d{4})${"(\\d{2})".repeat(fields.length - 1)}$`);

  function setValue(value) {
    const segments = normalizeDigits(value ?? "").split(/[/-]/);
    fields.forEach((field, index) => {
      const segment = segments[index] ?? "";
      field.value = persian(padPart(segment, index));
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
      if (value.length === field.maxLength && !event.inputType?.startsWith("delete"))
        next?.focus();
    });
    field.addEventListener("blur", () => {
      if (field.maxLength === 2 && field.value.length === 1) field.value = `۰${field.value}`;
    });
    field.addEventListener("keydown", (event) => {
      if (event.key === "/" || event.key === "-") {
        event.preventDefault();
        next?.focus();
      }
    });
    field.addEventListener("paste", (event) => {
      if (field.readOnly || field.matches(":disabled")) return;
      const text = normalizeDigits(event.clipboardData?.getData("text") ?? "").trim();
      const fullDate = spaced.exec(text) ?? compact.exec(text);
      if (fullDate) {
        event.preventDefault();
        setValue(fullDate.slice(1).join(separator));
        group.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
  });

  return {
    group,
    first,
    get value() {
      const values = fields.map((field, index) => padPart(normalizeDigits(field.value), index));
      return values.some(Boolean) ? values.join(separator) : "";
    },
    set value(value) {
      setValue(value);
    },
    set readOnly(value) {
      fields.forEach((field) => (field.readOnly = value));
    },
    set disabled(value) {
      fields.forEach((field) => (field.disabled = value));
    },
    markInvalid() {
      fields.forEach((field) => field.setAttribute("aria-invalid", "true"));
    },
  };
}

export function mountDateInput(input, { count = 3, separator = "/" } = {}) {
  const label = input.closest("label");
  const initialValue = input.value;
  const defaultValue = input.defaultValue;
  const required = input.required;
  const readOnly = input.readOnly;
  const description = input.getAttribute("aria-describedby");
  const group = document.createElement("div");
  if (!input.id) input.id = `dateInput${++nextId}`;
  group.className = "segmented-date";
  group.dataset.dateInput = input.id;
  group.dir = "ltr";
  group.setAttribute("role", "group");
  input.replaceWith(group);

  if (label) {
    const wrapper = document.createElement("div");
    for (const { name, value } of [...label.attributes]) {
      if (name === "for") continue;
      wrapper.setAttribute(name, value);
      label.removeAttribute(name);
    }
    wrapper.classList.add("segmented-date-label");
    const children = [...label.childNodes];
    const controls = children.slice(children.indexOf(group));
    label.htmlFor = input.id;
    label.replaceWith(wrapper);
    wrapper.append(label, ...controls);
  }

  const caption = input.getAttribute("aria-label") ?? label?.textContent.trim();
  if (caption) group.setAttribute("aria-label", caption);
  input.removeAttribute("name");
  parts.slice(0, count).forEach(({ label, length, width }, index) => {
    const field = index === 0 ? input : document.createElement("input");
    field.type = "text";
    field.className = "segmented-date-part";
    field.dataset.datePart = "";
    field.style.setProperty("--date-part-width", width);
    field.inputMode = "numeric";
    field.maxLength = length;
    field.autocomplete = "off";
    field.placeholder = label;
    field.required = required;
    field.readOnly = readOnly;
    field.setAttribute("aria-label", caption ? `${label}، ${caption}` : label);
    if (description) field.setAttribute("aria-describedby", description);
    if (index) {
      const slash = document.createElement("span");
      slash.setAttribute("aria-hidden", "true");
      slash.textContent = "/";
      group.append(slash);
    }
    group.append(field);
  });

  const control = initializeDateSegments(group, { separator });
  control.value = defaultValue;
  group.querySelectorAll("input").forEach((field) => (field.defaultValue = field.value));
  control.value = initialValue;
  return control;
}
