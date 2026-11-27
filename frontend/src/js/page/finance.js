import { mountDateInput } from "../components/date-input.js";
import { startPage } from "../components/page-ready.js";
import { transactionActions } from "../finance/transaction-actions.js";
import { onPageRefresh } from "../components/data-events.js";
import { notify } from "../components/notifications.js";
import { bankLogo } from "../finance/bank-accounts.js";
import { DailyFinanceChart } from "../finance/daily-finance-chart.js";
import { CurtainDialog } from "../components/curtain-dialog.js";
import { protectPage } from "../guards/auth-guard.js";
import { CustomerSelect } from "../customers/customer-select.js";
import { getCustomerPayments } from "../customers/customer-api.js";
import { fullName } from "../customers/customer-utils.js";
import { paymentMethodCard, paymentMethodLabels, paymentMethods } from "../finance/payment-methods.js";
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
import { fiscalLabel, getFiscalDate } from "../fiscal-years/fiscal-api.js";

const $ = (id) => document.getElementById(id);
const chart = new DailyFinanceChart($("financeChart"));
const transactionDate = mountDateInput($("transactionDate"));
let fiscalPeriod;
const periodDay = (day) => !fiscalPeriod?.managed ? day
  : day < fiscalPeriod.start_date ? fiscalPeriod.start_date
  : day > fiscalPeriod.end_date ? fiscalPeriod.end_date : day;
const activeToday = () => periodDay(todayKey(fiscalPeriod?.timezone));
let selectedDay = todayKey(),
  calendarCenter = selectedDay;
let dayController,
  renderedDay,
  renderedDayData,
  calendarVersion = 0,
  optionsVersion = 0;
let kind = "income",
  sources = [],
  saving = false,
  optionsReady = false;
let customerPicker;
let customerSummaryController, displayedCustomerId;
let requestId, requestFingerprint;
const dialog = new CurtainDialog("transactionModal", {
  canClose: () => !saving,
  onCancel: () => {
    optionsVersion++;
    customerPicker?.cancel();
    showCustomerDetails();
  },
});

function showError(error) {
  notify(error.message, { type: "error" });
  $("financeError").classList.remove("hidden");
}

function clearDay() {
  ["totalIncome", "totalExpense", "totalBalance", "transactionCount"].forEach(
    (id) => ($(id).textContent = "—"),
  );
  chart.clear();
  $("financeChartEmpty").classList.add("hidden");
  $("transactionRows").replaceChildren();
  $("transactionsTable").classList.add("hidden");
  $("transactionsStatus").classList.remove("hidden");
  $("transactionsStatus").textContent = "در حال دریافت اطلاعات...";
}

async function selectDay(day) {
  day = periodDay(day);
  selectedDay = day;
  $("selectedDateLabel").textContent = fullDate(day);
  dayController?.abort();
  const controller = new AbortController();
  dayController = controller;
  $("financeDayContent").setAttribute("aria-busy", "true");
  $("financeSummary").setAttribute("aria-busy", "true");
  $("financeError").classList.add("hidden");
  if (renderedDay !== day) {
    renderedDayData = undefined;
    clearDay();
  }
  updateCalendarSelection();
  try {
    const data = await getFinanceDay(day, controller.signal);
    if (controller.signal.aborted || selectedDay !== day) return;
    const signature = JSON.stringify(data);
    if (renderedDayData === signature) return;
    renderedDay = day;
    renderedDayData = signature;
    $("totalIncome").textContent = money(data.summary.income);
    $("totalExpense").textContent = money(data.summary.expense);
    $("totalBalance").textContent = money(data.summary.balance);
    chart.update(data);
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
    const start = periodDay(shiftDay(center, -7));
    const end = periodDay(shiftDay(center, 6));
    $("previousDays").disabled = Boolean(fiscalPeriod?.managed && start === fiscalPeriod.start_date);
    $("nextDays").disabled = Boolean(fiscalPeriod?.managed && end === fiscalPeriod.end_date);
    const days = await getFinanceCalendar(
      start,
      end,
    );
    if (version !== calendarVersion) return;
    $("financeCalendar").replaceChildren(
      ...days.map((day) => {
        const button = node(
          "button",
          "card-tilt w-[170px] shrink-0 rounded-2xl border p-3 text-right transition-[color,background-color,border-color,transform] hover:border-french-gray/70",
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
            weekday + (day.date === todayKey(fiscalPeriod?.timezone) ? " · امروز" : ""),
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
              `mt-2 text-[0.6875rem] font-bold ${color}`,
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
        node(
          "p",
          "mt-1 text-xs text-mirage/45",
          item.bank.is_cash ? (item.kind === "expense" ? "پرداخت نقدی" : "دریافت نقدی") : item.bank.account_number,
        ),
      );
      const paymentMethod = paymentMethodLabels[item.payment_method];
      if (paymentMethod) bank.append(node("p", "mt-1 text-xs text-mirage/65", paymentMethod));
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
        transactionActions(
          item,
          async () => {
            await Promise.all([selectDay(selectedDay), loadCalendar()]);
          },
          { iconOnly: true },
        ),
      );
      return row;
    }),
  );
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

async function showCustomerDetails(customer) {
  if (customer?.id === displayedCustomerId) return;
  displayedCustomerId = customer?.id;
  customerSummaryController?.abort();
  $("transactionCustomer").hidden = !customer;
  if (!customer) return;

  $("transactionCustomerName").textContent = fullName(customer);
  $("transactionCustomerPhone").textContent = customer.phone_numbers?.join("، ") || "ثبت نشده";
  $("transactionCustomerAddress").textContent = customer.address || "ثبت نشده";
  const invoiced = $("transactionCustomerInvoiced");
  const debt = $("transactionCustomerDebt");
  const status = $("transactionCustomerStatus");
  invoiced.textContent = debt.textContent = "—";
  status.hidden = false;
  status.textContent = "در حال دریافت خلاصه مالی…";
  const controller = new AbortController();
  customerSummaryController = controller;
  try {
    const { summary } = await getCustomerPayments(customer.id, { signal: controller.signal });
    if (controller.signal.aborted) return;
    invoiced.textContent = money(BigInt(summary.invoiced));
    debt.textContent = money(BigInt(summary.outstanding));
    status.hidden = true;
  } catch (error) {
    if (!controller.signal.aborted) status.textContent = error.message;
  }
}

function selectedPaymentMethod() {
  return $("transactionPaymentMethods").querySelector("input:checked")?.value;
}

function syncPaymentMethod() {
  const income = kind === "income";
  const cash = income && selectedPaymentMethod() === "cash";
  $("transactionPayment").hidden = $("transactionPayment").disabled = !income;
  $("transactionCashAccount").hidden = !cash;
  $("transactionBankField").hidden = $("transactionBank").disabled = cash;
}

async function loadOptions() {
  customerPicker ||= new CustomerSelect($("transactionSource"), {
    includeAddress: true,
    rows: (rows, selected) => {
      sources = rows;
      setOptions($("transactionSource"), rows, "انتخاب مشتری", row => `${row.first_name} ${row.last_name} · ${row.customer_code}`);
      $("transactionSource").value = selected ? String(selected) : "";
      $("transactionSource").dispatchEvent(new Event("change"));
    },
    busy: busy => { $("submitTransaction").disabled = saving || !optionsReady || busy; },
  });
  customerPicker.setActive(kind === "income");
  const version = ++optionsVersion;
  optionsReady = false;
  setFormBusy();
  showCustomerDetails();
  $("transactionFormError").classList.add("hidden");
  $("retryTransactionOptions").classList.add("hidden");
  $("transactionOptionsStatus").textContent =
    "در حال دریافت بانک‌ها و عناوین...";
  try {
    const [banks, records] = await Promise.all([
      getBanks(),
      kind === "income" ? customerPicker.reset() : getExpenseCategories(),
    ]);
    if (version !== optionsVersion) return;
    sources = records.filter((item) => item.active !== false);
    const activeBanks = banks.filter((item) => item.active && (kind === "expense" || !item.is_cash));
    setOptions($("transactionBank"), activeBanks, activeBanks.length ? "انتخاب بانک" : "حساب بانکی فعال وجود ندارد", (item) => {
      const owner = [item.first_name, item.last_name].filter(Boolean).join(" ");
      const identifier = item.is_cash
        ? "نقدی"
        : item.card_number
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
    if (kind === "income" && !activeBanks.length) $("income-pay-cash").checked = true;
    syncPaymentMethod();
    const missingExpenseBank = kind === "expense" && !activeBanks.length;
    if (missingExpenseBank || !sources.length) {
      $("transactionOptionsStatus").textContent = missingExpenseBank
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
  syncPaymentMethod();
  transactionDate.value = formatJalaliInput(selectedDay);
  $("transactionAccountCode").value = "";
  $("transactionSourceLabel").textContent = kind === "income" ? "مشتری" : "عنوان هزینه";
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
  if (saving || !optionsReady || customerPicker?.busy) return;
  $("transactionFormError").classList.add("hidden");
  let result;
  try {
    const manual = $("transactionTimeMode").value === "manual";
    const paymentMethod = kind === "income" ? selectedPaymentMethod() : null;
    const payload = {
      kind,
      bank_id: paymentMethod === "cash" ? null : Number($("transactionBank").value),
      amount: amountValue($("transactionAmount").value),
      [kind === "income" ? "customer_id" : "expense_category_id"]: Number(
        $("transactionSource").value,
      ),
      description: $("transactionDescription").value.trim() || null,
      transaction_date: normalizeJalaliDate(transactionDate.value),
      time_mode: manual ? "manual" : "auto",
    };
    if (kind === "income") {
      const tracking = normalizeDigits($("transactionTracking").value.trim());
      if (tracking && !/^\d+$/.test(tracking))
        throw new Error("شماره پیگیری باید فقط شامل رقم باشد.");
      payload.tracking_number = tracking || null;
      payload.payment_method = paymentMethod;
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
  showCustomerDetails();
  dialog.close();
  notify(`${kind === "income" ? "درآمد" : "هزینه"} با موفقیت ثبت شد.`, {
    type: "success",
  });
  calendarCenter = result.transaction_date;
  await Promise.all([
    selectDay(result.transaction_date),
    loadCalendar({ scroll: true }),
  ]);
}

async function initialize() {
  if (!(await protectPage())) return;
  async function refreshFiscalPeriod() {
    try {
      const previous = fiscalPeriod;
      fiscalPeriod = await getFiscalDate();
      if (!previous || previous.year !== fiscalPeriod.year)
        calendarCenter = selectedDay = fiscalPeriod.business_date;
      if (fiscalPeriod.managed) {
        const accounts = await getBanks();
        const opening = accounts.reduce((balance, bank) => balance + BigInt(bank.opening_balance), 0n);
        $("financeFiscalOpening").textContent =
          `سال مالی ${fiscalLabel(fiscalPeriod.year)} · جمع مانده افتتاحیه حساب‌ها ${money(opening)}`;
        $("financeFiscalOpening").hidden = false;
      } else {
        $("financeFiscalOpening").hidden = true;
      }
    } catch (error) {
      showError(error);
    }
  }
  await refreshFiscalPeriod();
  $("recordIncome").addEventListener("click", () => openTransaction("income"));
  $("recordExpense").addEventListener("click", () =>
    openTransaction("expense"),
  );
  $("recordIncome").disabled = false;
  $("recordExpense").disabled = false;
  $("transactionPaymentMethods").replaceChildren(...paymentMethods.map(([key, label, icon]) =>
    paymentMethodCard(`income-pay-${key}`, label, icon, {
      group: "income-payment-method", value: key, checked: key === "pos",
    }),
  ));
  $("transactionPaymentMethods").addEventListener("change", syncPaymentMethod);
  $("transactionSource").addEventListener("change", () => {
    const source = sources.find(
      (item) => item.id === Number($("transactionSource").value),
    );
    $("transactionAccountCode").value = source
      ? String(kind === "income" ? source.customer_code : source.account_code)
      : "";
    showCustomerDetails(kind === "income" ? source : undefined);
  });
  $("transactionTimeMode").addEventListener("change", syncTimeMode);
  $("transactionForm").addEventListener("submit", submitTransaction);
  $("retryTransactionOptions").addEventListener("click", loadOptions);
  bindAmount($("transactionAmount"));
  $("retryFinance").addEventListener("click", () =>
    Promise.all([selectDay(selectedDay), loadCalendar()]),
  );
  $("selectToday").addEventListener("click", () => {
    calendarCenter = activeToday();
    selectDay(calendarCenter);
    loadCalendar({ scroll: true });
  });
  $("previousDays").addEventListener("click", () => {
    calendarCenter = periodDay(shiftDay(calendarCenter, -14));
    loadCalendar();
  });
  $("nextDays").addEventListener("click", () => {
    calendarCenter = periodDay(shiftDay(calendarCenter, 14));
    loadCalendar();
  });
  let lastToday = activeToday();
  function tick() {
    const today = activeToday();
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
    customerPicker?.cancel();
    showCustomerDetails();
    calendarVersion++;
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    clearInterval(clock);
    clock = setInterval(tick, 1000);
    tick();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      tick();
    }
  });
  onPageRefresh(async () => {
    await refreshFiscalPeriod();
    await Promise.all([selectDay(selectedDay), loadCalendar()]);
  });
  await Promise.all([selectDay(selectedDay), loadCalendar({ scroll: true })]);
}

startPage(initialize);
  $("financePurchaseObligations").addEventListener("click", async () => {
    const { showPurchaseObligations } = await import("../warehouse/purchase-details.js");
    await showPurchaseObligations();
  });
