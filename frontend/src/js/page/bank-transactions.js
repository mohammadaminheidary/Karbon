import { mountDateInput } from "../components/date-input.js";
import { startPage } from "../components/page-ready.js";
import { transactionActions } from "../finance/transaction-actions.js";
import { onPageRefresh } from "../components/data-events.js";
import { protectPage } from "../guards/auth-guard.js";
import { Chart, dateLabel } from "../dashboard/chart.js";
import { financeRequest } from "../finance/finance-api.js";
import { bankLogo, formatCardNumber } from "../finance/bank-accounts.js";
import {
  node,
  money,
  fullDate,
  normalizeDigits,
  normalizeJalaliDate,
  amountValue,
  bindAmount,
} from "../finance/finance-utils.js";

const $ = (id) => document.getElementById(id);
const dateFilters = new Map([
  ["ledgerStart", 3],
  ["ledgerEnd", 3],
  ["ledgerDay", 3],
  ["ledgerMonth", 2],
  ["ledgerYear", 1],
].map(([id, count]) => [id, mountDateInput($(id), { count })]));
const bankId = new URLSearchParams(window.location.search).get("bank");
const validBank = /^[1-9]\d*$/.test(bankId || "");
const number = (value) => new Intl.NumberFormat("fa-IR").format(value);
let activityChart, displayedPeriod;
let period = "month",
  chartVersion = 0,
  listVersion = 0,
  chartController,
  listController;
let cursor = null,
  ledgerItems = [],
  renderedFilters,
  renderedChart,
  listLoaded = false,
  chartLoaded = false,
  loaded = 0,
  activeFilters = {},
  searchTimer,
  loading = false;

async function loadChart() {
  const requestedPeriod = period;
  const version = ++chartVersion;
  chartController?.abort();
  chartController = new AbortController();
  $("bankChart").setAttribute("aria-busy", "true");
  if (!chartLoaded) $("chartStatus").textContent = "در حال دریافت نمودار...";
  $("chartError").classList.add("hidden");
  $("retryChart").classList.add("hidden");
  try {
    if (!validBank)
      throw new Error(
        "شناسه حساب معتبر نیست. از صفحه بانک‌ها یک حساب را انتخاب کنید.",
      );
    const data = await financeRequest(
      `/banks/${bankId}/activity?period=${requestedPeriod}`,
      { signal: chartController.signal },
    );
    if (version !== chartVersion) return;
    chartLoaded = true;
    $("chartStatus").textContent =
      data.summary.income || data.summary.expense
        ? ""
        : "در این بازه تراکنشی ثبت نشده است.";
    const signature = JSON.stringify(data);
    if (signature === renderedChart) return;
    const info = node("div");
    info.append(
      node(
        "p",
        "font-bold",
        `${data.bank.name} · ${[data.bank.first_name, data.bank.last_name].filter(Boolean).join(" ")}`,
      ),
    );
    const card = node(
      "p",
      "mt-1 text-xs text-mirage/45",
      data.bank.is_cash
        ? "دریافت و پرداخت نقدی"
        : data.bank.card_number
          ? formatCardNumber(data.bank.card_number)
          : data.bank.account_number,
    );
    card.dir = "ltr";
    info.append(card);
    $("bankHeader").replaceChildren(bankLogo(data.bank), info);
    $("chartRange").textContent =
      `${fullDate(data.start_date)} تا ${fullDate(data.end_date)} · تومان`;
    $("chartSummary").replaceChildren(
      node(
        "p",
        "font-bold text-eucalyptus",
        `درآمد: ${money(data.summary.income)}`,
      ),
      node(
        "p",
        "font-bold text-alizarin-crimson",
        `هزینه: ${money(data.summary.expense)}`,
      ),
      node(
        "p",
        "font-bold text-[#94620b]",
        `مانده بازه: ${money(data.summary.balance)}`,
      ),
    );
    if (data.bank.opening_balance_locked)
      $("chartSummary").append(node("p", "font-bold", `افتتاحیه: ${money(data.bank.opening_balance)}`));
    activityChart ??= new Chart($("bankChart"), {
      series: [
        { key: "income", label: "درآمد", color: "#157347", point: "circle" },
        { key: "expense", label: "هزینه", color: "#bc2849", point: "square" },
        { key: "balance", label: "مانده", color: "#94620b", point: "diamond" },
      ],
      bars: true,
      barPoints: true,
      money: true,
      height: 250,
    });
    activityChart.update(
      data.chart.map((point) => ({
        ...point,
        label: fullDate(point.date),
        shortLabel: dateLabel(point.date),
      })),
      displayedPeriod !== requestedPeriod,
    );
    displayedPeriod = requestedPeriod;
    renderedChart = signature;
  } catch (error) {
    if (version !== chartVersion) return;
    $("chartStatus").textContent = "";
    $("chartError").textContent = error.message;
    $("chartError").classList.remove("hidden");
    $("retryChart").classList.remove("hidden");
  } finally {
    if (version === chartVersion) $("bankChart").setAttribute("aria-busy", "false");
  }
}

function renderRow(item) {
  const row = node("tr", "border-t border-french-gray/20");
  row.dataset.transactionId = item.id;
  const income = item.kind === "income";
  const color = income ? "text-eucalyptus" : "text-alizarin-crimson";
  const info = node("td", "max-w-sm p-4");
  info.append(
    node("p", "font-bold", item.title),
    node(
      "p",
      "mt-1 whitespace-pre-wrap break-words text-xs text-mirage/50",
      item.description || "—",
    ),
  );
  const date = node(
    "td",
    "whitespace-nowrap p-4",
    fullDate(item.transaction_date),
  );
  const time = node(
    "p",
    "mt-1 text-xs text-mirage/45",
    new Intl.NumberFormat("fa-IR", { useGrouping: false })
      .format(Number(item.transaction_time.slice(0, 2)))
      .padStart(2, "۰") +
      ":" +
      number(Number(item.transaction_time.slice(3, 5))).padStart(2, "۰"),
  );
  time.dir = "ltr";
  date.append(time);
  row.append(
    node(
      "td",
      "p-4 text-mirage/55",
      number(item.transaction_number || item.id),
    ),
    node("td", `p-4 font-bold ${color}`, income ? "درآمد" : "هزینه"),
    info,
    date,
    node(
      "td",
      `whitespace-nowrap p-4 font-bold ${color}`,
      `${income ? "+" : "−"} ${money(item.amount)}`,
    ),
    node(
      "td",
      "break-all p-4 text-xs text-mirage/55",
      item.tracking_number || "—",
    ),
  );
  row.append(transactionActions(item, refreshLedger));
  return row;
}

async function loadList(more = false) {
  const version = ++listVersion;
  listController?.abort();
  listController = new AbortController();
  loading = true;
  $("ledgerRows").setAttribute("aria-busy", "true");
  if (!listLoaded) $("ledgerStatus").textContent = "در حال دریافت تراکنش‌ها...";
  $("ledgerError").classList.add("hidden");
  $("retryLedger").classList.add("hidden");
  $("moreLedger").disabled = true;
  const query = new URLSearchParams(activeFilters);
  const filters = query.toString();
  const visibleCount = filters === renderedFilters ? ledgerItems.length : 0;
  if (more && cursor) query.set("cursor", cursor);
  try {
    if (!validBank) throw new Error("شناسه حساب معتبر نیست.");
    const nextItems = more ? [...ledgerItems] : [];
    let result;
    do {
      result = await financeRequest(
        `/banks/${bankId}/transactions?${query}`,
        { signal: listController.signal },
      );
      if (version !== listVersion) return;
      const existing = new Set(nextItems.map((item) => item.id));
      nextItems.push(...result.items.filter((item) => !existing.has(item.id)));
      if (more || !result.items.length || !result.next_cursor) break;
      query.set("cursor", result.next_cursor);
    } while (nextItems.length < visibleCount);
    const unchanged = JSON.stringify(ledgerItems) === JSON.stringify(nextItems);
    if (!unchanged) {
      if (more) $("ledgerRows").append(...nextItems.slice(ledgerItems.length).map(renderRow));
      else $("ledgerRows").replaceChildren(...nextItems.map(renderRow));
    }
    ledgerItems = nextItems;
    renderedFilters = filters;
    listLoaded = true;
    loaded = ledgerItems.length;
    cursor = result.next_cursor;
    $("ledgerTable").classList.toggle("hidden", loaded === 0);
    $("ledgerStatus").textContent = loaded
      ? ""
      : "تراکنشی با این شرایط پیدا نشد.";
    $("ledgerCount").textContent =
      `${number(loaded)} از ${number(result.total)} تراکنش`;
    $("moreLedger").classList.toggle("hidden", !cursor);
  } catch (error) {
    if (version !== listVersion) return;
    $("ledgerStatus").textContent = "";
    $("ledgerError").textContent = error.message;
    $("ledgerError").classList.remove("hidden");
    $("retryLedger").classList.remove("hidden");
    $("retryLedger").dataset.more = String(more);
    $("moreLedger").classList.add("hidden");
  } finally {
    if (version === listVersion) {
      loading = false;
      $("ledgerRows").setAttribute("aria-busy", "false");
      $("moreLedger").disabled = false;
    }
  }
}

function readFilters() {
  const query = {};
  const mode = $("ledgerDateMode").value;
  const value = (id) => normalizeDigits((dateFilters.get(id) ?? $(id)).value.trim());
  if (mode === "range") {
    if (!value("ledgerStart") && !value("ledgerEnd"))
      throw new Error("شروع یا پایان بازه را وارد کنید.");
    if (value("ledgerStart"))
      query.start_date = normalizeJalaliDate(value("ledgerStart"));
    if (value("ledgerEnd"))
      query.end_date = normalizeJalaliDate(value("ledgerEnd"));
    if (query.start_date && query.end_date && query.end_date < query.start_date)
      throw new Error("پایان بازه نباید قبل از شروع باشد.");
  }
  if (mode === "day") query.day = normalizeJalaliDate(value("ledgerDay"));
  if (mode === "month") {
    const match = value("ledgerMonth").match(/^(\d{4})\/(\d{1,2})$/);
    if (!match) throw new Error("ماه شمسی را به صورت ۱۴۰۵/۰۷ وارد کنید.");
    normalizeJalaliDate(`${match[1]}/${match[2]}/01`);
    query.month = value("ledgerMonth");
  }
  if (mode === "year") {
    if (!/^\d{4}$/.test(value("ledgerYear")))
      throw new Error("سال شمسی را به صورت ۱۴۰۵ وارد کنید.");
    normalizeJalaliDate(`${value("ledgerYear")}/01/01`);
    query.year = value("ledgerYear");
  }
  for (const [id, key] of [
    ["ledgerMin", "min_amount"],
    ["ledgerMax", "max_amount"],
  ]) {
    if (value(id)) query[key] = amountValue(value(id), { allowZero: true });
  }
  if (
    query.min_amount !== undefined &&
    query.max_amount !== undefined &&
    query.max_amount < query.min_amount
  )
    throw new Error("حداکثر مبلغ نباید کمتر از حداقل باشد.");
  if ($("ledgerSearch").value.trim())
    query.search = $("ledgerSearch").value.trim();
  return query;
}

function syncFilterButtons() {
  document
    .querySelectorAll("[data-ledger-mode]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.ledgerMode === $("ledgerDateMode").value),
      ),
    );
}
async function refreshLedger() {
  await Promise.all([loadChart(), loadList()]);
}
async function initialize() {
  if (!(await protectPage())) return;
  $("chartPeriods")
    .querySelectorAll("button")
    .forEach((button) =>
      button.addEventListener("click", () => {
        period = button.dataset.period;
        $("chartPeriods")
          .querySelectorAll("button")
          .forEach((option) =>
            option.setAttribute("aria-pressed", String(option === button)),
          );
        loadChart();
      }),
    );
  document.querySelectorAll("[data-ledger-mode]").forEach((button) =>
    button.addEventListener("click", () => {
      $("ledgerDateMode").value = button.dataset.ledgerMode;
      $("ledgerDateMode").dispatchEvent(new Event("change"));
    }),
  );
  $("ledgerDateMode").addEventListener("change", syncFilterButtons);
  $("ledgerDateMode").addEventListener("change", () =>
    document
      .querySelectorAll("[data-date-mode]")
      .forEach((label) =>
        label.classList.toggle(
          "hidden",
          label.dataset.dateMode !== $("ledgerDateMode").value,
        ),
      ),
  );
  $("ledgerFilters").addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(searchTimer);
    try {
      activeFilters = readFilters();
      loadList();
    } catch (error) {
      $("ledgerError").textContent = error.message;
      $("ledgerError").classList.remove("hidden");
    }
  });
  $("ledgerSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const search = $("ledgerSearch").value.trim();
      activeFilters = { ...activeFilters };
      delete activeFilters.search;
      if (search) activeFilters.search = search;
      loadList();
    }, 300);
  });
  $("resetLedger").addEventListener("click", () => {
    clearTimeout(searchTimer);
    $("ledgerFilters").reset();
    $("ledgerSearch").value = "";
    document
      .querySelectorAll("[data-date-mode]")
      .forEach((label) => label.classList.add("hidden"));
    activeFilters = {};
    syncFilterButtons();
    loadList();
  });
  bindAmount($("ledgerMin"));
  bindAmount($("ledgerMax"));
  $("moreLedger").addEventListener("click", () => {
    if (!loading && cursor) loadList(true);
  });
  $("retryLedger").addEventListener("click", () =>
    loadList($("retryLedger").dataset.more === "true"),
  );
  $("retryChart").addEventListener("click", loadChart);
  window.addEventListener("pagehide", () => {
    chartVersion++;
    listVersion++;
    chartController?.abort();
    listController?.abort();
    clearTimeout(searchTimer);
  });
  onPageRefresh(refreshLedger);
  await refreshLedger();
}
startPage(initialize);
