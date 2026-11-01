import { NavbarPanelDialog } from "../components/navbar-panel-dialog.js";
import { getToken, logout } from "../auth/auth-storage.js";
import { normalizeJalaliDate } from "../customers/customer-utils.js";

const API = "http://127.0.0.1:8000/api/reports";
const defaults = {
  "customers-page.html": "customers",
  "orders-page.html": "orders",
  "finance-page.html": "financial_transactions",
  "warehouse-page.html": "products",
  "documents-page.html": "documents",
  "attendance-page.html": "attendance",
  "daily-tasks-page.html": "tasks",
  "banks-page.html": "bank_accounts",
  "bank-transactions-page.html": "financial_transactions",
};
const number = new Intl.NumberFormat("fa-IR");
const textValue = (v) =>
  v === null
    ? "NULL"
    : v === ""
      ? '""'
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
function node(tag, text, attrs = {}) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}
async function request(path, body, signal, binary = false) {
  const token = getToken();
  if (!token) throw new Error("برای دریافت گزارش وارد حساب شوید.");
  const response = await fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    signal,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    logout();
    window.location.replace("/page/login-page.html");
    throw new Error("نشست شما پایان یافته است.");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "دریافت گزارش انجام نشد؛ فیلترها را بررسی و دوباره تلاش کنید.",
    );
  }
  return binary ? response.blob() : response.json();
}

let instance;
export async function openReports() {
  instance ||= createReports();
  await instance.open();
}
function createReports() {
  const root = node("dialog", undefined, {
    id: "reportsDialog",
    class: "bottom-curtain reports-panel",
    dir: "rtl",
    "aria-hidden": "true",
  });
  root.innerHTML = `<form class="navbar-panel-content reports-content" aria-labelledby="reportsTitle">
    <header><div><h2 id="reportsTitle">گزارش و خروجی</h2><p>گزارش از اطلاعات ثبت‌شده در پایگاه داده</p></div><button type="button" data-dialog-close aria-label="بستن گزارش">×</button></header>
    <div class="reports-controls"><label>ماژول<select id="reportModule"></select></label><label class="reports-search">جست‌وجو<input id="reportSearch" type="search" placeholder="جست‌وجو در اطلاعات ماژول"></label><label id="reportDeletedLabel" class="reports-check" hidden><input type="checkbox" id="reportDeleted">شامل رکوردهای حذف‌شده</label></div>
    <details><summary>فیلترها</summary><div class="reports-controls" id="reportDateFilters"><label>ستون تاریخ<select id="reportDateField"></select></label><label>از تاریخ شمسی<input id="reportFrom" inputmode="numeric" dir="ltr" placeholder="۱۴۰۵/۰۱/۰۱"></label><label>تا تاریخ شمسی<input id="reportTo" inputmode="numeric" dir="ltr" placeholder="۱۴۰۵/۱۲/۲۹"></label></div>
    <div id="reportFilters"></div><div class="reports-controls"><button type="button" id="reportAddFilter">افزودن فیلتر</button><button type="submit" class="reports-primary">اعمال فیلترها</button><button type="button" id="reportReset">پاک کردن فیلترها</button></div></details>
    <details id="reportColumns"><summary>ستون‌های خروجی <span id="reportColumnCount"></span></summary><div class="reports-controls"><button type="button" id="reportAllColumns">انتخاب همه ستون‌ها</button><button type="button" id="reportNoColumns">پاک کردن انتخاب ستون‌ها</button></div><div class="reports-columns" id="reportColumnList"></div></details>
    <div class="reports-controls reports-selection"><label class="reports-check"><input type="checkbox" id="reportSelectAll">انتخاب همه نتایج فیلترشده</label><button type="button" id="reportClearSelection">لغو انتخاب رکوردها</button><span id="reportSelectionCount"></span></div>
    <p id="reportStatus" role="status" aria-live="polite"></p><p id="reportError" role="alert" hidden></p><button type="button" id="reportRetry" hidden>تلاش مجدد</button>
    <div class="reports-table-wrap" tabindex="0" aria-label="رکوردهای گزارش"><table id="reportTable"><thead></thead><tbody></tbody></table></div>
    <div class="reports-controls reports-pagination"><button type="button" id="reportPrevious">صفحه قبل</button><span id="reportPage"></span><button type="button" id="reportNext">صفحه بعد</button></div>
    <footer><label>محدوده خروجی<select id="reportScope"><option value="selected">رکوردهای انتخاب‌شده</option><option value="all">همه نتایج فیلترشده</option></select></label><button type="button" id="reportXlsx" class="reports-primary">خروجی Excel</button><button type="button" id="reportPdf" class="reports-primary">خروجی PDF</button></footer>
    <p class="reports-hint">تاریخ و مقادیر اصلی در خروجی حفظ می‌شوند. NULL یعنی مقدار ثبت نشده. دادهٔ کامل در پیوست JSON فایل PDF و برگهٔ مخفی «داده خام» در Excel موجود است. اقلام و پرداخت‌های سفارش، گزارش‌های مستقل با شناسهٔ ارتباطی دارند.</p>
  </form>`;
  document.body.append(root);
  const $ = (id) => root.querySelector(`#${id}`);
  const form = root.querySelector("form");
  let schema,
    moduleName,
    applied = {},
    offset = 0,
    total = 0,
    busy = false,
    exporting = false;
  let selected = new Set(),
    excluded = new Set(),
    allSelected = false;
  let version = 0,
    controller,
    catalogLoaded = false,
    filterId = 0,
    schemaReady = false;
  const dialog = new NavbarPanelDialog("reportsDialog", {
    canClose: () => !exporting,
    onCancel: () => {
      controller?.abort();
      version++;
    },
  });

  window.addEventListener("resize", () => {
    if (dialog.active && !dialog.closing) dialog.position();
  });

  function error(err) {
    if (err.name === "AbortError") return;
    $("reportError").textContent = err.message || "ارتباط با سرور برقرار نشد.";
    $("reportError").hidden = false;
    $("reportRetry").hidden = false;
    update();
  }
  function clearError() {
    $("reportError").hidden = true;
    $("reportRetry").hidden = true;
  }
  function columns() {
    return [...$("reportColumnList").querySelectorAll("input:checked")].map(
      (c) => c.value,
    );
  }
  function selectionCount() {
    return allSelected ? Math.max(0, total - excluded.size) : selected.size;
  }
  function update() {
    const count = columns().length;
    $("reportColumnCount").textContent = schema
      ? `(${number.format(count)} از ${number.format(schema.columns.length)})`
      : "";
    $("reportSelectionCount").textContent =
      `${number.format(selectionCount())} رکورد انتخاب شده`;
    $("reportSelectAll").checked = allSelected && !excluded.size;
    $("reportSelectAll").indeterminate =
      selectionCount() > 0 && (!allSelected || excluded.size > 0);
    $("reportPrevious").disabled = busy || exporting || offset === 0;
    $("reportNext").disabled = busy || exporting || offset + 50 >= total;
    const disabled =
      busy ||
      exporting ||
      !schemaReady ||
      !$("reportError").hidden ||
      !count ||
      !total ||
      ($("reportScope").value === "selected" && !selectionCount());
    $("reportPdf").disabled = disabled;
    $("reportXlsx").disabled = disabled;
    $("reportSelectAll").disabled = busy || exporting || !total;
    $("reportModule").disabled = exporting;
    form.setAttribute("aria-busy", String(busy || exporting));
    $("reportPage").textContent = total
      ? `${number.format(offset + 1)}–${number.format(Math.min(offset + 50, total))} از ${number.format(total)}`
      : "۰ رکورد";
  }
  function resetSelection() {
    selected.clear();
    excluded.clear();
    allSelected = false;
  }
  function clearTable() {
    $("reportTable").querySelector("thead").replaceChildren();
    $("reportTable").querySelector("tbody").replaceChildren();
  }
  function render(data) {
    const head = node("tr");
    head.append(node("th", "انتخاب", { scope: "col" }));
    const descriptors = new Map(schema.columns.map((c) => [c.name, c]));
    for (const name of data.columns) {
      const c = descriptors.get(name),
        th = node("th", c.label, { scope: "col" });
      th.append(node("small", name, { dir: "ltr" }));
      head.append(th);
    }
    $("reportTable").querySelector("thead").replaceChildren(head);
    const body = document.createDocumentFragment();
    for (const item of data.items) {
      const row = node("tr"),
        td = node("td"),
        checkbox = node("input", undefined, {
          type: "checkbox",
          "aria-label": `انتخاب رکورد ${item.id}`,
        });
      checkbox.checked = allSelected
        ? !excluded.has(item.id)
        : selected.has(item.id);
      checkbox.addEventListener("change", () => {
        if (allSelected)
          checkbox.checked ? excluded.delete(item.id) : excluded.add(item.id);
        else
          checkbox.checked ? selected.add(item.id) : selected.delete(item.id);
        update();
      });
      td.append(checkbox);
      row.append(td);
      for (const name of data.columns) {
        const value = textValue(item.values[name]);
        const cell = node(
          "td",
          value.length > 300 ? value.slice(0, 300) + "…" : value,
          { dir: "auto", title: value },
        );
        if (item.values[name] === null) cell.classList.add("reports-null");
        row.append(cell);
      }
      body.append(row);
    }
    $("reportTable").querySelector("tbody").replaceChildren(body);
  }
  async function load(reset = false) {
    if (!schemaReady || exporting) return;
    if (reset) {
      offset = 0;
      resetSelection();
    }
    controller?.abort();
    controller = new AbortController();
    const current = ++version;
    busy = true;
    clearError();
    update();
    $("reportStatus").textContent = "در حال دریافت رکوردها…";
    const names = columns();
    clearTable();
    try {
      if (!names.length) {
        total = 0;
        $("reportStatus").textContent = "حداقل یک ستون انتخاب کنید.";
        return;
      }
      const data = await request(
        `/${moduleName}/preview`,
        { ...applied, columns: names, offset, limit: 50 },
        controller.signal,
      );
      if (current !== version) return;
      total = data.total;
      if (offset >= total && offset) {
        offset = Math.max(0, Math.floor((total - 1) / 50) * 50);
        return await load();
      }
      render(data);
      $("reportStatus").textContent = total
        ? `${number.format(total)} رکورد یافت شد.`
        : "رکوردی با این فیلترها وجود ندارد.";
    } catch (err) {
      if (current === version) {
        total = 0;
        error(err);
        $("reportStatus").textContent = "دریافت گزارش انجام نشد.";
      }
    } finally {
      if (current === version) {
        busy = false;
        update();
      }
    }
  }
  async function changeModule() {
    controller?.abort();
    controller = new AbortController();
    const current = ++version;
    moduleName = $("reportModule").value;
    schemaReady = false;
    busy = true;
    schema = undefined;
    total = 0;
    applied = {};
    offset = 0;
    resetSelection();
    clearTable();
    clearError();
    $("reportFilters").replaceChildren();
    $("reportColumnList").replaceChildren();
    $("reportSearch").value = "";
    $("reportFrom").value = "";
    $("reportTo").value = "";
    $("reportDeleted").checked = false;
    update();
    $("reportStatus").textContent = "در حال دریافت ستون‌ها…";
    try {
      const data = await request(
        `/${moduleName}/schema`,
        undefined,
        controller.signal,
      );
      if (current !== version) return;
      schema = data;
      for (const c of schema.columns) {
        const label = node("label", undefined, {
          class: "reports-check",
          title: `${c.name} · ${c.database_type}`,
        });
        const input = node("input", undefined, {
          type: "checkbox",
          value: c.name,
        });
        input.checked = !c.related;
        input.addEventListener("change", () => {
          update();
          void load();
        });
        const span = node("span", c.label);
        span.append(node("small", c.name, { dir: "ltr" }));
        label.append(input, span);
        $("reportColumnList").append(label);
      }
      $("reportDeletedLabel").hidden = !schema.supports_deleted;
      const dates = schema.columns.filter(
        (c) => !c.related && ["date", "datetime"].includes(c.type),
      );
      dates.sort(
        (a, b) => (a.type === "date" ? 0 : 1) - (b.type === "date" ? 0 : 1),
      );
      $("reportDateField").replaceChildren(
        ...dates.map((c) => node("option", c.label, { value: c.name })),
      );
      $("reportDateFilters").hidden = !dates.length;
      schemaReady = true;
      busy = false;
      await load(true);
    } catch (err) {
      if (current === version) {
        busy = false;
        error(err);
        update();
      }
    }
  }
  function addFilter() {
    if (!schemaReady) return;
    const row = node("div", undefined, { class: "reports-filter-row" });
    const fields = node("select", undefined, { "aria-label": "ستون فیلتر" });
    const op = node("select", undefined, { "aria-label": "نوع فیلتر" });
    for (const c of schema.columns.filter((c) => c.type !== "json"))
      fields.append(node("option", c.label, { value: c.name }));
    for (const [value, label] of [
      ["eq", "برابر با"],
      ["is_null", "ثبت نشده"],
      ["gte", "از مقدار"],
      ["lte", "تا مقدار"],
    ])
      op.append(node("option", label, { value }));
    const value = node("input", undefined, {
      "aria-label": "مقدار فیلتر",
      placeholder: "مقدار یا نام مرتبط را جست‌وجو کنید",
    });
    const list = node("datalist", undefined, {
      id: `reportFilterOptions${++filterId}`,
    });
    value.setAttribute("list", list.id);
    const remove = node("button", "حذف", {
      type: "button",
      "aria-label": "حذف فیلتر",
    });
    let optionVersion = 0;
    async function choices() {
      const current = ++optionVersion,
        name = moduleName;
      const c = schema.columns.find((c) => c.name === fields.value);
      op.querySelector('[value="gte"]').disabled = op.querySelector(
        '[value="lte"]',
      ).disabled = !["date", "datetime", "time", "integer", "number"].includes(
        c.type,
      );
      value.disabled = op.value === "is_null";
      if (value.disabled) return;
      try {
        const data = await request(
          `/${name}/options?${new URLSearchParams({ field: fields.value, search: value.value })}`,
        );
        if (current === optionVersion && name === moduleName && row.isConnected)
          list.replaceChildren(
            ...data.choices.map((choice) =>
              node("option", undefined, {
                value: String(choice.value),
                label: choice.label,
              }),
            ),
          );
      } catch {
        /* Free input still permits a filter when suggestions are unavailable. */
      }
    }
    fields.addEventListener("change", () => {
      value.value = "";
      op.value = "eq";
      void choices();
    });
    op.addEventListener("change", () => {
      value.disabled = op.value === "is_null";
    });
    let timer;
    value.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(choices, 250);
    });
    remove.onclick = () => {
      clearTimeout(timer);
      row.remove();
    };
    row.append(fields, op, value, list, remove);
    $("reportFilters").append(row);
    row.filter = () => {
      const c = schema.columns.find((c) => c.name === fields.value);
      let v = value.value;
      if (c.type === "boolean" && op.value !== "is_null") {
        if (!["true", "false"].includes(v))
          throw new Error("برای مقدار فعال، true یا false انتخاب کنید.");
        v = v === "true";
      }
      // Keep integer inputs as decimal strings to avoid JS rounding.
      return { field: fields.value, op: op.value, value: v };
    };
    void choices();
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (exporting || !schemaReady) return;
    try {
      const filters = [...$("reportFilters").children].map((row) =>
        row.filter(),
      );
      const field = $("reportDateField").value,
        c = schema.columns.find((c) => c.name === field);
      if (field)
        for (const [id, op] of [
          ["reportFrom", "gte"],
          ["reportTo", "lte"],
        ]) {
          let value = normalizeJalaliDate($(id).value);
          if (!value) continue;
          if (c.type === "datetime")
            value += op === "gte" ? "T00:00:00" : "T23:59:59.999999";
          filters.push({ field, op, value });
        }
      applied = {
        filters,
        search: $("reportSearch").value.trim(),
        include_deleted: $("reportDeleted").checked,
      };
      void load(true);
    } catch (err) {
      error(err);
    }
  });
  $("reportSearch").addEventListener("change", () => form.requestSubmit());
  $("reportDeleted").addEventListener("change", () => form.requestSubmit());
  $("reportAddFilter").onclick = addFilter;
  $("reportReset").onclick = () => {
    $("reportFilters").replaceChildren();
    $("reportFrom").value = $("reportTo").value = $("reportSearch").value = "";
    $("reportDeleted").checked = false;
    applied = {};
    void load(true);
  };
  $("reportModule").onchange = () => void changeModule();
  $("reportPrevious").onclick = () => {
    offset -= 50;
    void load();
  };
  $("reportNext").onclick = () => {
    offset += 50;
    void load();
  };
  $("reportRetry").onclick = () =>
    schemaReady ? void load() : void changeModule();
  $("reportScope").onchange = update;
  $("reportClearSelection").onclick = () => {
    resetSelection();
    root.querySelectorAll("tbody input").forEach((c) => (c.checked = false));
    update();
  };
  $("reportSelectAll").onchange = (event) => {
    resetSelection();
    allSelected = event.target.checked;
    root
      .querySelectorAll("tbody input")
      .forEach((c) => (c.checked = allSelected));
    update();
  };
  for (const [id, checked] of [
    ["reportAllColumns", true],
    ["reportNoColumns", false],
  ])
    $(id).onclick = () => {
      $("reportColumnList")
        .querySelectorAll("input")
        .forEach((c) => (c.checked = checked));
      update();
      void load();
    };
  async function download(fmt) {
    if (busy || exporting) return;
    const body = { ...applied, columns: columns() };
    if ($("reportScope").value === "selected") {
      if (allSelected) body.excluded_ids = [...excluded];
      else body.ids = [...selected];
    }
    exporting = true;
    clearError();
    update();
    $("reportStatus").textContent = "در حال ساخت فایل؛ لطفاً منتظر بمانید…";
    // Freeze the selection and filters until this file has finished.
    const enabled = [...form.querySelectorAll("input, select, button")].filter(
      (e) => !e.disabled,
    );
    enabled.forEach((e) => (e.disabled = true));
    try {
      const blob = await request(
        `/${moduleName}/export/${fmt}`,
        body,
        undefined,
        true,
      );
      const url = URL.createObjectURL(blob),
        a = node("a", undefined, {
          href: url,
          download: `karbon-${moduleName}.${fmt}`,
        });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      $("reportStatus").textContent = "فایل خروجی آماده شد.";
    } catch (err) {
      error(err);
      $("reportStatus").textContent = "ساخت خروجی انجام نشد.";
    } finally {
      exporting = false;
      enabled.forEach((e) => (e.disabled = false));
      update();
    }
  }
  $("reportPdf").onclick = () => void download("pdf");
  $("reportXlsx").onclick = () => void download("xlsx");
  return {
    async open() {
      if (dialog.active) return;
      await dialog.open($("reportModule"));
      if (!catalogLoaded) {
        busy = true;
        update();
        clearError();
        try {
          const list = await request("");
          $("reportModule").replaceChildren(
            ...list.map((m) => node("option", m.title, { value: m.name })),
          );
          const wanted = defaults[location.pathname.split("/").pop()];
          if (list.some((m) => m.name === wanted))
            $("reportModule").value = wanted;
          catalogLoaded = true;
        } catch (err) {
          busy = false;
          error(err);
          update();
          $("reportRetry").onclick = () => {
            void dialog.close().then(() => instance.open());
          };
          return;
        }
      }
      $("reportRetry").onclick = () =>
        schemaReady ? void load() : void changeModule();
      await changeModule();
    },
  };
}
