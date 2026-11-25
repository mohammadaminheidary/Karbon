import { financeRequest } from "../finance/finance-api.js";
import { node } from "../finance/finance-utils.js";
import { button, field, pageFields, tableFields, changePage } from "./designer-fields.js";
import { mountInvoiceDesigner } from "./invoice-designer.js";

const path = "/settings/invoice-design";
const kinds = { sale: "فروش", purchase: "خرید" };
const settingsKeys = ["store", "signatures", "sale_finance", "purchase_finance", "sale_numbering", "purchase_numbering"];
const fileImages = { logo: "لوگوی فروشگاه", seller: "امضای فروشنده", stamp: "مهر شرکت" };
const sections = [
  ["store", "اطلاعات فروشگاه"], ["designer", "طراح بصری فاکتور"], ["numbering", "شماره‌گذاری"],
  ["finance", "مالیات و مبالغ"], ["table", "جدول اقلام"], ["signatures", "امضا و مهر"],
  ["print", "چاپ و PDF"], ["templates", "قالب‌ها"],
];
const copy = (value) => structuredClone(value);
const amountLimit = 999999999999;
const integer = (min, max, step = 1) => ({ type: "number", min, max, step });
const yesNo = { type: "checkbox" };
const text = { max: 180 };
const mountPromises = new WeakMap();

const storeFields = [
  ["name", "نام فروشگاه", text], ["legal_name", "نام حقوقی", text], ["registration", "شماره ثبت", text],
  ["national_id", "شناسه ملی", text], ["tax_id", "کد اقتصادی", text], ["phone", "تلفن ثابت", text],
  ["mobile", "تلفن همراه", text], ["email", "ایمیل", { ...text, direction: "ltr" }],
  ["website", "وب‌سایت", { ...text, direction: "ltr" }], ["postal_code", "کد پستی", text],
  ["address", "نشانی کامل", { type: "textarea", max: 700 }], ["slogan", "شعار یا توضیح", { type: "textarea", max: 350 }],
];
const numberingFields = [
  ["mode", "روش شماره‌گذاری", { options: [["legacy", "شماره‌گذاری فعلی کاربن"], ["automatic", "خودکار سفارشی"], ["manual", "دستی"]] }],
  ["prefix", "پیشوند", { max: 8, direction: "ltr" }], ["suffix", "پسوند", { max: 8, direction: "ltr" }],
  ["start", "شماره شروع", integer(1, 9999999999)], ["digits", "حداقل تعداد رقم", integer(1, 10)],
  ["yearly", "شروع مجدد در سال شمسی جدید", yesNo], ["allow_manual", "اجازه ورود شماره دستی", yesNo],
];
const financeFields = [
  ["currency", "واحد پول در فاکتور", { options: [["IRT", "تومان"], ["IRR", "ریال"]] }],
  ["symbol", "نماد دلخواه واحد پول", { max: 30 }], ["precision", "رقم اعشار در فاکتور", integer(0, 4)],
  ["tax_enabled", "مالیات فعال", yesNo], ["tax_rate", "نرخ مالیات (%)", integer(0, 100, .01)],
  ["tax_display", "نمایش مالیات", { options: [["separate", "ردیف جداگانه"], ["included", "در جمع اقلام"], ["hidden", "در مبلغ نهایی"]] }],
  ["discount_kind", "نوع تخفیف پیش‌فرض", { options: [["fixed", "مبلغ ثابت"], ["percent", "درصدی"]] }],
  ["discount_value", "مقدار تخفیف", integer(0, amountLimit)], ["shipping", "هزینه ارسال (تومان)", integer(0, amountLimit)],
  ["amount_words", "نمایش مبلغ به حروف", yesNo],
];

function sampleInvoice(settings, images, kind, layout) {
  const customer = { name: "آزاده رضایی", code: 1054, phone_numbers: ["09123456789"], address: "تهران، خیابان مطهری، پلاک 24" };
  const supplier = { name: "شرکت تامین نمونه", code: 78, phone_numbers: ["02188771234"], address: "تهران، خیابان بهشتی، پلاک 9" };
  return {
    invoice_code: kind === "sale" ? "SAL-00015" : "PUR-00007", jalali_date: "1405/08/17",
    jalali_payment_date: kind === "sale" ? "1405/08/24" : null, order_number: kind === "sale" ? "1012" : null,
    status: kind === "sale" ? "active" : "completed", customer: kind === "sale" ? customer : null,
    supplier: kind === "purchase" ? supplier : null, subtotal: 215000, discount: 15000, tax: 20000,
    shipping: 30000, total: 250000, paid: kind === "sale" ? 200000 : null, remaining: kind === "sale" ? 50000 : null,
    description: "لطفاً شماره فاکتور را هنگام پیگیری اعلام کنید.",
    delivery_address: kind === "sale" ? "تهران، خیابان شریعتی، پلاک 17" : null,
    payments: kind === "sale" ? [{ method: "pos", amount: 200000, jalali_date: "1405/08/17" }] : [],
    items: [
      { product_name: "بسته کاغذ تحریر سفید مخصوص چاپ دورو", product_code: "P-101", brand_name: "آریا", quantity: 2, unit: "بسته", unit_price: 75000, total: 150000 },
      { product_name: "دفتر یادداشت", product_code: "P-105", brand_name: "بهار", quantity: 1, unit: "عدد", unit_price: 65000, total: 65000 },
    ],
    presentation: { layout, kind, images, store: settings.store, signatures: settings.signatures, finance: settings[`${kind}_finance`] },
  };
}

export async function initializeInvoiceDesignSettings(panel) {
  if (!mountPromises.has(panel)) {
    const load = mount(panel).catch((error) => {
      mountPromises.delete(panel);
      panel.replaceChildren(node("p", "designer-status", error.message),
        button("تلاش مجدد", () => initializeInvoiceDesignSettings(panel)));
    });
    mountPromises.set(panel, load);
  }
  return mountPromises.get(panel);
}

async function mount(panel) {
  panel.classList.add("invoice-settings");
  const [initial, initialImages] = await Promise.all([financeRequest(path), financeRequest(`${path}/preview-assets`)]);
  let config = initial;
  let images = initialImages;
  let edited = false, saving = false, active = "store", selected = config.templates[0]?.id, loadingSection = 0;
  const editable = config.editable;
  const panelEdits = new Map();
  const title = node("h2", "", "تنظیمات فاکتور");
  const header = node("div", "invoice-settings-header");
  const status = node("p", "designer-status", editable ? "" : "ویرایش تنظیمات فاکتور در دسترس مدیر سیستم است.");
  status.setAttribute("role", "status");
  const tabs = node("div");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "بخش‌های تنظیمات فاکتور");
  const content = node("section", "invoice-settings-section");
  content.setAttribute("role", "tabpanel");
  content.id = "invoiceConfigurationPanel";
  const save = button("ذخیره تنظیمات", saveConfig, { primary: true });
  save.disabled = true;
  save.hidden = !editable;
  header.append(title, status, save);
  panel.replaceChildren(header, tabs, content);
  for (const [name, label] of sections) {
    const tab = button(label, () => show(name));
    tab.id = `invoice-config-${name}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", content.id);
    tab.dataset.section = name;
    tabs.append(tab);
  }
  tabs.addEventListener("keydown", (event) => {
    const index = sections.findIndex(([name]) => name === active);
    const destinations = { ArrowLeft: (index + 1) % sections.length,
      ArrowRight: (index + sections.length - 1) % sections.length, Home: 0, End: sections.length - 1 };
    if (!(event.key in destinations)) return;
    event.preventDefault();
    const name = sections[destinations[event.key]][0];
    show(name);
    tabs.querySelector(`[data-section="${name}"]`).focus();
  });
  window.addEventListener("beforeunload", (event) => {
    if (edited || [...panelEdits.values()].some((draft) => draft.dirty)) { event.preventDefault(); event.returnValue = true; }
  });

  function pending() {
    edited = true;
    save.disabled = saving;
    status.textContent = "تغییرات تنظیمات هنوز ذخیره نشده‌اند.";
  }

  async function saveConfig() {
    if (!edited || saving || !editable) return;
    saving = true;
    save.disabled = true;
    status.textContent = "در حال ذخیره…";
    const submitted = Object.fromEntries(settingsKeys.map((key) => [key, copy(config[key])]));
    try {
      const saved = await financeRequest(path, { method: "PUT", body: { ...submitted, revision: config.revision } });
      config.revision = saved.revision;
      edited = settingsKeys.some((key) => JSON.stringify(config[key]) !== JSON.stringify(submitted[key]));
      status.textContent = edited ? "تغییرات جدید هنوز ذخیره نشده‌اند." : "تنظیمات ذخیره شد.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      saving = false;
      save.disabled = !edited;
    }
  }

  function inputs(group, fields) {
    const grid = node("div", "invoice-settings-grid");
    fields.forEach(([key, label, options]) => {
      const state = config[group];
      const percent = key === "tax_rate" || (key === "discount_value" && state.discount_kind === "percent");
      const labelText = key === "discount_value" ? percent ? "تخفیف پیش‌فرض (%)" : "تخفیف پیش‌فرض (تومان)" : label;
      grid.append(field(labelText, percent ? state[key] / 100 : state[key], (value) => {
        if (!editable) return;
        state[key] = percent ? Math.round(value * 100) : value;
        if (key === "discount_kind") {
          state.discount_value = 0;
          show(active);
        }
        pending();
      }, { ...options, ...(percent ? integer(0, 100, .01) : {}), disabled: !editable }));
    });
    return grid;
  }

  function asset(key, group, valueKey) {
    const card = node("div", "invoice-settings-card");
    card.append(node("h4", "", fileImages[key]));
    const image = node("img", "invoice-asset-preview");
    image.alt = fileImages[key];
    if (images[key]) image.src = images[key];
    image.hidden = !images[key];
    const picker = node("input", "designer-input");
    picker.type = "file";
    picker.accept = "image/png,image/jpeg,image/webp";
    picker.setAttribute("aria-label", `بارگذاری یا تعویض ${fileImages[key]}`);
    picker.disabled = !editable;
    const remove = button("حذف تصویر", () => {
      config[group][valueKey] = null;
      delete images[key];
      image.removeAttribute("src");
      image.hidden = remove.hidden = true;
      pending();
    });
    remove.hidden = !images[key] || !editable;
    picker.addEventListener("change", async () => {
      const file = picker.files[0];
      if (!file) return;
      picker.disabled = remove.disabled = true;
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error("حداکثر حجم تصویر 2 مگابایت است.");
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("خواندن فایل انجام نشد."));
          reader.readAsDataURL(file);
        });
        const result = await financeRequest(`${path}/assets`, { method: "POST", body: { data: data.split(",")[1] } });
        const safe = `data:${result.mime};base64,${data.split(",")[1]}`;
        config[group][valueKey] = result.id;
        if (safe) image.src = images[key] = safe;
        image.hidden = !safe;
        remove.hidden = false;
        pending();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        picker.value = "";
        picker.disabled = remove.disabled = false;
      }
    });
    card.append(image, picker, remove);
    return card;
  }

  function cards(suffix, fields) {
    for (const [kind, label] of Object.entries(kinds)) {
      const card = node("section", "invoice-settings-card");
      card.append(node("h4", "", `فاکتور ${label}`), inputs(`${kind}_${suffix}`, fields));
      content.append(card);
    }
  }

  function templateChoice(onChange, label = "قالب فاکتور") {
    return field(label, selected, (value) => {
      selected = Number(value);
      onChange();
    }, { options: config.templates.map((item) => [item.id, `${kinds[item.kind]} · ${item.name}${item.default ? " (پیش‌فرض)" : ""}`]) });
  }

  function refreshMetadata(result) {
    const row = config.templates.find((template) => template.id === result.id);
    if (row) {
      row.name = result.name;
      row.revision = result.revision;
    } else config.templates.push({ id: result.id, name: result.name, kind: result.kind, revision: result.revision, default: false });
  }

  async function saveTemplate(id, body) {
    const result = await financeRequest(`${path}/templates/${id}`, { method: "PUT", body });
    refreshMetadata(result);
    return result;
  }

  const draftKey = (id) => `karbon-invoice-draft:${config.scope}:${id}`;

  async function openDesigner(id, trigger) {
    if (!id) return;
    if (trigger) trigger.disabled = true;
    try {
      const pending = panelEdits.get(id);
      if (pending?.dirty && !await pending.flush()) return;
      const template = await financeRequest(`${path}/templates/${id}`, { cache: "no-store" });
      panelEdits.delete(id);
      mountInvoiceDesigner(template, {
        editable, draftKey: draftKey(id),
        previewInvoice: (layout) => sampleInvoice(config, images, template.kind, layout),
        onSave: (data) => saveTemplate(id, data),
        onExit: () => show(active),
      });
    } catch (error) {
      status.textContent = error.message;
    } finally {
      if (trigger) trigger.disabled = false;
    }
  }

  function showTemplates() {
    const form = node("form", "invoice-settings-form");
    const list = node("div", "invoice-template-list");
    let kind = "sale", name = "";
    form.append(node("h3", "", "قالب جدید"),
      field("نوع فاکتور", kind, (value) => { kind = value; }, { options: Object.entries(kinds) }),
      field("نام قالب", "", (value) => { name = value; }, { max: 100 }));
    const create = node("button", "designer-button designer-primary", "ایجاد قالب");
    create.type = "submit";
    form.append(create);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      run(create, async () => {
        const result = await financeRequest(`${path}/templates`, { method: "POST", body: { kind, name: name.trim() } });
        refreshMetadata(result);
        selected = result.id;
        show(active);
      });
    });
    for (const item of config.templates) {
      const card = node("article", "invoice-template");
      const actions = node("div", "designer-button-row");
      const open = button("باز کردن طراح", () => openDesigner(item.id, open));
      actions.append(open);
      card.append(node("strong", "", item.name), node("small", "", `${kinds[item.kind]} · نسخه ${item.revision}${item.default ? " · پیش‌فرض" : ""}`), actions);
      function command(label, action) {
        const control = button(label, () => run(control, action));
        actions.append(control);
      }
      if (editable) {
        command("تغییر نام", async () => {
          const value = window.prompt("نام قالب", item.name)?.trim();
          if (!value || value === item.name) return;
          const latest = await financeRequest(`${path}/templates/${item.id}`, { cache: "no-store" });
          await saveTemplate(item.id, { revision: latest.revision, name: value, layout: latest.layout });
          show(active);
        });
        command("تکثیر", async () => {
          const value = window.prompt("نام قالب جدید", `${item.name} (کپی)`)?.trim();
          if (!value) return;
          const result = await financeRequest(`${path}/templates`, { method: "POST", body: { kind: item.kind, name: value, copy_from: item.id } });
          refreshMetadata(result);
          show(active);
        });
        command("بازنشانی چیدمان", async () => {
          if (!window.confirm("چیدمان جاری با قالب استاندارد جایگزین شود؟")) return;
          const layout = await financeRequest(`${path}/templates/standard/${item.kind}`);
          await saveTemplate(item.id, { revision: item.revision, name: item.name, layout });
          show(active);
        });
        if (!item.default) {
          command("پیش‌فرض", async () => {
            await financeRequest(`${path}/templates/${item.id}/default`, { method: "PUT" });
            config.templates.filter((template) => template.kind === item.kind).forEach((template) => { template.default = item.id === template.id; });
            show(active);
          });
          command("حذف", async () => {
            if (!window.confirm(`قالب «${item.name}» حذف شود؟`)) return;
            await financeRequest(`${path}/templates/${item.id}?revision=${item.revision}`, { method: "DELETE" });
            config.templates = config.templates.filter((template) => template.id !== item.id);
            if (selected === item.id) selected = config.templates[0]?.id;
            show(active);
          });
        }
      }
      list.append(card);
    }
    content.append(list);
    if (editable) content.append(form);
  }

  async function run(button, action) {
    button.disabled = true;
    status.textContent = "";
    try { await action(); }
    catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  }

  async function layoutSettings(section) {
    const request = ++loadingSection;
    content.append(templateChoice(() => show(section)));
    const region = node("div", "invoice-settings-card", "در حال دریافت قالب…");
    content.append(region);
    try {
      let draft = panelEdits.get(selected);
      if (!draft || !draft.dirty) {
        const current = await financeRequest(`${path}/templates/${selected}`, { cache: "no-store" });
        if (request !== loadingSection) return;
        draft = { current, layout: current.layout, dirty: false };
        panelEdits.set(current.id, draft);
      }
      region.textContent = "";
      const fields = node("div");
      const open = button("باز کردن پیش‌نمایش در طراح", () => openDesigner(draft.current.id, open));
      const store = button("ذخیره قالب", () => flush(), { primary: true });
      const id = draft.current.id;
      store.hidden = !editable;
      const persistDraft = () => {
        try {
          if (draft.dirty) localStorage.setItem(draftKey(id), JSON.stringify({
            revision: draft.current.revision, name: draft.current.name, layout: draft.layout,
          }));
          else localStorage.removeItem(draftKey(id));
        } catch { /* A browser quota error leaves the in-memory draft available. */ }
      };
      async function flush() {
        clearTimeout(draft.timer);
        if (draft.saving) return draft.saving;
        if (!draft.dirty) return true;
        const sent = draft.layout;
        draft.saving = (async () => {
          try {
            status.textContent = "در حال ذخیره قالب…";
            draft.current = await saveTemplate(id, { revision: draft.current.revision, name: draft.current.name, layout: sent });
            draft.dirty = sent !== draft.layout;
            persistDraft();
            status.textContent = draft.dirty ? "تغییرات جدید هنوز ذخیره نشده‌اند." : "قالب ذخیره شد.";
            if (draft.dirty) draft.timer = setTimeout(draft.flush, 500);
          } catch (error) {
            status.textContent = error.message;
          } finally {
            draft.saving = null;
            store.disabled = !draft.dirty;
          }
          return !draft.dirty;
        })();
        return draft.saving;
      }
      draft.flush = flush;
      function refresh() {
        fields.replaceChildren(section === "table"
          ? tableFields(draft.layout.table, (table) => update({ ...draft.layout, table }))
          : pageFields(draft.layout.page, (key, value) => update(changePage(draft.layout, key, value))));
        if (!editable) fields.querySelectorAll("input, select, button").forEach((element) => { element.disabled = true; });
        store.disabled = !draft.dirty;
      }
      function update(next) {
        draft.layout = next;
        draft.dirty = true;
        status.textContent = "در انتظار ذخیره قالب…";
        persistDraft();
        clearTimeout(draft.timer);
        draft.timer = setTimeout(flush, 800);
        refresh();
      }
      const actions = node("div", "designer-button-row");
      actions.append(store, open);
      region.append(fields, actions);
      refresh();
    } catch (error) {
      if (request === loadingSection) region.textContent = error.message;
    }
  }

  function show(section) {
    loadingSection++;
    active = section;
    for (const tab of tabs.children) {
      const selectedTab = tab.dataset.section === section;
      tab.setAttribute("aria-selected", String(selectedTab));
      tab.tabIndex = selectedTab ? 0 : -1;
      if (selectedTab) content.setAttribute("aria-labelledby", tab.id);
    }
    content.replaceChildren(node("h3", "", sections.find(([key]) => key === section)[1]));
    if (section === "store") content.append(inputs("store", storeFields), asset("logo", "store", "logo"));
    else if (section === "signatures") {
      content.append(inputs("signatures", [
        ["seller_enabled", "امضای فروشنده فعال", yesNo], ["seller_label", "عنوان امضای فروشنده", text],
        ["customer_enabled", "محل امضای مشتری فعال", yesNo], ["customer_label", "عنوان امضای مشتری", text],
        ["stamp_enabled", "مهر شرکت فعال", yesNo], ["stamp_label", "عنوان مهر شرکت", text],
      ]), asset("seller", "signatures", "seller_image"), asset("stamp", "signatures", "stamp_image"));
    } else if (section === "finance") {
      content.append(node("p", "designer-hint", "محاسبات و دفتر مالی بر پایه تومان هستند. نمایش ریال با تبدیل 1 تومان به 10 ریال انجام می‌شود."));
      cards("finance", financeFields);
    } else if (section === "numbering") cards("numbering", numberingFields);
    else if (section === "templates") showTemplates();
    else if (section === "designer") {
      const open = button("باز کردن طراح بصری", () => openDesigner(selected, open), { primary: true });
      const row = node("div", "invoice-settings-customer-layout");
      row.append(templateChoice(() => {}), open);
      content.append(row);
    } else layoutSettings(section);
  }

  show(active);
}
