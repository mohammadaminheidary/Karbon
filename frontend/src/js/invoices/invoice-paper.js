import { node, normalizeDigits } from "../finance/finance-utils.js";

export const PAPER_SIZES = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };
export const PX_PER_MM = 96 / 25.4;
export const IMAGE_TYPES = new Set(["logo", "seller", "stamp"]);
export const SHAPE_TYPES = new Set(["hline", "vline", "rectangle", "ellipse"]);
const imageURL = /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/;
const labels = {
  logo: "لوگوی فروشگاه", store_name: "نام فروشگاه", company: "اطلاعات ثبتی", address: "نشانی فروشگاه", contacts: "راه‌های ارتباطی",
  title: "عنوان فاکتور", number: "شماره فاکتور", date: "تاریخ فاکتور", due_date: "تاریخ سررسید", status: "وضعیت", reference: "شماره مرجع",
  customer: "مشتری", supplier: "تأمین‌کننده", party_contact: "تماس طرف حساب", billing_address: "نشانی صورتحساب", delivery_address: "نشانی تحویل",
  table: "جدول اقلام", subtotal: "جمع اقلام", discount: "تخفیف", tax: "مالیات", shipping: "هزینه ارسال", total: "مبلغ نهایی",
  amount_words: "مبلغ به حروف", currency: "واحد پول", seller: "امضای فروشنده", signature: "امضای مشتری", stamp: "مهر شرکت",
  text: "متن دلخواه", notes: "یادداشت و شرایط", hline: "خط افقی", vline: "خط عمودی", rectangle: "مستطیل", ellipse: "بیضی",
  payments: "روش‌های پرداخت", paid: "پرداخت‌شده", remaining: "مانده",
};
export const ELEMENT_GROUPS = [
  ["فروشگاه", ["logo", "store_name", "company", "address", "contacts"]],
  ["فاکتور", ["title", "number", "date", "due_date", "status", "reference"]],
  ["طرف حساب", ["customer", "supplier", "party_contact", "billing_address", "delivery_address"]],
  ["اقلام و مبالغ", ["table", "subtotal", "discount", "tax", "shipping", "total", "amount_words", "currency", "payments", "paid", "remaining"]],
  ["امضا و متن", ["seller", "signature", "stamp", "text", "notes"]],
  ["شکل‌ها", ["hline", "vline", "rectangle", "ellipse"]],
];
export const elementLabel = (type) => labels[type];
const round = (n) => Math.round(n * 100) / 100;
export const mm = (n) => `${round(n)}mm`;
export const fontFamilies = ["Vazirmatn", "Arial", "Tahoma", "Georgia"];
const currencyName = (finance) => finance.symbol || (finance.currency === "IRR" ? "ریال" : "تومان");
const zone = (list, separator = " · ") => list.filter(Boolean).join(separator);
const textLabel = (key, value) => value == null || value === "" ? "" : `${labels[key]}: ${value}`;
const leftToRight = /([A-Za-z0-9]+(?:[.,:@/+_-][A-Za-z0-9]+)*)/g;

function setInvoiceText(target, value) {
  target.replaceChildren(...String(value).split(leftToRight).map((part, index) => {
    if (index % 2 === 0) return document.createTextNode(part);
    const inline = node("bdi", "", part);
    inline.dir = "ltr";
    return inline;
  }));
}

const methods = { cash: "نقدی", pos: "کارت‌خوان", transfer: "کارت‌به‌کارت" };

export function pageGeometry(page) {
  const size = PAPER_SIZES[page.paper];
  const [width, height] = page.orientation === "landscape" ? [...size].reverse() : size;
  const scale = page.scale / 100;
  return {
    width, height, scale, innerWidth: (width - page.right - page.left) / scale,
    innerHeight: (height - page.top - page.bottom) / scale,
  };
}

export function designBounds(page) {
  const [width, height] = page.orientation === "landscape" ? [...PAPER_SIZES[page.paper]].reverse() : PAPER_SIZES[page.paper];
  return { w: width - page.left - page.right, h: height - page.top - page.bottom };
}

function words(number) {
  const one = ["", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه", "ده", "یازده", "دوازده", "سیزده", "چهارده", "پانزده", "شانزده", "هفده", "هجده", "نوزده"];
  const ten = ["", "", "بیست", "سی", "چهل", "پنجاه", "شصت", "هفتاد", "هشتاد", "نود"];
  const hundred = ["", "صد", "دویست", "سیصد", "چهارصد", "پانصد", "ششصد", "هفتصد", "هشتصد", "نهصد"];
  const units = ["", "هزار", "میلیون", "میلیارد", "تریلیون"];
  const parts = [];
  for (let value = number, index = 0; value > 0; value = Math.floor(value / 1000), index++) {
    const chunk = value % 1000;
    if (!chunk) continue;
    const rest = chunk % 100;
    const phrase = zone([hundred[Math.floor(chunk / 100)], rest < 20 ? one[rest] : zone([ten[Math.floor(rest / 10)], one[rest % 10]], " و ")], " و ");
    parts.unshift(zone([phrase, units[index]], " "));
  }
  return parts.join(" و ") || "صفر";
}

export function displayMoney(value, finance = {}, unit = true) {
  if (value == null) return "—";
  const precision = finance.precision || 0;
  const converted = Number(value) * (finance.currency === "IRR" ? 10 : 1);
  const amount = new Intl.NumberFormat("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision }).format(converted);
  return unit ? `${amount} ${currencyName(finance)}` : amount;
}

function partySummary(party) {
  return party ? zone([party.name, party.code == null ? "" : `کد ${party.code}`, ...(party.phone_numbers || []), party.address]) : "";
}

export function elementValue(element, invoice) {
  const { presentation = {}, supplier, customer } = invoice;
  const { store = {}, signatures = {}, finance = {} } = presentation;
  const party = customer || supplier;
  const monetary = (type, number) => textLabel(type, displayMoney(number, finance));
  switch (element.type) {
    case "store_name": return store.name;
    case "company": return zone([store.legal_name, store.registration && `ثبت ${store.registration}`, store.national_id && `شناسه ملی ${store.national_id}`, store.tax_id && `شناسه اقتصادی ${store.tax_id}`, store.slogan], "\n");
    case "address": return zone([store.address, store.postal_code && `کد پستی ${store.postal_code}`]);
    case "contacts": return zone([store.phone, store.mobile, store.email, store.website]);
    case "title": return element.text || (presentation.kind === "purchase" ? "فاکتور خرید" : "فاکتور فروش");
    case "number": return textLabel("number", invoice.invoice_code);
    case "date": return textLabel("date", invoice.jalali_date);
    case "due_date": return textLabel("due_date", invoice.jalali_payment_date);
    case "reference": return textLabel("reference", invoice.reference_number || invoice.order_number);
    case "status": return textLabel("status", { active: "فعال", completed: "تکمیل‌شده" }[invoice.status]);
    case "customer": return textLabel("customer", partySummary(customer));
    case "supplier": return textLabel("supplier", partySummary(supplier));
    case "party_contact": return zone([...(party?.phone_numbers || []), party?.email]);
    case "billing_address": return party?.billing_address || party?.address;
    case "delivery_address": return invoice.delivery_address || party?.delivery_address || (presentation.kind === "purchase" ? store.address : "");
    case "subtotal": return monetary("subtotal", finance.tax_display === "included" ? invoice.subtotal + (invoice.tax || 0) : invoice.subtotal);
    case "discount": return invoice.discount ? monetary("discount", invoice.discount) : "";
    case "tax": return invoice.tax && (finance.tax_display || "separate") === "separate" ? monetary("tax", invoice.tax) : "";
    case "shipping": return invoice.shipping ? monetary("shipping", invoice.shipping) : "";
    case "total": return monetary("total", invoice.total);
    case "paid": return invoice.paid == null ? "" : monetary("paid", invoice.paid);
    case "remaining": return invoice.remaining == null ? "" : monetary("remaining", invoice.remaining);
    case "currency": return currencyName(finance);
    case "amount_words": return finance.amount_words ? `${words(invoice.total * (finance.currency === "IRR" ? 10 : 1))} ${currencyName(finance)}` : "";
    case "notes": return zone([invoice.description, element.text], "\n");
    case "text": return element.text;
    case "signature": return signatures.customer_enabled ? signatures.customer_label : "";
    case "payments": return invoice.payments?.map((payment) => zone([methods[payment.method], payment.account_name, displayMoney(payment.amount, finance), payment.jalali_date])).join("\n");
    default: return "";
  }
}

export function applyElementStyle(box, element) {
  Object.assign(box.style, {
    left: mm(element.x), top: mm(element.y), width: mm(element.w), minHeight: mm(element.h),
    transform: element.rotation ? `rotate(${element.rotation}deg)` : "",
    opacity: element.opacity, fontFamily: `"${element.font}", Vazirmatn, sans-serif`,
    fontSize: `${element.font_size}pt`, fontWeight: element.weight, lineHeight: element.line_height,
    letterSpacing: `${element.spacing}px`, color: element.color, textAlign: element.align,
    backgroundColor: element.background, border: `${mm(element.border_width)} solid ${element.border}`,
    borderRadius: element.type === "ellipse" ? "50%" : mm(element.radius), padding: mm(element.padding),
  });
}

export function makeTable(element, invoice, rows = invoice.items || [], header = true) {
  const config = invoice.presentation.layout.table;
  const finance = invoice.presentation.finance;
  const columns = config.columns.filter((column) => column.enabled);
  const table = node("table", "invoice-product-table");
  for (const [name, value] of Object.entries({
    "--cell-pad": mm(config.cell_padding), "--cell-border": `${mm(config.border_width)} solid ${config.border}`,
    "--row-height": mm(config.row_height), "--row-background": config.background,
    "--alternate-background": config.alternate ? config.alternate_background : config.background,
    "--table-header-background": config.header_background, "--table-header-color": config.header_color,
    "--table-header-font": `"${config.header_font}", Vazirmatn, sans-serif`, "--table-header-size": `${config.header_size}pt`,
  })) table.style.setProperty(name, value);
  const widths = columns.reduce((sum, column) => sum + column.width, 0);
  const colgroup = node("colgroup");
  for (const column of columns) {
    const col = node("col");
    col.style.width = `${100 * column.width / widths}%`;
    colgroup.append(col);
  }
  table.append(colgroup);
  if (header) {
    const row = table.createTHead().insertRow();
    for (const column of columns) {
      const field = node("th", "", normalizeDigits(column.label));
      field.scope = "col";
      field.style.textAlign = column.align;
      row.append(field);
    }
  }
  const body = table.createTBody();
  for (const item of rows) appendRow(body, columns, finance, item);
  return { table, body, columns, finance };
}

function appendRow(body, columns, finance, item) {
  const row = body.insertRow();
  for (const column of columns) {
    const value = item[column.key];
    const money = ["unit_price", "discount", "tax", "total"].includes(column.key);
    const cell = row.insertCell();
    cell.dir = ["product_code", "quantity", "unit_price", "discount", "tax", "total"].includes(column.key) ? "ltr" : "auto";
    cell.style.textAlign = column.align;
    cell.textContent = money ? displayMoney(value, finance, false) : normalizeDigits(value ?? "—");
  }
  return row;
}

export function makeElement(element, invoice, { editing = false, index = 0, value, skipContent = false } = {}) {
  const box = node("div", `invoice-element invoice-element--${element.type}`);
  box.dir = "rtl";
  box.style.zIndex = index + 1;
  applyElementStyle(box, element);
  if (skipContent) return box;
  const { images = {}, signatures = {} } = invoice.presentation;
  if (element.type === "table") {
    box.append(makeTable(element, invoice, editing ? invoice.items.slice(0, 2) : invoice.items).table);
  } else if (IMAGE_TYPES.has(element.type)) {
    const enabled = element.type === "logo" || signatures[`${element.type}_enabled`];
    const src = enabled && images[element.type];
    if (src && imageURL.test(src)) {
      const img = node("img");
      img.src = src;
      img.alt = labels[element.type];
      box.append(img);
    }
    if (enabled && signatures[`${element.type}_label`]) box.append(node("span", "invoice-image-label", signatures[`${element.type}_label`]));
    if (!box.childNodes.length && !editing) return null;
  } else if (!SHAPE_TYPES.has(element.type)) {
    const content = normalizeDigits(value ?? elementValue(element, invoice) ?? "");
    if (!content && !editing) return null;
    const span = node("span", editing && !content ? "invoice-element-placeholder" : "");
    setInvoiceText(span, content || labels[element.type]);
    box.append(span);
  }
  if (editing && !box.childNodes.length && !SHAPE_TYPES.has(element.type)) box.append(node("span", "invoice-element-placeholder", labels[element.type]));
  return box;
}

export function makePaper(page, editing = false) {
  const geometry = pageGeometry(page);
  const paper = node("div", "invoice-paper");
  paper.dir = "rtl";
  paper.style.width = mm(geometry.width);
  paper.style.height = mm(geometry.height);
  paper.classList.toggle("invoice-paper-monochrome", page.print_colors === false);
  const content = node("div", "invoice-paper-content");
  Object.assign(content.style, {
    top: mm(page.top), left: mm(page.left), width: mm(geometry.innerWidth), height: mm(geometry.innerHeight),
    transform: editing ? "" : `scale(${geometry.scale})`,
  });
  const header = node("div", "invoice-paper-running-header");
  setInvoiceText(header, normalizeDigits(page.header));
  const footer = node("div", "invoice-paper-running-footer");
  for (const area of [header, footer]) {
    area.style.left = mm(page.left);
    area.style.right = mm(page.right);
  }
  header.style.top = mm(Math.max(0, page.top - 6));
  footer.style.bottom = mm(Math.max(0, page.bottom - 6));
  paper.append(header, content, footer);
  return { paper, content, footer, ...geometry };
}

function printableGeometry(element, width) {
  const w = Math.min(width, element.w);
  return { ...element, w, x: Math.min(element.x, width - w) };
}

// Measure the same HTML that is printed. Page breaks are never inferred from the
// number of rows because Persian words and mixed-language descriptions wrap.
export async function renderInvoicePages(invoice) {
  await document.fonts.load('400 12pt "Vazirmatn"');
  const { page, elements, table } = invoice.presentation.layout;
  const visible = elements.filter((element) => element.visible);
  const usedWidth = Math.max(1, ...visible.map((element) => element.x + element.w));
  const renderingPage = { ...page, scale: Math.min(page.scale, designBounds(page).w / usedWidth * 100) };
  const stage = node("div", "invoice-measure-stage");
  stage.setAttribute("aria-hidden", "true");
  document.body.append(stage);
  const pages = [];
  try {
    function nextPage() {
      const part = makePaper(renderingPage);
      stage.append(part.paper);
      pages.push(part);
      return part;
    }
    const first = nextPage();
    const ensurePage = (index) => {
      while (pages.length <= index) nextPage();
      return pages[index];
    };
    const { innerHeight: limit, innerWidth: width } = first;
    const measure = (box) => box.offsetHeight / PX_PER_MM;
    const enabled = elements.map((element, index) => ({ element: printableGeometry(element, width), index }))
      .filter(({ element }) => element.visible);
    const flow = enabled.find(({ element }) => element.type === "table");
    const following = flow ? enabled.filter(({ element }) =>
      element.id !== flow.element.id && element.y >= flow.element.y + flow.element.h - 0.02) : [];
    const after = new Set(following.map(({ element }) => element.id));
    const renderBox = ({ element, index }, pageIndex = 0, y = element.y) => {
      while (y >= limit) { y -= limit; pageIndex++; }
      let part = ensurePage(pageIndex);
      const geometry = { ...element, y, h: Math.min(element.h, limit) };
      const box = makeElement(geometry, invoice, { index });
      if (!box) return;
      part.content.append(box);
      if (y + measure(box) <= limit + 0.2) return;
      if (measure(box) <= limit && (after.has(element.id) || !flow)) {
        part = ensurePage(pageIndex + 1);
        box.style.top = "0";
        part.content.append(box);
        return;
      }
      if (SHAPE_TYPES.has(element.type) || IMAGE_TYPES.has(element.type)) {
        box.style.height = mm(Math.max(0, limit - y));
        box.style.minHeight = "0";
        return;
      }
      const text = normalizeDigits(elementValue(element, invoice) ?? "");
      if (!text) return;
      box.remove();
      const segments = typeof Intl.Segmenter === "function"
        ? [...new Intl.Segmenter("fa", { granularity: "grapheme" }).segment(text)].map(({ segment }) => segment) : [...text];
      let start = 0;
      while (start < segments.length) {
        const chunk = makeElement({ ...geometry, h: 0, y }, invoice, { index, value: " " });
        chunk.replaceChildren(node("span"));
        part.content.append(chunk);
        let low = 0;
        let high = segments.length - start;
        while (low < high) {
          const count = Math.ceil((low + high) / 2);
          setInvoiceText(chunk.firstChild, segments.slice(start, start + count).join(""));
          if (y + measure(chunk) <= limit + 0.2) low = count;
          else high = count - 1;
        }
        if (low) setInvoiceText(chunk.firstChild, segments.slice(start, start + low).join(""));
        else chunk.remove();
        start += low;
        if (start < segments.length) {
          if (!low && y === 0) throw new Error("متن با ابعاد کاغذ و قلم انتخاب‌شده سازگار نیست.");
          part = ensurePage(++pageIndex);
          y = 0;
        }
      }
    };
    for (const entry of enabled) {
      if (entry !== flow && !after.has(entry.element.id)) renderBox(entry);
    }
    if (flow) {
      const { element, index } = flow;
      let part = first;
      let pageIndex = 0;
      let y = element.y < limit ? element.y : 0;
      let box, tablePart, count;
      function startTable(header) {
        box = makeElement({ ...element, y, h: 0 }, invoice, { index, skipContent: true });
        tablePart = makeTable(element, invoice, [], header);
        box.append(tablePart.table);
        part.content.append(box);
        count = 0;
      }
      startTable(true);
      for (const [itemIndex, item] of (invoice.items || []).entries()) {
        let row = appendRow(tablePart.body, tablePart.columns, tablePart.finance, item);
        if (y + measure(box) > limit) {
          row.remove();
          if (!count) box.remove();
          part = ensurePage(++pageIndex);
          y = 0;
          startTable(!count && pageIndex === 1 || table.repeat_header);
          row = appendRow(tablePart.body, tablePart.columns, tablePart.finance, item);
          if (measure(box) > limit + 0.2) throw new Error("یک ردیف از ارتفاع صفحه بلندتر است. عرض ستون‌ها یا اندازه قلم را تنظیم کنید.");
        }
        count++;
        row.dataset.parity = String((itemIndex + 1) % 2);
      }
      const end = y + measure(box);
      const base = element.y + element.h;
      if (following.length) {
        let shift = pageIndex === 0 ? Math.max(0, end - base) : end - base;
        const top = Math.min(...following.map(({ element }) => element.y));
        const bottom = Math.max(...following.map(({ element }) => element.y + element.h));
        if (bottom + shift > limit && bottom - top <= limit) {
          ++pageIndex;
          shift = -top;
        }
        for (const entry of following) renderBox(entry, pageIndex, entry.element.y + shift);
      }
    }
    for (const [index, part] of pages.entries()) {
      const text = node("span");
      setInvoiceText(text, normalizeDigits(page.footer));
      part.footer.replaceChildren(text);
      if (page.page_numbers) {
        const number = node("bdi", "", `${index + 1} / ${pages.length}`);
        number.dir = "ltr";
        part.footer.append(number);
      }
    }
    await Promise.all(pages.flatMap(({ paper }) => [...paper.querySelectorAll("img")].map((image) => image.decode().catch(() => image.remove()))));
    return pages.map(({ paper }) => paper);
  } finally {
    stage.remove();
  }
}

export function renderScaledPages(container, papers) {
  container.replaceChildren();
  const observers = [];
  for (const paper of papers) {
    const wrapper = node("div", "invoice-view-sheet");
    wrapper.append(paper);
    container.append(wrapper);
    const width = parseFloat(paper.style.width) * PX_PER_MM;
    const height = parseFloat(paper.style.height) * PX_PER_MM;
    wrapper.style.maxWidth = `${width}px`;
    function resize() {
      const scale = Math.min(1, wrapper.clientWidth / width);
      paper.style.transform = `scale(${scale})`;
      wrapper.style.height = `${height * scale}px`;
    }
    const observer = new ResizeObserver(resize);
    observer.observe(wrapper);
    observers.push(observer);
    resize();
  }
  return () => observers.forEach((observer) => observer.disconnect());
}

export function beginPrint(papers, page) {
  document.getElementById("invoiceDesignerPrint")?.remove();
  const root = node("div");
  root.id = "invoiceDesignerPrint";
  const printStyle = node("style");
  const { width, height } = pageGeometry(page);
  printStyle.textContent = `@media print { @page { size: ${mm(width)} ${mm(height)}; margin: 0; } }`;
  const pages = papers.map((source) => {
    const paper = source.cloneNode(true);
    paper.style.transform = "";
    return paper;
  });
  root.append(printStyle, ...pages);
  document.body.append(root);
  window.addEventListener("afterprint", () => root.remove(), { once: true });
  window.print();
}

async function embeddedSheetStyles() {
  const rules = [...document.styleSheets].flatMap((sheet) => {
    try { return [...sheet.cssRules]; } catch { return []; }
  });
  const css = rules.filter((rule) => rule.selectorText?.startsWith(".invoice-") &&
    !rule.selectorText.includes("view-sheet") && !rule.selectorText.includes("measure-stage")).map((rule) => rule.cssText);
  const font = rules.find((rule) => rule.style?.getPropertyValue("font-family").includes("Vazirmatn") &&
    rule.style.getPropertyValue("src").startsWith("url("));
  if (!font) throw new Error("فونت فاکتور برای خروجی تصویر پیدا نشد.");
  const source = font.style.getPropertyValue("src").match(/url\(["']?([^"')]+)["']?\)/)?.[1];
  const response = await fetch(new URL(source, font.parentStyleSheet.href || document.baseURI));
  if (!response.ok) throw new Error("بارگذاری فونت فاکتور انجام نشد.");
  const fontBlob = await response.blob();
  const fontURL = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(fontBlob);
  });
  return `* { box-sizing: border-box; } @font-face { font-family: Vazirmatn; src: url("${fontURL}"); font-weight: 400 900; } ${css.join("\n")}`;
}

export async function rasterizeInvoicePages(papers, scale = 2) {
  const css = await embeddedSheetStyles();
  const canvases = [];
  for (const paper of papers) {
    const width = Math.ceil(parseFloat(paper.style.width) * PX_PER_MM);
    const height = Math.ceil(parseFloat(paper.style.height) * PX_PER_MM);
    const html = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    const style = node("style", "", css);
    const sheet = paper.cloneNode(true);
    sheet.style.transform = "";
    html.append(style, sheet);
    const xhtml = new XMLSerializer().serializeToString(html);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    const canvas = node("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    canvases.push(canvas);
  }
  return canvases;
}
