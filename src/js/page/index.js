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
  layoutEditor;
const fullDate = (value) =>
  new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
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
  if (!charts.has(id)) charts.set(id, new Chart($(id), options));
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
function render(result, reset) {
  data = result;
  const d = result,
    daily = d.daily.map((point) => ({
      ...point,
      label: fullDate(point.date),
      shortLabel: dateLabel(point.date),
    }));
  $("dashboardContent").hidden = false;
  $("periodCaption").textContent =
    `${fullDate(d.period.start)} تا ${fullDate(d.period.end)} · مقایسه با ${fullDate(d.period.previous_start)} تا ${fullDate(d.period.previous_end)}`;
  $("revenueValue").textContent = exact(d.finance.income);
  $("expenseValue").textContent = exact(d.finance.expense);
  $("inventoryValue").textContent = exact(d.inventory.value);
  $("revenueChange").textContent = comparison(
    d.finance.income,
    d.previous.income,
  );
  $("expenseChange").textContent = comparison(
    d.finance.expense,
    d.previous.expense,
  );
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
    card.dataset.accent = accent;
    const icon = element("span", "dash-kpi-icon", ["↗", "▧", "◫", "◷"][index]);
    icon.setAttribute("aria-hidden", "true");
    card
      .querySelector(".dash-kpi-content")
      .replaceChildren(
        element("h2", "", label),
        element("strong", "", value),
        element("p", "", note),
        icon,
      );
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
  $("transactionSummary").textContent =
    `${exact(d.finance.transactions)} تراکنش · دریافتی‌های سفارش و تراکنش‌های اسناد در دفتر مالی لحاظ شده‌اند. فروش فاکتور به درآمد اضافه نمی‌شود.`;
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
  $("bankBalance").textContent = `${exact(d.banks.balance)} تومان · مانده فعلی`;
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
  $("customerSummary").textContent =
    `${exact(d.customers.total)} مشتری در کل · ${exact(d.customers.new)} مشتری جدید در بازه`;
  $("customerChange").textContent = comparison(
    d.customers.new,
    d.previous.customers,
    "مشتری",
  );
  chart(
    "customersChart",
    daily,
    { series: [series("customers", "مشتری جدید", "primary")], bars: true },
    reset,
  );
  chart(
    "productsChart",
    d.product_sales.map((p) => ({
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
  $("stockSummary").textContent =
    `${exact(d.inventory.tracked)} کالای دارای موجودی · ${exact(d.inventory.services)} قلم بدون ردیابی موجودی · ${exact(d.inventory.out_of_stock)} کالای فعال ناموجود`;
  $("debtorsCount").textContent =
    `${exact(d.customers.debtor_count)} مشتری بدهکار`;
  const debtHost = $("debtorsTable");
  debtHost.replaceChildren();
  if (!d.customers.debtors.length)
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
    d.customers.debtors.forEach((p) => {
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
  const completion = d.tasks.total
    ? `${number.format((d.tasks.completed / d.tasks.total) * 100)}٪ تکمیل`
    : "کاری در بازه ثبت نشده";
  $("taskSummary").textContent = `${exact(d.tasks.total)} کار · ${completion}`;
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
  $("attendanceSummary").textContent =
    `${exact(d.attendance.members)} عضو فعلی · ${exact(d.attendance.today_present)} حضور ثبت‌شده امروز`;
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
  $("attendanceRate").textContent = records
    ? `${number.format((d.attendance.present / records) * 100)}٪ حضور از ${exact(records)} رکورد ثبت‌شده؛ روزهای بدون ثبت در نرخ حضور محاسبه نمی‌شوند. ${comparison(d.attendance.present, d.previous.present, "حضور")}`
    : "حضور و غیابی در بازه ثبت نشده است؛ روز بدون ثبت به معنای غیبت نیست.";
  $("documentSummary").textContent =
    `${exact(d.documents.total)} سند در بازه انتخابی`;
  chart(
    "documentsChart",
    daily,
    { series: [series("documents", "سند", "primary")], bars: true },
    reset,
  );
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
    [d.customers.debtor_count, "مشتری دارای بدهی", "/page/customers-page.html"],
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
  layoutEditor ||= new LayoutEditor($("dashboardGrid"));
  layoutEditor.contentChanged();
}

async function load() {
  const requestId = ++revision;
  controller?.abort();
  controller = new AbortController();
  const range =
    currentPeriod === "custom" ? requestedRange : { days: currentPeriod };
  if (!range) return;
  $("dashboardWorkspace").setAttribute("aria-busy", "true");
  $("dashboardStatus").textContent = "در حال بروزرسانی…";
  $("refreshDashboard").disabled = true;
  try {
    const result = await financeRequest(
      `/dashboard?${new URLSearchParams(range)}`,
      { signal: controller.signal, cache: "no-store" },
    );
    if (requestId !== revision) return;
    const key = `${result.period.start}/${result.period.end}`;
    render(result, displayedRange !== key);
    displayedRange = key;
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
  onPageRefresh(load, { maxAge: 30000 });
  window.addEventListener("focus", () => {
    if (!document.hidden) void load();
  });
  window.addEventListener("pagehide", () => {
    clearInterval(polling);
    controller?.abort();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) startPolling();
  });
  await load();
  startPolling();
});
