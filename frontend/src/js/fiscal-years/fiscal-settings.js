import { node, money, fullDate } from "../finance/finance-utils.js";
import { formatNumber } from "../customers/customer-utils.js";
import { downloadBlob } from "../reports/report-api.js";
import { onPageRefresh } from "../components/data-events.js";
import { showOrderDetails } from "../orders/order-details.js";
import { archiveLink, fiscalLabel as yearLabel, fiscalRequest } from "./fiscal-api.js";

const panels = new WeakMap();
const statuses = { active: "فعال", open: "باز", closed: "بسته‌شده", parked: "در انتظار فعال‌سازی" };
const exportStatus = { pending: "در حال تولید گزارش‌ها", ready: "گزارش‌ها آماده‌اند", failed: "تولید گزارش‌ها ناموفق بود" };
const downloads = [
  ["summary", "گزارش جامع PDF", "pdf"],
  ["carryover", "مانده‌های انتقالی PDF", "pdf"],
  ["data", "داده‌های سال ZIP", "zip"],
];
const methods = { cash: "نقدی", pos: "کارت‌خوان", transfer: "کارت‌به‌کارت", unknown: "ثبت نشده" };
const pageSize = 25;

const nameOf = (c) => `${c.first_name} ${c.last_name}`;
const range = (p) => `${yearLabel(p.start_jalali)} تا ${yearLabel(p.end_jalali)}`;

function action(text, onClick, primary = false) {
  const button = node("button", primary ? "settings-primary-button" : "settings-secondary-button", text);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function link(text, href) {
  const anchor = node("a", "settings-secondary-button", text);
  anchor.href = href;
  return anchor;
}

function message(element, text, state = "") {
  element.textContent = text;
  element.hidden = !text;
  element.dataset.state = state;
}

function table(headings, rows) {
  if (!rows.length) return node("p", "settings-field-hint", "رکوردی برای نمایش وجود ندارد.");
  const wrapper = node("div", "fiscal-table-scroll");
  const element = node("table", "fiscal-table");
  const header = element.createTHead().insertRow();
  for (const label of headings) {
    const cell = node("th", "", label);
    cell.scope = "col";
    header.append(cell);
  }
  const body = element.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) {
      const td = tr.insertCell();
      if (value instanceof Node) td.append(value);
      else td.textContent = value ?? "—";
    }
  }
  wrapper.append(element);
  return wrapper;
}

function metrics(rows) {
  const dl = node("dl", "fiscal-metrics");
  for (const [label, value] of rows) {
    const item = node("div");
    item.append(node("dt", "", label), node("dd", "", value));
    dl.append(item);
  }
  return dl;
}

function carryoverMetrics(s) {
  return [
    ["مشتریان دارای مانده", formatNumber(s.carryover_customers)],
    ["فاکتورهای باز", formatNumber(s.open_invoices)],
    ["مطالبات انتقالی", money(s.receivables)],
    ["بستانکاری انتقالی", money(s.credits)],
  ];
}

function accountTable(accounts) {
  return table(["حساب", "افتتاحیه", "دریافت", "پرداخت", "مانده پایان سال"], accounts.map((row) => [
    row.is_cash ? row.name : `${row.bank_name || row.name} · ${row.account_number}`,
    money(row.opening_balance), money(row.income), money(row.expense), money(row.closing_balance),
  ]));
}

function inventoryTable(inventory) {
  if (!inventory.available)
    return node("p", "settings-field-hint", `موجودی در دسترس نیست. ${inventory.reason}`);
  return table(["کد کالا", "نام کالا", "واحد", "تعداد"], inventory.rows.map((row) => [
    row.product_code, row.name, row.unit, formatNumber(row.quantity),
  ]));
}

function fold(title, body) {
  const details = node("details", "fiscal-fold");
  details.append(node("summary", "", title), body);
  return details;
}

function setup(panel) {
  const $ = (id) => panel.querySelector(`#${id}`);
  const params = new URLSearchParams(location.search);
  const archiveYear = Number(params.get("fiscal_year")) || null;
  let archiveVersion = Number(params.get("version")) || undefined;
  const status = $("fiscalStatus");
  const kind = $("fiscalRecordKind");
  const search = $("fiscalSearch");
  let activeYear, reviewed, listing, poll, reopening = false;
  let resultsVersion = 0, detailVersion = 0, skip = 0, archiveLoaded = false;

  const archivePath = (suffix = "") =>
    `/${archiveYear}${suffix}${archiveVersion ? `?version=${archiveVersion}` : ""}`;
  const archivedOrder = (id, type = "orders") =>
    showOrderDetails(id, { year: archiveYear, kind: type, version: archiveVersion });

  async function getList() {
    clearTimeout(poll);
    try {
      const data = await fiscalRequest();
      if (reviewed && reviewed.period.year !== data.active_year) hidePreview();
      activeYear = data.active_year;
      const active = data.years.find((row) => row.year === activeYear);
      $("fiscalActiveTitle").textContent = `سال مالی فعال ${yearLabel(activeYear)}`;
      $("fiscalActiveRange").textContent = range(active);
      $("fiscalActive").hidden = false;
      $("fiscalPreviewButton").hidden = !data.can_manage;
      $("fiscalYearsList").replaceChildren(...data.years.slice().reverse().map((row) =>
        yearRow(row, data.can_manage, data.reopen?.year === row.year ? data.reopen : null)));
      if (data.years.some((row) => row.archives.some((archive) => archive.export_status === "pending"))) {
        poll = setTimeout(() => {
          if (panel.getClientRects().length && !document.hidden) void loadList();
        }, 2200);
      }
    } catch (error) {
      message(status, error.message, "error");
    }
  }

  function loadList() {
    listing ||= getList().finally(() => { listing = undefined; });
    return listing;
  }

  function yearRow(row, canManage, reopen) {
    const item = node("li");
    const text = node("div");
    text.append(node("strong", "", `سال ${yearLabel(row.year)} · ${statuses[row.status]}`),
                node("p", "", range(row)));
    const controls = node("div", "fiscal-actions");
    const [latest, ...older] = row.archives;
    if (latest) {
      text.append(node("p", "", `تاریخ بستن ${fullDate(latest.closed_date)} · نسخهٔ ${yearLabel(latest.version)}`));
      text.append(node("p", "fiscal-export-status", exportStatus[latest.export_status]));
      controls.append(...archiveActions(row.year, latest, row.status === "closed" ? "مشاهدهٔ سال" : "مشاهدهٔ آخرین بایگانی", canManage));
    }
    if (canManage && reopen) {
      const button = action("بازگشایی سال مالی", (event) => reopenYear(reopen, event.currentTarget));
      button.disabled = reopen.blocked || reopening;
      controls.append(button);
      if (reopen.blocked) text.append(node("p", "fiscal-export-status", "سال بعد شروع شده و بازگشایی ممکن نیست."));
    }
    if (older.length) {
      const history = node("div", "fiscal-stack");
      for (const archive of older) {
        const entry = node("div");
        entry.append(node("p", "", `نسخهٔ ${yearLabel(archive.version)} · ${fullDate(archive.closed_date)} · ${exportStatus[archive.export_status]}`));
        const actions = node("div", "fiscal-actions");
        actions.append(...archiveActions(row.year, archive, "مشاهدهٔ نسخه", canManage));
        entry.append(actions);
        history.append(entry);
      }
      text.append(fold("نسخه‌های پیشین بستن سال", history));
    }
    item.append(text, controls);
    return item;
  }

  function archiveActions(year, archive, label, canManage) {
    const { version, export_status } = archive;
    const controls = [link(label, archiveLink(year, null, null, version))];
    if (!canManage) return controls;
    if (export_status === "ready") {
      for (const [output, title, extension] of downloads) {
        controls.push(action(title, async ({ currentTarget: button }) => {
          button.disabled = true;
          try {
            const blob = await fiscalRequest(`/${year}/exports/${output}?version=${version}`, { responseType: "blob", timeoutMs: 120000 });
            const filename = version > 1 ? `${year}-v${version}` : year;
            downloadBlob(blob, `karbon-${filename}-${output}.${extension}`);
          } catch (error) {
            message(status, error.message, "error");
          } finally {
            button.disabled = false;
          }
        }));
      }
    } else {
      controls.push(action("تولید دوباره گزارش‌ها", async ({ currentTarget: button }) => {
        button.disabled = true;
        try {
          await fiscalRequest(`/${year}/exports?version=${version}`, { method: "POST" });
          message(status, "");
          await listing;
          await loadList();
        } catch (error) {
          message(status, error.message, "error");
          button.disabled = false;
        }
      }));
    }
    return controls;
  }

  async function reopenYear({ year, version }, button) {
    if (reopening || $("fiscalConfirmFields").disabled) return;
    if (!window.confirm(`سال مالی ${yearLabel(year)} دوباره فعال می‌شود. برای فعال‌سازی سال بعد باید این سال را دوباره ببندید. بازگشایی تأیید شود؟`)) return;
    reopening = button.disabled = true;
    let reopened = false;
    message(status, "در حال بازگشایی سال مالی…");
    try {
      await fiscalRequest(`/${year}/reopen`, { method: "POST", body: { confirm: true, version } });
      hidePreview();
      message(status, `سال مالی ${yearLabel(year)} دوباره فعال شد.`, "success");
      reopened = true;
    } catch (error) {
      message(status, error.message, "error");
    } finally {
      reopening = false;
      button.disabled = false;
      await listing;
      await loadList();
      if (reopened) $("fiscalActiveTitle").focus();
    }
  }

  function hidePreview() {
    reviewed = undefined;
    $("fiscalPreview").hidden = true;
    $("fiscalConfirmForm").reset();
    message($("fiscalConfirmStatus"), "");
  }

  function renderPreview(data) {
    reviewed = data;
    const p = data.period;
    const customers = data.customers;
    const invoices = customers.flatMap((customer) => customer.invoices.map((invoice) => [
      nameOf(customer), invoice.order_number, invoice.invoice_code, yearLabel(invoice.source_year),
      money(invoice.paid), money(invoice.amount),
    ]));
    const host = $("fiscalPreviewData");
    host.replaceChildren(
      node("p", "", `سال ${yearLabel(p.year)} · قطع حساب ${yearLabel(p.end_jalali)} · سال بعد ${yearLabel(p.next_year)}`),
      metrics(carryoverMetrics(data.summary)),
      fold("مانده حساب‌های بانکی و صندوق", accountTable(data.accounts)),
      fold("موجودی پایان سال", inventoryTable(data.inventory)),
      fold("مانده هر مشتری", table(["نام مشتری", "کد مشتری", "مطالبات", "بستانکاری"], customers.map((row) => [
        nameOf(row), formatNumber(row.customer_code), money(row.receivable), money(row.credit),
      ]))),
      fold("فاکتورهای باز", table(["مشتری", "شماره سفارش", "شماره فاکتور", "سال مبدأ", "پرداخت تا قطع حساب", "مبلغ انتقالی"], invoices)),
    );
    host.querySelectorAll("details").forEach((details) => { details.open = true; });
    const next = data.next_activity;
    if (next.orders || next.transactions || next.purchases || next.production) {
      host.prepend(node("p", "settings-field-hint",
        `در سال بعد ${formatNumber(next.orders)} سفارش، ${formatNumber(next.transactions)} تراکنش، ${formatNumber(next.purchases)} خرید و ${formatNumber(next.production ?? 0)} تولید قبلاً ثبت شده است.`));
    }
    $("fiscalPreview").hidden = false;
    $("fiscalConfirmForm").reset();
  }

  $("fiscalPreviewButton").addEventListener("click", async ({ currentTarget: button }) => {
    if (reopening) return;
    const year = activeYear;
    button.disabled = true;
    message(status, "در حال دریافت پیش‌نمایش…");
    try {
      const data = await fiscalRequest(`/${year}/preview`, { timeoutMs: 60000 });
      if (reopening || year !== activeYear) return;
      renderPreview(data);
      message(status, "");
      $("fiscalPreviewTitle").focus();
    } catch (error) {
      message(status, error.message, "error");
    } finally {
      button.disabled = false;
    }
  });
  $("fiscalCancelPreview").addEventListener("click", () => {
    hidePreview();
    $("fiscalPreviewButton").focus();
  });
  $("fiscalConfirmForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (reopening || !reviewed || !$("fiscalConfirmation").checked) return;
    const { period, digest } = reviewed;
    const passphrase = $("fiscalPassphrase").value;
    $("fiscalPassphrase").value = "";
    $("fiscalConfirmFields").disabled = $("fiscalPreviewButton").disabled = true;
    const confirmStatus = $("fiscalConfirmStatus");
    message(confirmStatus, "در حال تهیه و بررسی پشتیبان ایمنی و بستن سال…");
    try {
      const result = await fiscalRequest(`/${period.year}/close`, {
        method: "POST", body: { digest, passphrase, confirm: true }, timeoutMs: 180000,
      });
      hidePreview();
      message(status, `سال ${yearLabel(result.year)} بسته شد. سال فعال ${yearLabel(result.active_year)} است.`, "success");
      await listing;
      await loadList();
    } catch (error) {
      $("fiscalConfirmation").checked = false;
      if (error.status === 409) {
        try {
          const fresh = await fiscalRequest(`/${period.year}/preview`, { timeoutMs: 60000 });
          if (fresh.digest !== digest) renderPreview(fresh);
        } catch { await loadList(); }
      }
      message($("fiscalPreview").hidden ? status : confirmStatus, error.message, "error");
    } finally {
      $("fiscalConfirmFields").disabled = $("fiscalPreviewButton").disabled = false;
    }
  });

  function showDetail(content) {
    const host = $("fiscalRecordDetails");
    host.replaceChildren(...content);
    host.hidden = false;
    host.focus();
  }

  async function openRecord(type, id) {
    const version = ++detailVersion;
    if (type === "orders" || type === "invoices") {
      await archivedOrder(id, type);
      return;
    }
    if (type === "purchases") {
      const { showFinalInvoice } = await import("../orders/invoice-export.js");
      if (version === detailVersion) await showFinalInvoice(id, { year: archiveYear, version: archiveVersion, kind: "purchase" });
      return;
    }
    try {
      const record = await fiscalRequest(archivePath(`/records/${type}/${id}`));
      if (version !== detailVersion) return;
      if (type === "customers") {
        const c = record.customer;
        showDetail([
          node("h3", "", `صورتحساب ${nameOf(c)}`),
          node("p", "", `کد مشتری ${formatNumber(c.customer_code)} · ${c.phone_numbers.join("، ")}`),
          metrics([
            ["مطالبات افتتاحیه", money(record.opening.receivable)], ["بستانکاری افتتاحیه", money(record.opening.credit)],
            ["مطالبات پایان سال", money(record.closing.receivable)], ["بستانکاری پایان سال", money(record.closing.credit)],
          ]),
          table(["سفارش", "فاکتور", "تاریخ صدور", "سررسید", "مبلغ", "پرداخت تا قطع حساب", "مانده انتقالی"], record.invoices.map((o) => [
            action(o.order_number, () => archivedOrder(o.id)),
            action(o.invoice_code, () => archivedOrder(o.id, "invoices")),
            yearLabel(o.jalali_date), yearLabel(o.jalali_payment_date), money(o.total), money(o.paid), money(o.carried),
          ])),
          table(["تراکنش", "تاریخ", "روش", "مبلغ", "شماره پیگیری"], record.transactions.map((tx) => [
            action(formatNumber(tx.transaction_number || tx.id), () => openRecord("transactions", tx.id)),
            yearLabel(tx.jalali_date), methods[tx.method], money(tx.amount), tx.tracking_number,
          ])),
        ]);
      } else {
        const tx = record;
        const detail = metrics([
          ["تاریخ", yearLabel(tx.jalali_date)], ["نوع", tx.kind === "income" ? "دریافت" : "پرداخت"],
          ["مبلغ", money(tx.amount)], ["حساب", tx.bank_name], ["روش", methods[tx.method]],
          ["شماره پیگیری", tx.tracking_number || "—"], ["عنوان", tx.title], ["شرح", tx.description || "—"],
        ]);
        const content = [node("h3", "", `تراکنش ${formatNumber(tx.transaction_number || tx.id)}`), detail];
        if (tx.order_id)
          content.push(action("مشاهدهٔ فاکتور مرتبط", () => archivedOrder(tx.order_id, "invoices")));
        showDetail(content);
      }
    } catch (error) {
      if (version === detailVersion) message(status, error.message, "error");
    }
  }

  function recordTable(type, rows) {
    const open = (id) => action("مشاهده", () => openRecord(type, id));
    if (type === "customers") return table(["مشتری", "کد مشتری", "شماره تماس", "صورتحساب"], rows.map((c) => [
      nameOf(c), formatNumber(c.customer_code), c.phone_numbers.join("، "), open(c.id),
    ]));
    if (type === "transactions") return table(["شماره", "تاریخ", "عنوان", "شماره پیگیری", "مبلغ", "جزئیات"], rows.map((tx) => [
      formatNumber(tx.transaction_number || tx.id), yearLabel(tx.jalali_date), tx.title, tx.tracking_number, money(tx.amount), open(tx.id),
    ]));
    if (type === "purchases") return table(["شماره فاکتور", "تأمین‌کننده", "تاریخ خرید", "مبلغ فاکتور", "جزئیات"], rows.map((row) => [
      row.invoice_number, row.customer_name, yearLabel(row.jalali_date), money(row.total), open(row.id),
    ]));
    return table(["شماره سفارش", "شماره فاکتور", "مشتری", "تاریخ صدور", "مبلغ فاکتور", "جزئیات"], rows.map((row) => [
      row.order_number, row.invoice_code, row.customer_name, yearLabel(row.jalali_date || fullDate(row.issue_date)), money(row.total),
      open(row.id || row.order_id),
    ]));
  }

  async function loadRecords() {
    const version = ++resultsVersion;
    const type = kind.value;
    const indicator = $("fiscalRecordStatus");
    message(indicator, "در حال دریافت سوابق…");
    try {
      const query = new URLSearchParams({ q: search.value, skip, limit: pageSize });
      if (archiveVersion) query.set("version", archiveVersion);
      const data = await fiscalRequest(`/${archiveYear}/records/${type}?${query}`);
      if (version !== resultsVersion) return;
      $("fiscalRecords").replaceChildren(recordTable(type, data.items));
      $("fiscalPrevious").hidden = skip === 0;
      $("fiscalNext").hidden = skip + pageSize >= data.total;
      message(indicator, `${formatNumber(data.total)} سابقه`);
    } catch (error) {
      if (version === resultsVersion) message(indicator, error.message, "error");
    }
  }

  function resetRecords() {
    detailVersion++;
    $("fiscalRecordDetails").hidden = true;
    skip = 0;
    void loadRecords();
  }
  kind.addEventListener("change", resetRecords);
  $("fiscalSearchForm").addEventListener("submit", (event) => { event.preventDefault(); resetRecords(); });
  $("fiscalPrevious").addEventListener("click", () => { skip -= pageSize; void loadRecords(); });
  $("fiscalNext").addEventListener("click", () => { skip += pageSize; void loadRecords(); });

  async function loadArchive() {
    if (archiveLoaded) return;
    $("fiscalCurrent").hidden = true;
    $("fiscalArchive").hidden = false;
    message(status, "در حال دریافت بایگانی…");
    try {
      const data = await fiscalRequest(archivePath());
      archiveVersion = data.version;
      $("fiscalArchiveTitle").textContent = `بایگانی سال مالی ${yearLabel(archiveYear)} · فقط خواندنی`;
      $("fiscalArchiveRange").textContent = `${range(data.period)} · نسخهٔ ${yearLabel(archiveVersion)}`;
      $("fiscalArchiveSummary").replaceChildren(metrics([
        ["فروش خالص", money(data.summary.net_sales)], ["دریافت‌ها", money(data.summary.income)],
        ["پرداخت‌ها", money(data.summary.expense)], ["کل مشتریان پایان سال", formatNumber(data.summary.customers)],
        ...carryoverMetrics(data.summary),
      ]), fold("مانده حساب‌های بانکی و صندوق", accountTable(data.accounts)),
      fold("موجودی پایان سال", inventoryTable(data.inventory)));
      const type = params.get("kind");
      if (Array.from(kind.options).some((option) => option.value === type)) kind.value = type;
      const record = Number(params.get("record"));
      message(status, "");
      await loadRecords();
      if (record > 0 && Number.isSafeInteger(record)) await openRecord(kind.value, record);
      archiveLoaded = true;
    } catch (error) {
      message(status, error.message, "error");
    }
  }

  if (!archiveYear) onPageRefresh(loadList, { maxAge: 0, isVisible: () => panel.getClientRects().length > 0 });
  return archiveYear ? loadArchive : loadList;
}

export function initializeFiscalYears(panel) {
  if (!panels.has(panel)) panels.set(panel, setup(panel));
  return panels.get(panel)();
}
