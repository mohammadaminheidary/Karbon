import { transactionActions } from "../finance/transaction-actions.js";
import { onExternalDataChange } from "../components/data-events.js";
import { initializeNavbar } from "../components/navbar.js";
import { protectPage } from "../guards/auth-guard.js";
import { logout } from "../auth/auth-storage.js";
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

initializeNavbar();
const $ = (id) => document.getElementById(id);
const bankId = new URLSearchParams(window.location.search).get("bank");
const validBank = /^[1-9]\d*$/.test(bankId || "");
const number = (value) => new Intl.NumberFormat("fa-IR").format(value);
let period = "month",
  chartVersion = 0,
  listVersion = 0,
  chartController,
  listController;
let cursor = null,
  loaded = 0,
  activeFilters = {},
  searchTimer,
  loading = false;

function svgNode(tag, attributes = {}, text = "") {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes))
    el.setAttribute(key, value);
  el.textContent = text;
  return el;
}

function renderChart(data) {
  const svg = svgNode("svg", {
    viewBox: "0 0 1000 290",
    class: "finance-chart ledger-chart-enter",
    role: "img",
    "aria-label": `درآمد و هزینه حساب از ${fullDate(data.start_date)} تا ${fullDate(data.end_date)}`,
  });
  const max = Math.max(
    1,
    ...data.chart.flatMap((point) => [point.income, point.expense]),
  );
  const x = (index) => 130 + (index / Math.max(1, data.chart.length - 1)) * 830;
  const y = (value) => 230 - (value / max) * 200;
  for (let i = 0; i <= 4; i++) {
    const value = (max * i) / 4;
    svg.append(
      svgNode("line", {
        x1: 130,
        x2: 960,
        y1: y(value),
        y2: y(value),
        stroke: "#B6C0C6",
        "stroke-opacity": 0.3,
      }),
      svgNode(
        "text",
        {
          x: 115,
          y: y(value) + 4,
          "text-anchor": "end",
          fill: "#64748b",
          "font-size": 11,
        },
        number(Math.round(value)),
      ),
    );
  }
  for (const [key, color, label] of [
    ["income", "#10b981", "درآمد"],
    ["expense", "#dc2626", "هزینه"],
  ]) {
    const points = data.chart
      .map((point, index) => `${x(index)},${y(point[key])}`)
      .join(" ");
    const line = svgNode("polyline", {
      points,
      fill: "none",
      stroke: color,
      "stroke-width": 2.5,
      class: "finance-line",
      pathLength: 1,
    });
    line.append(svgNode("title", {}, label));
    svg.append(line);
    // A single day needs visible marks rather than a zero-length polyline.
    if (data.chart.length === 1)
      svg.append(
        svgNode("circle", {
          cx: x(0),
          cy: y(data.chart[0][key]),
          r: 5,
          class: "ledger-point-enter",
          fill: color,
        }),
      );
  }
  const labels = new Set(
    Array.from({ length: Math.min(6, data.chart.length) }, (_, i) =>
      Math.round(
        (i * (data.chart.length - 1)) /
          Math.max(1, Math.min(6, data.chart.length) - 1),
      ),
    ),
  );
  for (const index of labels)
    svg.append(
      svgNode(
        "text",
        {
          x: x(index),
          y: 265,
          "text-anchor": "middle",
          fill: "#64748b",
          "font-size": 11,
        },
        fullDate(data.chart[index].date),
      ),
    );
  $("bankChart").replaceChildren(svg);
}

async function loadChart() {
  const version = ++chartVersion;
  chartController?.abort();
  chartController = new AbortController();
  $("chartStatus").textContent = "در حال دریافت نمودار...";
  $("chartError").classList.add("hidden");
  $("retryChart").classList.add("hidden");
  $("bankChart").replaceChildren();
  $("chartSummary").replaceChildren();
  $("chartRange").textContent = "";
  try {
    if (!validBank)
      throw new Error(
        "شناسه حساب معتبر نیست. از صفحه بانک‌ها یک حساب را انتخاب کنید.",
      );
    const data = await financeRequest(
      `/banks/${bankId}/activity?period=${period}`,
      { signal: chartController.signal },
    );
    if (version !== chartVersion) return;
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
      data.bank.card_number
        ? formatCardNumber(data.bank.card_number)
        : data.bank.account_number,
    );
    card.dir = "ltr";
    info.append(card);
    $("bankHeader").replaceChildren(bankLogo(data.bank), info);
    $("chartRange").textContent =
      `${fullDate(data.start_date)} تا ${fullDate(data.end_date)} · تومان`;
    $("chartSummary").append(
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
    );
    $("chartStatus").textContent =
      data.summary.income || data.summary.expense
        ? ""
        : "در این بازه تراکنشی ثبت نشده است.";
    renderChart(data);
  } catch (error) {
    if (version !== chartVersion) return;
    $("chartStatus").textContent = "";
    $("chartError").textContent = error.message;
    $("chartError").classList.remove("hidden");
    $("retryChart").classList.remove("hidden");
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
  if (!more) {
    cursor = null;
    loaded = 0;
    $("ledgerRows").replaceChildren();
    $("ledgerTable").classList.add("hidden");
    $("ledgerCount").textContent = "";
  }
  $("ledgerStatus").textContent = "در حال دریافت تراکنش‌ها...";
  $("ledgerError").classList.add("hidden");
  $("retryLedger").classList.add("hidden");
  $("moreLedger").disabled = true;
  const query = new URLSearchParams(activeFilters);
  if (more && cursor) query.set("cursor", cursor);
  try {
    if (!validBank) throw new Error("شناسه حساب معتبر نیست.");
    const result = await financeRequest(
      `/banks/${bankId}/transactions?${query}`,
      { signal: listController.signal },
    );
    if (version !== listVersion) return;
    $("ledgerRows").append(...result.items.map(renderRow));
    loaded += result.items.length;
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
      $("moreLedger").disabled = false;
    }
  }
}

function readFilters() {
  const query = {};
  const mode = $("ledgerDateMode").value;
  const value = (id) => normalizeDigits($(id).value.trim());
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
  $("logoutButton").addEventListener("click", () => {
    logout();
    window.location.replace("/page/login-page.html");
  });
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
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      loadChart();
      loadList();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadChart();
      loadList();
    }
  });
  onExternalDataChange(refreshLedger);
  await refreshLedger();
}
initialize();
