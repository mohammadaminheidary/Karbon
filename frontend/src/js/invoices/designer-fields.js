import { node } from "../finance/finance-utils.js";
import { designBounds, fontFamilies, IMAGE_TYPES, PAPER_SIZES, SHAPE_TYPES } from "./invoice-paper.js";

export function button(label, action, { title = label, pressed, primary = false } = {}) {
  const control = node("button", primary ? "designer-button designer-primary" : "designer-button", label);
  control.type = "button";
  control.title = title;
  if (pressed !== undefined) control.setAttribute("aria-pressed", String(pressed));
  control.addEventListener("click", action);
  return control;
}

export function field(label, value, change, { type = "text", options, min, max, step, direction, disabled = false, placeholder } = {}) {
  const wrap = node("label", "designer-field");
  const title = node("span", "", label);
  const input = node(options ? "select" : type === "textarea" ? "textarea" : "input", "designer-input");
  if (options) {
    for (const option of options) {
      const [optionValue, optionLabel] = Array.isArray(option) ? option : [option, option];
      const item = node("option", "", String(optionLabel));
      item.value = optionValue;
      input.append(item);
    }
  } else if (type === "textarea") {
    input.rows = 3;
    if (max != null) input.maxLength = max;
  } else {
    input.type = type;
    if (min != null) input.min = min;
    if (max != null && type === "number") input.max = max;
    if (max != null && type === "text") input.maxLength = max;
    if (step != null) input.step = step;
  }
  if (type === "checkbox") input.checked = Boolean(value);
  else input.value = value ?? "";
  if (type === "number" || direction) input.dir = direction || "ltr";
  if (placeholder) input.placeholder = placeholder;
  input.disabled = disabled;
  input.addEventListener("change", () => {
    if (type === "number" && (input.value === "" || !input.validity.valid)) {
      input.reportValidity();
      input.value = value;
      return;
    }
    change(type === "checkbox" ? input.checked : type === "number" ? Number(input.value) : input.value);
  });
  wrap.classList.toggle("designer-check", type === "checkbox");
  wrap.append(title, input);
  return wrap;
}

const numeric = (min, max, step = 1) => ({ type: "number", min, max, step });
const color = { type: "color" };
const check = { type: "checkbox" };
const font = { options: fontFamilies };
const align = { options: [["right", "راست"], ["center", "وسط"], ["left", "چپ"]] };
export const snapNumber = (n) => Math.round(n * 100) / 100;
export const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

export function pageFields(page, onChange) {
  return fields(page, onChange, [
    ["paper", "اندازه کاغذ", { options: Object.keys(PAPER_SIZES) }],
    ["orientation", "جهت", { options: [["portrait", "عمودی"], ["landscape", "افقی"]] }],
    ["top", "حاشیه بالا (mm)", numeric(3, 35, 0.1)], ["right", "حاشیه راست (mm)", numeric(3, 35, 0.1)],
    ["bottom", "حاشیه پایین (mm)", numeric(3, 35, 0.1)], ["left", "حاشیه چپ (mm)", numeric(3, 35, 0.1)],
    ["scale", "حداکثر مقیاس چاپ (%)", numeric(50, 150)],
    ["header", "سربرگ", { max: 180 }], ["footer", "پابرگ", { max: 180 }],
    ["page_numbers", "شماره صفحات", check], ["print_colors", "چاپ و PDF رنگی", check],
  ]);
}

function fields(value, onChange, list, disabled = false) {
  const group = node("div", "designer-fields");
  for (const [key, title, props] of list) {
    group.append(field(title, value[key], (next) => onChange(key, next), { ...props, disabled }));
  }
  return group;
}

export function propertyFields(element, layout, onChange) {
  const bounds = designBounds(layout.page);
  const group = node("div", "designer-property-groups");
  group.append(node("h4", "", "موقعیت و اندازه"), fields(element, onChange, [
    ["x", "X (mm)", numeric(0, bounds.w, 0.01)], ["y", "Y (mm)", numeric(0, bounds.h, 0.01)],
    ["w", "عرض (mm)", numeric(2, bounds.w, 0.01)], ["h", "ارتفاع (mm)", numeric(2, bounds.h, 0.01)],
    ...(element.type === "table" ? [] : [["rotation", "چرخش (°)", numeric(-180, 180, 1)], ["aspect", "قفل نسبت ابعاد", check]]),
  ], element.locked));
  if (!SHAPE_TYPES.has(element.type)) {
    group.append(node("h4", "", "نوشته"), fields(element, onChange, [
      ...(["title", "text", "notes"].includes(element.type) ? [["text", "متن", { type: "textarea", max: 5000 }]] : []),
      ...(IMAGE_TYPES.has(element.type) && element.type === "logo" ? [] : [
        ["font", "قلم", font], ["font_size", "اندازه (pt)", numeric(5, 60, 0.5)],
        ["weight", "ضخامت قلم", { options: [400, 500, 600, 700, 800, 900] }], ["color", "رنگ نوشته", color],
        ["align", "تراز نوشته", align], ["line_height", "ارتفاع خط", numeric(0.8, 3, 0.1)], ["spacing", "فاصله حروف", numeric(-2, 8, 0.1)],
      ]),
    ], element.locked));
  }
  const bg = element.background === "transparent" ? "#ffffff" : element.background;
  group.append(node("h4", "", "ظاهر"), field("پس‌زمینه شفاف", element.background === "transparent",
    (value) => onChange("background", value ? "transparent" : bg), { ...check, disabled: element.locked }));
  group.append(fields({ ...element, background: bg }, onChange, [
    ["background", "رنگ پس‌زمینه", color], ["border", "رنگ کادر", color],
    ["border_width", "ضخامت کادر (mm)", numeric(0, 8, 0.1)], ["radius", "گردی گوشه‌ها (mm)", numeric(0, 40, 0.5)],
    ["opacity", "شفافیت", numeric(0, 1, 0.05)], ["padding", "فاصله داخلی (mm)", numeric(0, 12, 0.1)],
  ], element.locked));
  return group;
}

export function tableFields(config, onChange) {
  const wrap = node("div", "designer-property-groups");
  wrap.append(fields(config, (key, value) => onChange({ ...config, [key]: value }), [
    ["row_height", "حداقل ارتفاع ردیف (mm)", numeric(3, 35, 0.1)], ["cell_padding", "فاصله سلول (mm)", numeric(0, 8, 0.1)],
    ["border", "رنگ خطوط", color], ["border_width", "ضخامت خطوط (mm)", numeric(0, 3, 0.1)],
    ["background", "پس‌زمینه ردیف", color], ["header_background", "پس‌زمینه سرستون", color],
    ["header_color", "رنگ عنوان ستون", color], ["header_font", "قلم سرستون", font],
    ["header_size", "اندازه قلم سرستون (pt)", numeric(5, 35, 0.5)],
    ["alternate", "رنگ متناوب ردیف", check], ["alternate_background", "رنگ ردیف متناوب", color],
    ["repeat_header", "تکرار عنوان در صفحه بعد", check],
  ]));
  wrap.append(node("h4", "", "ستون‌های جدول"));
  config.columns.forEach((column, index) => {
    const row = node("fieldset", "designer-column");
    row.append(node("legend", "", column.label || column.key));
    const change = (key, value) => onChange({ ...config, columns: config.columns.map((item, i) => i === index ? { ...item, [key]: value } : item) });
    row.append(fields(column, change, [
      ["enabled", "نمایش ستون", { ...check }], ["label", "عنوان", { max: 180 }],
      ["width", "عرض نسبی", numeric(1, 100, 0.5)], ["align", "تراز", align],
    ]));
    if (column.enabled && config.columns.filter((item) => item.enabled).length === 1) row.querySelector("input").disabled = true;
    const moves = node("div", "designer-button-row");
    for (const [delta, label] of [[-1, "↑"], [1, "↓"]]) {
      const control = button(label, () => {
        const columns = [...config.columns];
        [columns[index], columns[index + delta]] = [columns[index + delta], columns[index]];
        onChange({ ...config, columns });
      }, { title: delta < 0 ? "انتقال ستون به بالا" : "انتقال ستون به پایین" });
      control.disabled = index + delta < 0 || index + delta >= config.columns.length;
      moves.append(control);
    }
    row.append(moves);
    wrap.append(row);
  });
  return wrap;
}

export function changePage(layout, key, value) {
  const page = { ...layout.page, [key]: value };
  const old = designBounds(layout.page);
  const bounds = designBounds(page);
  if (old.w === bounds.w && old.h === bounds.h) return { ...layout, page };
  const sx = bounds.w / old.w;
  const sy = bounds.h / old.h;
  const elements = layout.elements.map((element) => {
    const w = snapNumber(clamp(element.w * (element.aspect ? Math.min(sx, sy) : sx), 2, bounds.w));
    const h = snapNumber(clamp(element.h * (element.aspect ? Math.min(sx, sy) : sy), 2, bounds.h));
    return { ...element, w, h, x: snapNumber(clamp(element.x * sx, 0, bounds.w - w)),
      y: snapNumber(clamp(element.y * sy, 0, bounds.h - h)) };
  });
  return { ...layout, page, elements };
}
