import { transactionActions } from "../finance/transaction-actions.js";
import { onExternalDataChange } from "../components/data-events.js";
import { initializeNavbar } from "../components/navbar.js";
import { bankLogo } from "../finance/bank-accounts.js";
import { Dialog } from "../components/dialog.js";
import { protectPage } from "../guards/auth-guard.js";
import { logout } from "../auth/auth-storage.js";
import { getCustomers } from "../customers/customer-api.js";
import {
  getBanks,
  getExpenseCategories,
  getFinanceDay,
  getFinanceCalendar,
  createTransaction,
} from "../finance/finance-api.js";
import {
  money,
  fullDate,
  todayKey,
  shiftDay,
  node,
  amountValue,
  bindAmount,
  normalizeDigits,
  formatJalaliInput,
  normalizeJalaliDate,
} from "../finance/finance-utils.js";

initializeNavbar();
const $ = (id) => document.getElementById(id);
let selectedDay = todayKey(),
  calendarCenter = selectedDay;
let dayController,
  calendarVersion = 0,
  optionsVersion = 0;
let kind = "income",
  sources = [],
  saving = false,
  optionsReady = false;
let requestId, requestFingerprint;
const dialog = new Dialog("transactionModal", {
  canClose: () => !saving,
  onCancel: () => {
    optionsVersion++;
  },
});

function showError(error) {
  $("financeErrorText").textContent = error.message;
  $("financeError").classList.remove("hidden");
}

function clearDay() {
  ["totalIncome", "totalExpense", "totalBalance", "transactionCount"].forEach(
    (id) => ($(id).textContent = "—"),
  );
  $("financeChart").replaceChildren();
  $("financeChartEmpty").classList.add("hidden");
  $("transactionRows").replaceChildren();
  $("transactionsTable").classList.add("hidden");
  $("transactionsStatus").classList.remove("hidden");
  $("transactionsStatus").textContent = "در حال دریافت اطلاعات...";
}

async function selectDay(day) {
  selectedDay = day;
  $("selectedDateLabel").textContent = fullDate(day);
  dayController?.abort();
  const controller = new AbortController();
  dayController = controller;
  $("financeDayContent").setAttribute("aria-busy", "true");
  $("financeSummary").setAttribute("aria-busy", "true");
  $("financeError").classList.add("hidden");
  clearDay();
  updateCalendarSelection();
  try {
    const data = await getFinanceDay(day, controller.signal);
    if (controller.signal.aborted || selectedDay !== day) return;
    $("totalIncome").textContent = money(data.summary.income);
    $("totalExpense").textContent = money(data.summary.expense);
    $("totalBalance").textContent = money(data.summary.balance);
    renderChart(data.chart);
    renderTransactions(data.transactions);
    $("financeChartEmpty").classList.toggle(
      "hidden",
      data.transactions.length > 0,
    );
  } catch (error) {
    if (controller.signal.aborted) return;
    $("transactionsStatus").textContent =
      "دریافت اطلاعات انجام نشد. دوباره تلاش کنید.";
    showError(error);
  } finally {
    if (dayController === controller) {
      $("financeDayContent").setAttribute("aria-busy", "false");
      $("financeSummary").setAttribute("aria-busy", "false");
    }
  }
}

function updateCalendarSelection() {
  $("financeCalendar")
    .querySelectorAll("button[data-date]")
    .forEach((button) => {
      const selected = button.dataset.date === selectedDay;
      button.setAttribute("aria-pressed", String(selected));
      button.classList.toggle("border-persian-blue", selected);
      button.classList.toggle("bg-persian-blue/5", selected);
      button.classList.toggle("border-french-gray/30", !selected);
    });
}

async function loadCalendar({ scroll = false } = {}) {
  const version = ++calendarVersion;
  const center = calendarCenter;
  $("financeCalendar").setAttribute("aria-busy", "true");
  if (!$("financeCalendar").children.length)
    $("financeCalendar").append(
      node("p", "p-5 text-sm text-mirage/45", "در حال دریافت تقویم..."),
    );
  try {
    const days = await getFinanceCalendar(
      shiftDay(center, -7),
      shiftDay(center, 6),
    );
    if (version !== calendarVersion) return;
    $("financeCalendar").replaceChildren(
      ...days.map((day) => {
        const button = node(
          "button",
          "w-[170px] shrink-0 rounded-2xl border p-3 text-right transition-colors hover:border-persian-blue/40",
        );
        button.type = "button";
        button.dataset.date = day.date;
        const date = new Date(`${day.date}T12:00:00+03:30`);
        const weekday = new Intl.DateTimeFormat("fa-IR", {
          weekday: "long",
          timeZone: "Asia/Tehran",
        }).format(date);
        button.append(
          node(
            "p",
            "text-xs text-mirage/45",
            weekday + (day.date === todayKey() ? " · امروز" : ""),
          ),
          node("p", "mt-2 font-black", fullDate(day.date)),
        );
        for (const [key, label, color] of [
          ["income", "درآمد", "text-eucalyptus"],
          ["expense", "هزینه", "text-alizarin-crimson"],
          ["balance", "مانده", "text-california"],
        ]) {
          button.append(
            node(
              "p",
              `mt-2 text-[11px] font-bold ${color}`,
              `${label}: ${new Intl.NumberFormat("fa-IR").format(day[key])}`,
            ),
          );
        }
        button.addEventListener("click", () => selectDay(day.date));
        return button;
      }),
    );
    updateCalendarSelection();
    if (scroll)
      $("financeCalendar")
        .querySelector(`[data-date="${selectedDay}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "center" });
  } catch (error) {
    if (version !== calendarVersion) return;
    $("financeCalendar").replaceChildren(
      node("p", "p-4 text-sm text-alizarin-crimson", "دریافت تقویم انجام نشد."),
    );
    showError(error);
  } finally {
    if (version === calendarVersion)
      $("financeCalendar").setAttribute("aria-busy", "false");
  }
}

function renderTransactions(items) {
  $("transactionCount").textContent =
    `${new Intl.NumberFormat("fa-IR").format(items.length)} تراکنش`;
  $("transactionsStatus").classList.toggle("hidden", items.length > 0);
  $("transactionsStatus").textContent = "برای این روز تراکنشی ثبت نشده است.";
  $("transactionsTable").classList.toggle("hidden", items.length === 0);
  $("transactionRows").replaceChildren(
    ...items.map((item) => {
      const row = node("tr", "border-t border-french-gray/20");
      const income = item.kind === "income";
      const color = income ? "text-eucalyptus" : "text-alizarin-crimson";
      const type = node("td", "p-4");
      type.append(
        node(
          "span",
          `rounded-lg px-3 py-1 text-xs font-bold ${color} ${income ? "bg-eucalyptus/10" : "bg-alizarin-crimson/10"}`,
          income ? "درآمد" : "هزینه",
        ),
      );
      const title = node("td", "max-w-xs p-4");
      title.append(node("p", "break-words font-bold", item.title));
      if (item.description)
        title.append(
          node(
            "p",
            "mt-1 whitespace-pre-wrap break-words text-xs text-mirage/50",
            item.description,
          ),
        );
      title.append(
        node(
          "p",
          "mt-1 text-xs text-mirage/40",
          `کد حساب: ${item.account_code}`,
        ),
      );
      if (item.tracking_number)
        title.append(
          node(
            "p",
            "mt-1 break-all text-xs text-mirage/40",
            `پیگیری: ${item.tracking_number}`,
          ),
        );
      const bank = node("td", "p-4");
      const bankIdentity = node("div", "flex items-center gap-3");
      bankIdentity.append(
        bankLogo(item.bank),
        node("p", "font-medium", item.bank.name),
      );
      bank.append(
        bankIdentity,
        node("p", "mt-1 text-xs text-mirage/45", item.bank.account_number),
      );
      const date = node(
        "td",
        "whitespace-nowrap p-4",
        fullDate(item.transaction_date),
      );
      const time = node(
        "p",
        "mt-1 text-xs text-mirage/50",
        normalizeDigits(item.transaction_time).slice(0, 5),
      );
      time.dir = "ltr";
      date.append(time);
      row.append(
        type,
        title,
        bank,
        date,
        node(
          "td",
          `whitespace-nowrap p-4 font-bold ${color}`,
          `${income ? "+" : "−"} ${money(item.amount)}`,
        ),
      );
      row.append(
        transactionActions(item, async () => {
          await Promise.all([selectDay(selectedDay), loadCalendar()]);
        }),
      );
      return row;
    }),
  );
}

function svgNode(tag, attrs = {}, text = "") {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs))
    element.setAttribute(key, value);
  element.textContent = text;
  return element;
}

function renderChart(points) {
  const svg = svgNode("svg", {
    viewBox: "0 0 1000 280",
    class: "finance-chart",
    role: "img",
    "aria-labelledby": "financeChartTitle financeChartDescription",
    direction: "ltr",
  });
  svg.append(
    svgNode(
      "title",
      { id: "financeChartTitle" },
      `روند مالی ${fullDate(selectedDay)}`,
    ),
    svgNode(
      "desc",
      { id: "financeChartDescription" },
      "درآمد، هزینه و مانده تجمعی بر اساس زمان تراکنش‌ها، از ساعت صفر تا پایان روز. جزئیات در جدول تراکنش‌ها آمده است.",
    ),
  );
  const values = points.flatMap((point) => [
    point.income,
    point.expense,
    point.balance,
  ]);
  const min = values.reduce((lowest, value) => Math.min(lowest, value), 0),
    max = values.reduce((highest, value) => Math.max(highest, value), 4);
  const y = (value) => 232 - ((value - min) / (max - min)) * 204;
  const x = (time) => {
    const [hour, minute, second] = time.split(":").map(Number);
    return 125 + ((hour * 3600 + minute * 60 + second) / 86400) * 840;
  };
  for (let i = 0; i <= 4; i++) {
    const value = min + ((max - min) * i) / 4;
    svg.append(
      svgNode("line", {
        x1: 125,
        x2: 965,
        y1: y(value),
        y2: y(value),
        stroke: "#B6C0C6",
        "stroke-opacity": ".3",
      }),
      svgNode(
        "text",
        {
          x: 113,
          y: y(value) + 4,
          "text-anchor": "end",
          fill: "#64748b",
          "font-size": 11,
        },
        new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 }).format(
          value,
        ),
      ),
    );
  }
  for (let hour = 0; hour <= 24; hour += 3)
    svg.append(
      svgNode(
        "text",
        {
          x: 125 + (hour / 24) * 840,
          y: 262,
          "text-anchor": "middle",
          fill: "#64748b",
          "font-size": 12,
        },
        `${String(hour).padStart(2, "0")}:00`,
      ),
    );
  for (const [key, color] of [
    ["income", "#16A34A"],
    ["expense", "#DC2626"],
    ["balance", "#F59E0B"],
  ]) {
    let path = `M ${x(points[0].time)} ${y(points[0][key])}`;
    for (const point of points.slice(1))
      path += ` H ${x(point.time)} V ${y(point[key])}`;
    svg.append(
      svgNode("path", {
        d: path,
        stroke: color,
        "stroke-width": 2.5,
        fill: "none",
        pathLength: 1,
        class: "finance-line",
      }),
    );
  }
  for (const point of points.slice(1, -1)) {
    const circle = svgNode("circle", {
      cx: x(point.time),
      cy: y(point.balance),
      r: 3.5,
      fill: "#F59E0B",
    });
    circle.append(
      svgNode("title", {}, `${point.time} · مانده ${money(point.balance)}`),
    );
    svg.append(circle);
  }
  $("financeChart").replaceChildren(svg);
}

function setFormBusy() {
  $("transactionFields").disabled = saving || !optionsReady;
  $("submitTransaction").disabled = saving || !optionsReady;
  $("submitTransaction").textContent = saving
    ? "در حال ثبت..."
    : kind === "income"
      ? "ثبت درآمد"
      : "ثبت هزینه";
  $("transactionForm").setAttribute("aria-busy", String(saving));
  $("transactionModal")
    .querySelectorAll("[data-dialog-close]")
    .forEach((button) => (button.disabled = saving));
}

function setOptions(select, items, placeholder, label) {
  select.replaceChildren(
    new Option(placeholder, ""),
    ...items.map((item) => new Option(label(item), String(item.id))),
  );
}

async function allCustomers() {
  const items = [];
  let page;
  do {
    page = await getCustomers({ skip: items.length, limit: 100 });
    items.push(...page.items);
  } while (items.length < page.total && page.items.length);
  return items;
}

async function loadOptions() {
  const version = ++optionsVersion;
  optionsReady = false;
  setFormBusy();
  $("transactionFormError").classList.add("hidden");
  $("retryTransactionOptions").classList.add("hidden");
  $("transactionOptionsStatus").textContent =
    "در حال دریافت بانک‌ها و عناوین...";
  try {
    const [banks, records] = await Promise.all([
      getBanks(),
      kind === "income" ? allCustomers() : getExpenseCategories(),
    ]);
    if (version !== optionsVersion) return;
    sources = records.filter((item) => item.active !== false);
    const activeBanks = banks.filter((item) => item.active);
    setOptions($("transactionBank"), activeBanks, "انتخاب بانک", (item) => {
      const owner = [item.first_name, item.last_name].filter(Boolean).join(" ");
      const identifier = item.card_number
        ? `کارت …${item.card_number.slice(-4)}`
        : item.account_number;
      return [item.name, owner, identifier].filter(Boolean).join(" · ");
    });
    setOptions(
      $("transactionSource"),
      sources,
      kind === "income" ? "انتخاب مشتری" : "انتخاب عنوان هزینه",
      (item) =>
        kind === "income"
          ? `${item.first_name} ${item.last_name} · ${item.customer_code}`
          : item.title,
    );
    if (!activeBanks.length || !sources.length) {
      $("transactionOptionsStatus").textContent = !activeBanks.length
        ? "ابتدا یک حساب فعال در بخش بانک ثبت کنید."
        : kind === "income"
          ? "ابتدا مشتری را در بخش مشتریان ثبت کنید."
          : "ابتدا عنوان هزینه را در تنظیمات تعریف کنید.";
      $("retryTransactionOptions").classList.remove("hidden");
    } else {
      optionsReady = true;
      $("transactionOptionsStatus").textContent = "";
    }
  } catch (error) {
    if (version !== optionsVersion) return;
    $("transactionOptionsStatus").textContent = "";
    $("transactionFormError").textContent = error.message;
    $("transactionFormError").classList.remove("hidden");
    $("retryTransactionOptions").classList.remove("hidden");
  } finally {
    if (version === optionsVersion) setFormBusy();
  }
}

function syncTimeMode() {
  const manual = $("transactionTimeMode").value === "manual";
  $("manualTimeFields").classList.toggle("hidden", !manual);
  $("manualTimeFields").classList.toggle("flex", manual);
  $("autoTimeHint").classList.toggle("hidden", manual);
  ["transactionHour", "transactionMinute"].forEach((id) => {
    $(id).required = manual;
    $(id).disabled = !manual;
    if (!manual) $(id).value = "";
  });
}

async function openTransaction(nextKind) {
  kind = nextKind;
  $("transactionForm").reset();
  $("transactionDate").value = formatJalaliInput(selectedDay);
  $("transactionAccountCode").value = "";
  $("transactionModalTitle").textContent =
    kind === "income" ? "ثبت درآمد" : "ثبت هزینه";
  $("submitTransaction").classList.toggle("bg-eucalyptus", kind === "income");
  $("submitTransaction").classList.toggle(
    "bg-alizarin-crimson",
    kind === "expense",
  );
  $("trackingField").classList.toggle("hidden", kind !== "income");
  requestId = requestFingerprint = null;
  syncTimeMode();
  $("transactionModal").inert = false;
  dialog.open();
  await loadOptions();
  if (
    optionsReady &&
    $("transactionModal").getAttribute("aria-hidden") === "false"
  )
    $("transactionSource").focus();
}

async function submitTransaction(event) {
  event.preventDefault();
  if (saving || !optionsReady) return;
  $("transactionFormError").classList.add("hidden");
  let result;
  try {
    const manual = $("transactionTimeMode").value === "manual";
    const payload = {
      kind,
      bank_id: Number($("transactionBank").value),
      amount: amountValue($("transactionAmount").value),
      [kind === "income" ? "customer_id" : "expense_category_id"]: Number(
        $("transactionSource").value,
      ),
      description: $("transactionDescription").value.trim() || null,
      transaction_date: normalizeJalaliDate($("transactionDate").value),
      time_mode: manual ? "manual" : "auto",
    };
    if (kind === "income") {
      const tracking = normalizeDigits($("transactionTracking").value.trim());
      if (tracking && !/^\d+$/.test(tracking))
        throw new Error("شماره پیگیری باید فقط شامل رقم باشد.");
      payload.tracking_number = tracking || null;
    }
    if (manual) {
      const hour = normalizeDigits($("transactionHour").value.trim()),
        minute = normalizeDigits($("transactionMinute").value.trim());
      if (
        !/^\d{1,2}$/.test(hour) ||
        !/^\d{1,2}$/.test(minute) ||
        Number(hour) > 23 ||
        Number(minute) > 59
      )
        throw new Error("ساعت باید بین ۰ تا ۲۳ و دقیقه بین ۰ تا ۵۹ باشد.");
      payload.hour = Number(hour);
      payload.minute = Number(minute);
    }
    const fingerprint = JSON.stringify(payload);
    if (fingerprint !== requestFingerprint) {
      requestId = crypto.randomUUID();
      requestFingerprint = fingerprint;
    }
    saving = true;
    setFormBusy();
    result = await createTransaction({ ...payload, request_id: requestId });
  } catch (error) {
    $("transactionFormError").textContent = error.message;
    $("transactionFormError").classList.remove("hidden");
  } finally {
    saving = false;
    setFormBusy();
  }
  if (!result) return;
  dialog.close();
  $("financeNotice").textContent =
    `${kind === "income" ? "درآمد" : "هزینه"} با موفقیت ثبت شد.`;
  $("financeNotice").classList.remove("hidden");
  calendarCenter = result.transaction_date;
  await Promise.all([
    selectDay(result.transaction_date),
    loadCalendar({ scroll: true }),
  ]);
}

async function initialize() {
  if (!(await protectPage())) return;
  $("logoutButton").addEventListener("click", () => {
    logout();
    window.location.replace("/page/login-page.html");
  });
  $("recordIncome").addEventListener("click", () => openTransaction("income"));
  $("recordExpense").addEventListener("click", () =>
    openTransaction("expense"),
  );
  $("transactionSource").addEventListener("change", () => {
    const source = sources.find(
      (item) => item.id === Number($("transactionSource").value),
    );
    $("transactionAccountCode").value = source
      ? String(kind === "income" ? source.customer_code : source.account_code)
      : "";
  });
  $("transactionTimeMode").addEventListener("change", syncTimeMode);
  $("transactionForm").addEventListener("submit", submitTransaction);
  $("retryTransactionOptions").addEventListener("click", loadOptions);
  bindAmount($("transactionAmount"));
  $("retryFinance").addEventListener("click", () =>
    Promise.all([selectDay(selectedDay), loadCalendar()]),
  );
  $("selectToday").addEventListener("click", () => {
    calendarCenter = todayKey();
    selectDay(calendarCenter);
    loadCalendar({ scroll: true });
  });
  $("previousDays").addEventListener("click", () => {
    calendarCenter = shiftDay(calendarCenter, -14);
    loadCalendar();
  });
  $("nextDays").addEventListener("click", () => {
    calendarCenter = shiftDay(calendarCenter, 14);
    loadCalendar();
  });
  let lastToday = todayKey();
  function tick() {
    const today = todayKey();
    $("financeToday").textContent = fullDate(today);
    $("financeClock").textContent = new Intl.DateTimeFormat("fa-IR", {
      timeZone: "Asia/Tehran",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(new Date());
    if (today !== lastToday) {
      if (selectedDay === lastToday) {
        calendarCenter = today;
        selectDay(today);
        loadCalendar({ scroll: true });
      }
      lastToday = today;
    }
  }
  tick();
  let clock = setInterval(tick, 1000);
  window.addEventListener("pagehide", () => {
    clearInterval(clock);
    dayController?.abort();
    optionsVersion++;
    calendarVersion++;
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    clearInterval(clock);
    clock = setInterval(tick, 1000);
    tick();
    selectDay(selectedDay);
    loadCalendar();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      tick();
      selectDay(selectedDay);
      loadCalendar();
    }
  });
  onExternalDataChange(() => {
    selectDay(selectedDay);
    loadCalendar();
  });
  await Promise.all([selectDay(selectedDay), loadCalendar({ scroll: true })]);
}

initialize();
