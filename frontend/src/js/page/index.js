import { startPage } from "../components/page-ready.js";
import { initializeNavbar } from "../components/navbar.js";
import { protectPage } from "../guards/auth-guard.js";
import { onPageRefresh } from "../components/data-events.js";
import { financeRequest } from "../finance/finance-api.js";
import { dashboardPalette } from "../dashboard/theme.js";
import { LayoutEditor } from "../dashboard/layout-editor.js";
import {
  Chart,
  dateLabel,
  exact,
  number,
  element,
} from "../dashboard/chart.js";

initializeNavbar();
const $ = (id) => document.getElementById(id);
const colors = dashboardPalette();
const series = (key, label, color) => ({ key, label, color: colors[color] });
const charts = new Map();
let controller,
  currentPeriod = "30",
  requestedRange,
  displayedRange,
  data,
  revision = 0,
  polling,
  layoutEditor,
  pendingLoad,
  pendingRange,
  renderedFingerprint;
const fullDateFormat = new Intl.DateTimeFormat("fa-IR", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const fullDate = (value) =>
  fullDateFormat.format(new Date(`${value}T12:00:00Z`));
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: data?.timezone || "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
function rollingRange(days) {
  const end = today();
  const start = new Date(`${end}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { start_date: start.toISOString().slice(0, 10), end_date: end };
}
function chart(id, rows, options, reset) {
  if (!charts.has(id))
    charts.set(id, new Chart($(id), { ...options, palette: colors }));
  charts.get(id).update(rows, reset);
}
function comparison(value, previous, unit = "تومان") {
  const now = BigInt(value),
    before = BigInt(previous),
    delta = now - before;
  const base = before < 0n ? -before : before;
  const percentage =
    base === 0n
      ? null
      : Number(((delta < 0n ? -delta : delta) * 1000n) / base) / 10;
  const change =
    delta === 0n
      ? "بدون تغییر"
      : `${delta > 0n ? "↑" : "↓"} ${percentage === null ? `${exact(delta < 0n ? -delta : delta)} ${unit}` : `${number.format(percentage)}٪`}`;
  return `${change} نسبت به بازه قبل${before === 0n && delta !== 0n ? " (مبنای صفر)" : ""} · قبل: ${exact(before)} ${unit}`;
}
function stat(host, label, value) {
  const item = element("span");
  item.append(
    element("strong", "", value),
    document.createTextNode(` ${label}`),
  );
  host.append(item);
}
const renderedSections = new WeakMap();
function updateSection(host, value, paint) {
  const signature = JSON.stringify(value);
  if (renderedSections.get(host) === signature) return;
  paint();
  renderedSections.set(host, signature);
}
function setText(id, value) {
  const host = $(id);
  if (host.textContent !== value) host.textContent = value;
}
function render(result, reset) {
  data = result;
  const d = result,
    daily = d.daily.map((point) => ({
      ...point,
      label: fullDate(point.date),
      shortLabel: dateLabel(point.date),
    }));
  $("dashboardContent").hidden = false;
  setText(
    "periodCaption",
    `${fullDate(d.period.start)} تا ${fullDate(d.period.end)} · مقایسه با ${fullDate(d.period.previous_start)} تا ${fullDate(d.period.previous_end)}`,
  );
  setText("revenueValue", exact(d.finance.income));
  setText("expenseValue", exact(d.finance.expense));
  setText("inventoryValue", exact(d.inventory.value));
  setText("revenueChange", comparison(d.finance.income, d.previous.income));
  setText("expenseChange", comparison(d.finance.expense, d.previous.expense));
  chart(
    "revenueChart",
    daily,
    { series: [series("income", "درآمد", "primary")], money: true, bars: true },
    reset,
  );
  chart(
    "expenseChart",
    daily,
    {
      series: [series("expense", "هزینه", "secondary")],
      money: true,
      bars: true,
    },
    reset,
  );
  chart(
    "inventoryChart",
    d.inventory.products.map((p) => ({
      label: p.name,
      value: p.value,
      detail: `${exact(p.stock)} ${p.unit} × ${exact(p.price)} تومان${p.active ? "" : " · غیرفعال"}`,
    })),
    {
      series: [series("value", "ارزش موجودی", "primary")],
      bars: true,
      money: true,
    },
    reset,
  );
  for (const [index, [label, value, note, accent]] of [
    [
      "خالص جریان نقدی",
      `${exact(d.finance.net)} تومان`,
      comparison(d.finance.net, d.previous.net),
      "primary",
    ],
    [
      "فروش خالص فاکتورها",
      `${exact(d.orders.sales)} تومان`,
      comparison(d.orders.sales, d.previous.sales),
      "primary",
    ],
    [
      "سفارش‌های فعال",
      exact(d.orders.active_total),
      `${exact(d.orders.total)} سفارش در کل سوابق`,
      "primary",
    ],
    [
      "مطالبات فعلی",
      `${exact(d.orders.outstanding)} تومان`,
      `${exact(d.orders.overdue)} تومان با موعد گذشته`,
      "primary",
    ],
  ].entries()) {
    const id = ["net", "invoiced", "active-orders", "outstanding"][index];
    const card = document.querySelector(`[data-widget-id="${id}"]`);
    updateSection(card, [label, value, note, accent], () => {
      card.dataset.accent = accent;
      const icon = element(
        "span",
        "dash-kpi-icon",
        ["↗", "▧", "◫", "◷"][index],
      );
      icon.setAttribute("aria-hidden", "true");
      card
        .querySelector(".dash-kpi-content")
        .replaceChildren(
          element("h2", "", label),
          element("strong", "", value),
          element("p", "", note),
          icon,
        );
    });
  }
  chart(
    "cashflowChart",
    daily,
    {
      series: [
        series("income", "درآمد", "primary"),
        series("expense", "هزینه", "secondary"),
      ],
      money: true,
      height: 230,
    },
    reset,
  );
  setText(
    "transactionSummary",
    `${exact(d.finance.transactions)} تراکنش · دریافتی‌های سفارش و تراکنش‌های اسناد در دفتر مالی لحاظ شده‌اند. فروش فاکتور به درآمد اضافه نمی‌شود.`,
  );
  chart(
    "expenseBreakdownChart",
    d.expenses.map((p) => ({
      label: p.name,
      amount: p.amount,
      detail: `${exact(p.count)} تراکنش`,
    })),
    {
      series: [series("amount", "هزینه", "secondary")],
      money: true,
      donut: true,
      height: 230,
    },
    reset,
  );
  chart(
    "salesChart",
    daily.map((p) => ({ ...p, detail: `${exact(p.orders)} سفارش` })),
    {
      series: [series("sales", "فروش خالص", "primary")],
      money: true,
      bars: true,
    },
    reset,
  );
  updateSection(
    $("orderStats"),
    [
      d.orders.count,
      d.orders.completed,
      d.orders.active,
      d.orders.discount,
      d.previous.orders,
    ],
    () => {
      $("orderStats").replaceChildren();
      stat($("orderStats"), "فاکتور در بازه", exact(d.orders.count));
      stat($("orderStats"), "تکمیل‌شده", exact(d.orders.completed));
      stat($("orderStats"), "فعال", exact(d.orders.active));
      stat($("orderStats"), "تومان تخفیف", exact(d.orders.discount));
      $("orderStats").append(
        element(
          "p",
          "dash-footnote",
          comparison(d.orders.count, d.previous.orders, "فاکتور"),
        ),
      );
    },
  );
  setText("bankBalance", `${exact(d.banks.balance)} تومان · مانده فعلی`);
  chart(
    "bankChart",
    d.banks.items.map((p) => ({
      label: p.name,
      balance: p.balance,
      detail: p.active ? "حساب فعال" : "حساب غیرفعال",
    })),
    {
      series: [series("balance", "مانده حساب", "primary")],
      money: true,
      bars: true,
    },
    reset,
  );
  setText(
    "customerSummary",
    `${exact(d.customers.total)} مشتری در کل · ${exact(d.customers.new)} مشتری جدید در بازه`,
  );
  setText(
    "customerChange",
    comparison(d.customers.new, d.previous.customers, "مشتری"),
  );
  chart(
    "customersChart",
    daily,
    { series: [series("customers", "مشتری جدید", "primary")], bars: true },
    reset,
  );
  if (!charts.has("productsChart"))
    charts.set(
      "productsChart",
      new Chart($("productsChart"), {
        series: [series("gross", "فروش ناخالص", "primary")],
        bars: true,
        money: true,
        palette: colors,
      }),
    );
  setText(
    "stockSummary",
    `${exact(d.inventory.tracked)} کالای دارای موجودی · ${exact(d.inventory.services)} قلم بدون ردیابی موجودی · ${exact(d.inventory.out_of_stock)} کالای فعال ناموجود`,
  );
  setText("debtorsCount", `${exact(d.customers.debtor_count)} مشتری بدهکار`);
  const completion = d.tasks.total
    ? `${number.format((d.tasks.completed / d.tasks.total) * 100)}٪ تکمیل`
    : "کاری در بازه ثبت نشده";
  setText("taskSummary", `${exact(d.tasks.total)} کار · ${completion}`);
  chart(
    "tasksChart",
    daily,
    {
      series: [
        series("tasks", "همه کارها", "muted"),
        series("tasks_completed", "انجام‌شده", "primary"),
      ],
      bars: true,
    },
    reset,
  );
  updateSection(
    $("taskStatus"),
    [
      d.tasks.todo,
      d.tasks.in_progress,
      d.tasks.completed,
      d.previous.tasks_completed,
    ],
    () => {
      $("taskStatus").replaceChildren();
      stat($("taskStatus"), "برای انجام", exact(d.tasks.todo));
      stat($("taskStatus"), "در حال انجام", exact(d.tasks.in_progress));
      stat($("taskStatus"), "انجام‌شده", exact(d.tasks.completed));
      $("taskStatus").append(
        element(
          "p",
          "dash-footnote",
          comparison(
            d.tasks.completed,
            d.previous.tasks_completed,
            "کار تکمیل‌شده",
          ),
        ),
      );
    },
  );
  setText(
    "attendanceSummary",
    `${exact(d.attendance.members)} عضو فعلی · ${exact(d.attendance.today_present)} حضور ثبت‌شده امروز`,
  );
  chart(
    "attendanceChart",
    daily,
    {
      series: [
        series("present", "حاضر", "primary"),
        series("absent", "غایب", "secondary"),
      ],
    },
    reset,
  );
  const records = d.attendance.present + d.attendance.absent;
  setText(
    "attendanceRate",
    records
      ? `${number.format((d.attendance.present / records) * 100)}٪ حضور از ${exact(records)} رکورد ثبت‌شده؛ روزهای بدون ثبت در نرخ حضور محاسبه نمی‌شوند. ${comparison(d.attendance.present, d.previous.present, "حضور")}`
      : "حضور و غیابی در بازه ثبت نشده است؛ روز بدون ثبت به معنای غیبت نیست.",
  );
  setText("documentSummary", `${exact(d.documents.total)} سند در بازه انتخابی`);
  chart(
    "documentsChart",
    daily,
    { series: [series("documents", "سند", "primary")], bars: true },
    reset,
  );
  updateSection(
    $("documentTypes"),
    [d.documents.types, d.documents.total, d.previous.documents],
    () => {
      $("documentTypes").replaceChildren();
      d.documents.types.forEach((p) =>
        stat($("documentTypes"), p.name, exact(p.count)),
      );
      $("documentTypes").append(
        element(
          "p",
          "dash-footnote",
          comparison(d.documents.total, d.previous.documents, "سند"),
        ),
      );
    },
  );
  updateSection(
    $("dashboardAlerts"),
    [d.tasks.overdue, d.inventory.out_of_stock, d.customers.debtor_count],
    () => {
      $("dashboardAlerts").replaceChildren();
      for (const [count, label, href] of [
        [
          d.tasks.overdue,
          "کار ناتمام با تاریخ گذشته",
          "/page/daily-tasks-page.html",
        ],
        [
          d.inventory.out_of_stock,
          "کالای فعال با موجودی صفر",
          "/page/settings-page.html#products",
        ],
        [
          d.customers.debtor_count,
          "مشتری دارای بدهی",
          "/page/customers-page.html",
        ],
      ]) {
        if (!count) continue;
        const link = element("a", "", `${exact(count)} ${label} ↗`);
        link.href = href;
        $("dashboardAlerts").append(link);
      }
      if (!$("dashboardAlerts").childElementCount)
        $("dashboardAlerts").append(
          element("p", "dash-muted", "موردی برای پیگیری وجود ندارد."),
        );
    },
  );
  layoutEditor ||= new LayoutEditor($("dashboardGrid"));
  layoutEditor.contentChanged();
}

function renderProductSales(rows, reset) {
  chart(
    "productsChart",
    rows.map((p) => ({
      label: `${p.name} (${p.unit})`,
      gross: p.gross,
      detail: `${exact(p.quantity)} ${p.unit}`,
    })),
    {
      series: [series("gross", "فروش ناخالص", "primary")],
      bars: true,
      money: true,
    },
    reset,
  );
}
function renderDebtors(rows) {
  const debtHost = $("debtorsTable");
  debtHost.replaceChildren();
  if (!rows.length)
    debtHost.append(
      element("p", "dash-empty", "مطالبات تسویه‌نشده‌ای ثبت نشده است."),
    );
  else {
    const table = element("table", "dash-table"),
      head = element("thead"),
      tr = element("tr"),
      body = element("tbody");
    ["مشتری", "مانده بدهی (تومان)"].forEach((label) => {
      const th = element("th", "", label);
      th.scope = "col";
      tr.append(th);
    });
    head.append(tr);
    rows.forEach((p) => {
      const row = element("tr");
      row.append(
        element("td", "", p.name),
        element("td", "dash-numeric", exact(p.amount)),
      );
      body.append(row);
    });
    table.append(
      element("caption", "dash-sr", "مطالبات فعلی به تفکیک مشتری"),
      head,
      body,
    );
    debtHost.append(table);
  }
}

const detailViews = new Map([
  ["products", { host: "productsChart", render: renderProductSales }],
  ["debtors", { host: "debtorsTable", render: renderDebtors }],
]);
let detailsController,
  detailsActive = false,
  detailRange,
  detailVersion;
function observeDetails() {
  const observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const view = [...detailViews.values()].find(
                (view) => view.host === entry.target.id,
              );
              view.visible = entry.isIntersecting;
              if (view.visible) void loadDetail(view);
            }
          },
          { rootMargin: "150px" },
        );
  for (const [name, view] of detailViews) {
    view.name = name;
    view.status = element("p", "dash-muted");
    view.status.setAttribute("role", "status");
    $(view.host).before(view.status);
    if (observer) observer.observe($(view.host));
    else view.visible = true;
  }
}
function refreshDetails(result, version) {
  detailsController = new AbortController();
  detailRange = {
    start_date: result.period.start,
    end_date: result.period.end,
  };
  detailVersion = version;
  detailsActive = true;
  for (const view of detailViews.values()) {
    view.loaded = false;
    $(view.host).dataset.detailState = "loading";
    view.pending = undefined;
    view.status.hidden = false;
    view.status.textContent = "در حال دریافت اطلاعات…";
    const rows =
      view.name === "products"
        ? result.product_sales
        : result.customers.debtors;
    if (rows) applyDetail(view, rows);
    else if (view.visible) void loadDetail(view);
  }
}
function applyDetail(view, rows) {
  // Refresh unchanged detail widgets without destroying selections or tables.
  const signature = JSON.stringify(
    view.name === "products" ? { range: detailRange, rows } : rows,
  );
  if (view.signature !== signature) {
    view.render(rows, view.range !== JSON.stringify(detailRange));
    view.signature = signature;
    view.range = JSON.stringify(detailRange);
    layoutEditor?.contentChanged();
  }
  view.loaded = true;
  $(view.host).dataset.detailState = "ready";
  $(view.host).setAttribute("aria-busy", "false");
  view.status.hidden = true;
}
async function loadDetail(view) {
  if (!detailsActive || view.loaded || view.pending) return;
  $(view.host).setAttribute("aria-busy", "true");
  const version = detailVersion,
    signal = detailsController.signal;
  const pending = financeRequest(
    `/dashboard?${new URLSearchParams({ ...detailRange, view: view.name })}`,
    { signal, cache: "no-store" },
  );
  view.pending = pending;
  try {
    const result = await pending;
    if (signal.aborted || version !== revision) return;
    const rows =
      view.name === "products"
        ? result.product_sales
        : result.customers.debtors;
    applyDetail(view, rows);
  } catch (error) {
    if (signal.aborted || version !== revision) return;
    $(view.host).dataset.detailState = "error";
    const retry = element("button", "", "تلاش مجدد");
    retry.type = "button";
    retry.addEventListener("click", () => {
      view.status.textContent = "در حال دریافت اطلاعات…";
      void loadDetail(view);
    });
    view.status.replaceChildren(
      document.createTextNode(`${error.message} `),
      retry,
    );
  } finally {
    if (view.pending === pending) {
      view.pending = undefined;
      $(view.host).setAttribute("aria-busy", "false");
    }
  }
}

function load() {
  const range = JSON.stringify(
    currentPeriod === "custom" ? requestedRange : { days: currentPeriod },
  );
  if (pendingLoad && pendingRange === range) return pendingLoad;
  pendingRange = range;
  const current = fetchDashboard().finally(() => {
    if (pendingLoad === current) pendingLoad = undefined;
  });
  pendingLoad = current;
  return current;
}

async function fetchDashboard() {
  const requestId = ++revision;
  detailsActive = false;
  detailsController?.abort();
  controller?.abort();
  controller = new AbortController();
  const range =
    currentPeriod === "custom" ? requestedRange : { days: currentPeriod };
  if (!range) return;
  $("dashboardWorkspace").setAttribute("aria-busy", "true");
  $("dashboardStatus").textContent = "در حال بروزرسانی…";
  $("refreshDashboard").disabled = true;
  try {
    const visibleDetails = {};
    for (const [name, view] of detailViews) {
      if (view.visible) visibleDetails[`include_${name}`] = "true";
    }
    const result = await financeRequest(
      `/dashboard?${new URLSearchParams({ ...range, view: "summary", ...visibleDetails })}`,
      { signal: controller.signal, cache: "no-store" },
    );
    if (requestId !== revision) return;
    const key = `${result.period.start}/${result.period.end}`;
    const fingerprint = JSON.stringify({ ...result, generated_at: null });
    if (fingerprint !== renderedFingerprint) {
      render(result, displayedRange !== key);
      renderedFingerprint = fingerprint;
    } else data = result;
    displayedRange = key;
    refreshDetails(result, requestId);
    $("dashboardError").hidden = true;
    $("dashboardStatus").textContent =
      `بروزرسانی ${new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: result.timezone }).format(new Date(result.generated_at))}`;
    $("dashboardStatus").dataset.state = "live";
  } catch (error) {
    if (requestId !== revision || controller.signal.aborted) return;
    $("dashboardError").hidden = false;
    $("dashboardError").querySelector("span").textContent =
      `${error.message}${data ? " اطلاعات نمایش‌داده‌شده مربوط به آخرین دریافت موفق است." : ""}`;
    $("dashboardStatus").textContent = data
      ? "اطلاعات نیازمند بروزرسانی است"
      : "دریافت اطلاعات انجام نشد";
    $("dashboardStatus").dataset.state = "error";
  } finally {
    if (requestId === revision) {
      $("dashboardWorkspace").setAttribute("aria-busy", "false");
      $("dashboardLoading").hidden = true;
      $("refreshDashboard").disabled = false;
    }
  }
}
function startPolling() {
  clearInterval(polling);
  polling = setInterval(() => {
    if (
      !document.hidden &&
      $("dashboardWorkspace").getAttribute("aria-busy") !== "true"
    )
      void load();
  }, 30000);
}
startPage(async () => {
  if (!(await protectPage())) return false;
  requestedRange = rollingRange(30);
  $("dashboardStart").value = requestedRange.start_date;
  $("dashboardEnd").value = requestedRange.end_date;
  document.querySelectorAll("[data-period]").forEach((button) =>
    button.addEventListener("click", () => {
      const custom = button.dataset.period === "custom";
      $("dashboardDates").hidden = !custom;
      if (custom) {
        $("dashboardStart").focus();
        return;
      }
      currentPeriod = button.dataset.period;
      document
        .querySelectorAll("[data-period]")
        .forEach((item) =>
          item.setAttribute("aria-pressed", String(item === button)),
        );
      void load();
    }),
  );
  $("dashboardDates").addEventListener("submit", (event) => {
    event.preventDefault();
    const start = $("dashboardStart"),
      end = $("dashboardEnd");
    end.setCustomValidity("");
    const days = (Date.parse(end.value) - Date.parse(start.value)) / 86400000;
    if (days < 0 || days >= 366 || start.value < "1901-01-01") {
      end.setCustomValidity("بازه مرتب و حداکثر ۳۶۶ روز باشد.");
      end.reportValidity();
      return;
    }
    requestedRange = { start_date: start.value, end_date: end.value };
    currentPeriod = "custom";
    document
      .querySelectorAll("[data-period]")
      .forEach((item) =>
        item.setAttribute(
          "aria-pressed",
          String(item.dataset.period === "custom"),
        ),
      );
    void load();
  });
  $("dashboardEnd").addEventListener("input", () =>
    $("dashboardEnd").setCustomValidity(""),
  );
  $("dashboardStart").addEventListener("input", () =>
    $("dashboardEnd").setCustomValidity(""),
  );
  $("refreshDashboard").addEventListener("click", load);
  $("retryDashboard").addEventListener("click", load);
  // A mutation during an existing snapshot must fetch again after it settles.
  // Focus/poll events can share an in-flight read; data-change events cannot.
  onPageRefresh(() => (pendingLoad ? pendingLoad.then(load) : load()), {
    maxAge: 30000,
  });
  window.addEventListener("focus", () => {
    if (!document.hidden) void load();
  });
  window.addEventListener("pagehide", () => {
    clearInterval(polling);
    controller?.abort();
    detailsController?.abort();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      // History can retain fresh data after pagehide cancelled the controller.
      // Deferred widgets still need a live controller when first scrolled into view.
      if (detailsActive && detailsController?.signal.aborted) {
        detailsController = new AbortController();
        for (const view of detailViews.values()) {
          if (view.visible) void loadDetail(view);
        }
      }
      startPolling();
    }
  });
  observeDetails();
  await load();
  startPolling();
});
