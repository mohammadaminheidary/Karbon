import { Dialog } from "../components/dialog.js";
import { financeRequest } from "../finance/finance-api.js";
import { node, money } from "../finance/finance-utils.js";
import { formatNumber } from "../customers/customer-utils.js";

const WIDTH = 794,
  HEIGHT = 1123,
  MARGIN = 48,
  BOTTOM = 1054;
const methodNames = {
  pos: "کارت‌خوان",
  cash: "نقدی",
  transfer: "کارت‌به‌کارت",
};
const encoder = new TextEncoder();

function wrap(ctx, value, width) {
  const lines = [];
  for (const paragraph of String(value ?? "").split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (ctx.measureText(word).width > width) {
        if (line) {
          lines.push(line);
          line = "";
        }
        const segments =
          typeof Intl.Segmenter === "function"
            ? [
                ...new Intl.Segmenter("fa", {
                  granularity: "grapheme",
                }).segment(word),
              ].map((item) => item.segment)
            : [...word];
        for (const char of segments) {
          if (line && ctx.measureText(line + char).width > width) {
            lines.push(line);
            line = "";
          }
          line += char;
        }
      } else if (line && ctx.measureText(`${line} ${word}`).width > width) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

export async function renderInvoice(invoice, scale = 3) {
  await document.fonts.load('400 14px "Vazirmatn"');
  await document.fonts.load('700 14px "Vazirmatn"');
  await document.fonts.ready;
  if (!document.fonts.check('400 14px "Vazirmatn"'))
    throw new Error("فونت فارسی بارگذاری نشد. دوباره تلاش کنید.");
  const pages = [];
  let canvas, ctx, y;
  function font(size = 12, weight = 400) {
    ctx.font = `${weight} ${size}px Vazirmatn, sans-serif`;
  }
  function text(
    value,
    x,
    top,
    {
      size = 12,
      weight = 400,
      color = "#0f172a",
      align = "right",
      direction = "rtl",
    } = {},
  ) {
    font(size, weight);
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.direction = direction;
    ctx.textBaseline = "top";
    ctx.fillText(String(value), x, top);
  }
  function line(top, color = "#e2e8f0") {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN, top);
    ctx.lineTo(WIDTH - MARGIN, top);
    ctx.stroke();
  }
  function newPage() {
    canvas = document.createElement("canvas");
    canvas.width = WIDTH * scale;
    canvas.height = HEIGHT * scale;
    ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("مرورگر امکان تولید تصویر فاکتور را ندارد.");
    ctx.scale(scale, scale);
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    pages.push(canvas);
    text(invoice.store?.name || "فاکتور فروش", WIDTH - MARGIN, 36, {
      size: 24,
      weight: 700,
      color: "#1e40af",
    });
    text(invoice.invoice_code, MARGIN, 40, {
      size: 13,
      weight: 700,
      align: "left",
      direction: "ltr",
    });
    text(`تاریخ فاکتور: ${invoice.jalali_date}`, WIDTH - MARGIN, 82, {
      size: 12,
    });
    text(`شماره سفارش: ${invoice.order_number}`, MARGIN, 82, { align: "left" });
    line(114, "#1e40af");
    y = 134;
  }
  function ensure(height, table = false) {
    if (y + height > BOTTOM) {
      newPage();
      if (table) tableHeader();
    }
  }
  function paragraph(
    value,
    { label = "", width = WIDTH - MARGIN * 2, size = 12, weight = 400 } = {},
  ) {
    font(size, weight);
    const lines = wrap(ctx, `${label}${value}`, width);
    for (const value of lines) {
      ensure(22);
      text(value, WIDTH - MARGIN, y, { size, weight });
      y += 22;
    }
  }
  const columns = [
    { right: 746, left: 712, label: "ردیف", key: "position" },
    { right: 712, left: 440, label: "کالا", key: "product_name" },
    { right: 440, left: 385, label: "تعداد", key: "quantity" },
    { right: 385, left: 330, label: "واحد", key: "unit" },
    { right: 330, left: 190, label: "مبلغ واحد", key: "unit_price" },
    { right: 190, left: 48, label: "جمع ردیف", key: "total" },
  ];
  function tableHeader() {
    ctx.fillStyle = "#eef2ff";
    ctx.fillRect(MARGIN, y, WIDTH - 2 * MARGIN, 36);
    columns.forEach((column) =>
      text(column.label, column.right - 8, y + 10, { size: 11, weight: 700 }),
    );
    y += 36;
  }
  newPage();
  if (invoice.store) {
    for (const field of ["address", "phone", "registration_number"])
      if (invoice.store[field]) paragraph(invoice.store[field]);
    y += 12;
  }
  paragraph(invoice.customer.name, { label: "مشتری: ", weight: 700, size: 15 });
  paragraph(formatNumber(invoice.customer.code), { label: "کد مشتری: " });
  if (invoice.customer.phone_numbers?.length)
    paragraph(invoice.customer.phone_numbers.join("، "), { label: "تلفن: " });
  if (invoice.customer.address)
    paragraph(invoice.customer.address, { label: "آدرس: " });
  y += 18;
  ensure(70);
  paragraph("اقلام فاکتور - مبالغ به تومان", { weight: 700 });
  tableHeader();
  for (const item of invoice.items) {
    font(11);
    const cells = columns.map((column) => {
      let value = item[column.key];
      if (["unit_price", "total", "quantity", "position"].includes(column.key))
        value = formatNumber(value);
      return wrap(ctx, value, column.right - column.left - 16);
    });
    if (item.product_code) cells[1].push(item.product_code);
    const height = Math.max(...cells.map((lines) => lines.length)) * 20 + 20;
    ensure(height, true);
    cells.forEach((lines, index) =>
      lines.forEach((value, offset) =>
        text(value, columns[index].right - 8, y + 10 + offset * 20, {
          size: 11,
        }),
      ),
    );
    y += height;
    line(y);
  }
  y += 20;
  for (const [label, value, bold] of [
    ["جمع اقلام", invoice.subtotal, false],
    ["تخفیف", invoice.discount, false],
    ["جمع کل نهایی", invoice.total, true],
    ["مبلغ پرداخت‌شده", invoice.paid, false],
    ["مانده فاکتور", invoice.remaining, true],
  ]) {
    ensure(38);
    if (bold) {
      ctx.fillStyle = "#f1f5f9";
      ctx.fillRect(MARGIN, y, WIDTH - 2 * MARGIN, 34);
    }
    text(label, WIDTH - MARGIN - 10, y + 7, { weight: bold ? 700 : 400 });
    text(money(value), MARGIN + 10, y + 7, {
      align: "left",
      weight: bold ? 700 : 400,
      color: bold ? "#1e40af" : "#0f172a",
    });
    y += 38;
  }
  y += 12;
  paragraph(`تاریخ پرداخت: ${invoice.jalali_payment_date}`, { weight: 700 });
  if (!invoice.payments.length) paragraph("پرداختی ثبت نشده است.");
  for (const payment of invoice.payments)
    paragraph(
      `${methodNames[payment.method]}: ${money(payment.amount)}${payment.account_name ? ` - ${payment.account_name}` : ""}`,
    );
  if (invoice.description) {
    y += 14;
    paragraph("توضیحات فاکتور", { weight: 700 });
    paragraph(invoice.description);
  }
  pages.forEach((page, index) => {
    ctx = page.getContext("2d");
    line(1074);
    text(
      `صفحه ${formatNumber(index + 1)} از ${formatNumber(pages.length)}`,
      WIDTH - MARGIN,
      1088,
      { size: 10, color: "#64748b" },
    );
    text(invoice.invoice_code, MARGIN, 1088, {
      size: 10,
      color: "#64748b",
      align: "left",
      direction: "ltr",
    });
  });
  return pages;
}

function canvasBlob(canvas, type = "image/png") {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("تولید خروجی تصویر انجام نشد.")),
      type,
      0.97,
    ),
  );
}

export async function invoicePdf(pages) {
  const parts = [],
    offsets = [0];
  let length = 0;
  const append = (value) => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (id, body) => {
    offsets[id] = length;
    append(`${id} 0 obj\n`);
    append(body);
    append("\nendobj\n");
  };
  append("%PDF-1.4\n");
  append(new Uint8Array([37, 226, 227, 207, 211, 10]));
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(
    2,
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] >>`,
  );
  for (let i = 0; i < pages.length; i++) {
    const id = 3 + i * 3,
      canvas = pages[i];
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`,
    );
    const image = new Uint8Array(
      await (await canvasBlob(canvas, "image/jpeg")).arrayBuffer(),
    );
    offsets[id + 1] = length;
    append(
      `${id + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`,
    );
    append(image);
    append("\nendstream\nendobj\n");
    const stream = "q 595.28 0 0 841.89 0 0 cm /Im0 Do Q\n";
    object(
      id + 2,
      `<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}endstream`,
    );
  }
  const xref = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  offsets
    .slice(1)
    .forEach((offset) =>
      append(`${String(offset).padStart(10, "0")} 00000 n \n`),
    );
  append(
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
  return new Blob(parts, { type: "application/pdf" });
}

// Uncompressed ZIP containers keep multi-page PNG exports to one download.
function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
export async function invoiceImages(pages, name) {
  if (pages.length === 1)
    return { blob: await canvasBlob(pages[0]), extension: "png" };
  const parts = [],
    directory = [];
  let offset = 0,
    directorySize = 0;
  for (let index = 0; index < pages.length; index++) {
    const data = new Uint8Array(
      await (await canvasBlob(pages[index])).arrayBuffer(),
    );
    const filename = encoder.encode(`${name}-${index + 1}.png`),
      crc = crc32(data);
    const local = new Uint8Array(30),
      header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(12, 33, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, data.length, true);
    header.setUint16(26, filename.length, true);
    parts.push(local, filename, data);
    const central = new Uint8Array(46),
      entry = new DataView(central.buffer);
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(14, 33, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, filename.length, true);
    entry.setUint32(42, offset, true);
    directory.push(central, filename);
    directorySize += 46 + filename.length;
    offset += 30 + filename.length + data.length;
  }
  const end = new Uint8Array(22),
    entry = new DataView(end.buffer);
  entry.setUint32(0, 0x06054b50, true);
  entry.setUint16(8, pages.length, true);
  entry.setUint16(10, pages.length, true);
  entry.setUint32(12, directorySize, true);
  entry.setUint32(16, offset, true);
  return {
    blob: new Blob([...parts, ...directory, end], { type: "application/zip" }),
    extension: "zip",
  };
}

function download(blob, name) {
  const url = URL.createObjectURL(blob),
    link = node("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
let root,
  dialog,
  pages = [],
  invoice,
  urls = [],
  version = 0,
  exporting = false;

function setup() {
  if (root) return;
  root = node("div", "orders-modal hidden");
  root.id = "finalInvoiceModal";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `<button type="button" class="orders-backdrop" data-dialog-close aria-label="بستن فاکتور"></button><section role="dialog" aria-modal="true" aria-labelledby="finalInvoiceTitle" class="orders-glass scale-95 opacity-0"><header class="orders-dialog-header"><h2 id="finalInvoiceTitle">فاکتور نهایی</h2><button type="button" class="orders-icon-button" data-dialog-close aria-label="بستن">×</button></header><div class="orders-dialog-body"><p id="finalInvoiceStatus" role="status"></p><p id="finalInvoiceAccessible" class="sr-only"></p><div id="finalInvoicePages"></div></div><footer class="orders-dialog-footer"><button type="button" id="retryFinalInvoice" class="orders-secondary" hidden>تلاش مجدد</button><button type="button" id="printFinalInvoice" class="orders-secondary" disabled>چاپ فاکتور</button><button type="button" id="imageFinalInvoice" class="orders-secondary" disabled>خروجی تصویر PNG</button><button type="button" id="pdfFinalInvoice" class="orders-primary" disabled>خروجی PDF</button></footer></section>`;
  document.body.append(root);
  dialog = new Dialog(root.id, {
    canClose: () => !exporting,
    onCancel: () => {
      version++;
    },
  });
  const print = node("div");
  print.id = "invoicePrintPages";
  document.body.append(print);
  root.querySelector("#printFinalInvoice").addEventListener("click", () => {
    if (pages.length) window.print();
  });
  for (const [id, callback] of [
    [
      "pdfFinalInvoice",
      async () => {
        download(
          await invoicePdf(pages),
          `invoice-${invoice.invoice_code}.pdf`,
        );
      },
    ],
    [
      "imageFinalInvoice",
      async () => {
        const image = await invoiceImages(
          pages,
          `invoice-${invoice.invoice_code}`,
        );
        download(
          image.blob,
          `invoice-${invoice.invoice_code}.${image.extension}`,
        );
      },
    ],
  ])
    root.querySelector(`#${id}`).addEventListener("click", async () => {
      if (exporting || !pages.length) return;
      exporting = true;
      setButtons(true);
      root.querySelector("#finalInvoiceStatus").textContent =
        "در حال تولید خروجی…";
      try {
        await callback();
        root.querySelector("#finalInvoiceStatus").textContent =
          "خروجی آماده شد.";
      } catch (error) {
        root.querySelector("#finalInvoiceStatus").textContent = error.message;
      } finally {
        exporting = false;
        setButtons(false);
      }
    });
}
function setButtons(disabled) {
  for (const id of [
    "printFinalInvoice",
    "imageFinalInvoice",
    "pdfFinalInvoice",
  ])
    root.querySelector(`#${id}`).disabled = disabled;
  root.querySelectorAll("[data-dialog-close]").forEach((button) => {
    button.disabled = exporting;
  });
}
export async function showFinalInvoice(orderId) {
  setup();
  const current = ++version;
  pages = [];
  setButtons(true);
  urls.forEach(URL.revokeObjectURL);
  urls = [];
  root.querySelector("#finalInvoicePages").replaceChildren();
  document.getElementById("invoicePrintPages").replaceChildren();
  root.querySelector("#finalInvoiceStatus").textContent =
    "در حال دریافت فاکتور ذخیره‌شده…";
  root.querySelector("#retryFinalInvoice").hidden = true;
  root.inert = false;
  dialog.open();
  const newUrls = [];
  try {
    const saved = await financeRequest(`/orders/${orderId}/invoice`);
    const rendered = await renderInvoice(saved);
    if (current !== version) return;
    const previews = [],
      printedPages = [];
    for (const [index, canvas] of rendered.entries()) {
      const url = URL.createObjectURL(await canvasBlob(canvas));
      newUrls.push(url);
      const image = node("img", "invoice-preview-page");
      image.src = url;
      image.alt = `فاکتور ${saved.invoice_code}، صفحه ${index + 1}`;
      image.width = WIDTH;
      image.height = HEIGHT;
      previews.push(image);
      const printed = image.cloneNode();
      printed.className = "invoice-print-page";
      printedPages.push(printed);
    }
    await Promise.all(
      [...previews, ...printedPages].map((image) => image.decode()),
    );
    if (current !== version) {
      newUrls.forEach(URL.revokeObjectURL);
      return;
    }
    invoice = saved;
    pages = rendered;
    urls = newUrls;
    root.querySelector("#finalInvoicePages").replaceChildren(...previews);
    document
      .getElementById("invoicePrintPages")
      .replaceChildren(...printedPages);
    root.querySelector("#finalInvoiceAccessible").textContent = [
      invoice.invoice_code,
      invoice.order_number,
      invoice.jalali_date,
      invoice.customer.name,
      ...invoice.items.map(
        (item) =>
          `${item.product_name} ${item.quantity} ${item.unit} ${money(item.unit_price)}`,
      ),
      `تخفیف ${money(invoice.discount)}، مبلغ نهایی ${money(invoice.total)}، پرداختی ${money(invoice.paid)}، مانده ${money(invoice.remaining)}`,
      ...invoice.payments.map(
        (payment) => `${methodNames[payment.method]} ${money(payment.amount)}`,
      ),
    ].join(". ");
    root.querySelector("#imageFinalInvoice").textContent =
      pages.length > 1 ? "تصاویر PNG (ZIP)" : "خروجی تصویر PNG";
    root.querySelector("#finalInvoiceStatus").textContent =
      pages.length > 1
        ? `${formatNumber(pages.length)} صفحه؛ خروجی تصویر شامل تمام صفحات در فایل ZIP است.`
        : "فاکتور نهایی ذخیره‌شده آماده است.";
    setButtons(false);
  } catch (error) {
    newUrls.forEach(URL.revokeObjectURL);
    if (current !== version) return;
    root.querySelector("#finalInvoiceStatus").textContent = error.message;
    const retry = root.querySelector("#retryFinalInvoice");
    retry.hidden = false;
    retry.onclick = () => showFinalInvoice(orderId);
  }
}
