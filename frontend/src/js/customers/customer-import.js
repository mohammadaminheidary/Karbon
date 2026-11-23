import { Dialog } from "../components/dialog.js";
import {
  getCustomerImportTemplate,
  inspectCustomerWorkbook,
  processCustomerWorkbook,
} from "./customer-api.js";
import { formatDate, formatNumber } from "./customer-utils.js";

const statuses = {
  valid: "آماده ثبت",
  duplicate: "تکراری",
  invalid: "نامعتبر",
};
const genders = { male: "مرد", female: "زن" };

function element(tag, label = "", classes = "") {
  const node = document.createElement(tag);
  node.textContent = label;
  node.className = classes;
  return node;
}

export function initializeCustomerImport(panel) {
  if (panel.dataset.importReady) return;
  const trigger = panel.querySelector("#openCustomerImport");
  const modal = document.getElementById("customerImportModal");
  const get = (name) => modal.querySelector(`#customerImport${name}`);
  const controls = get("Controls");
  const fileInput = get("File");
  const options = get("Options");
  const sheet = get("Sheet");
  const mapping = get("Mapping");
  const previewButton = get("Preview");
  const commitButton = get("Commit");
  const templateButton = get("Template");
  const status = get("Status");
  const error = get("Error");
  const output = get("Output");
  const closeButton = modal.querySelector("[data-dialog-close]");

  let workbook;
  let metadata;
  let preview;
  let busy = false;
  const dialog = new Dialog(modal.id, { canClose: () => !busy });
  modal.addEventListener("cancel", (event) => {
    event.preventDefault();
    dialog.cancel();
  });

  async function run(message, action) {
    if (busy) return;
    busy = controls.disabled = templateButton.disabled = closeButton.disabled = true;
    status.textContent = message;
    error.textContent = "";
    try {
      await action();
    } catch (failure) {
      error.textContent = failure.message || "پردازش فایل انجام نشد. دوباره تلاش کنید.";
    } finally {
      busy = controls.disabled = templateButton.disabled = closeButton.disabled = false;
      status.textContent = "";
      commitButton.disabled = !preview?.valid;
    }
  }

  function clearOutput() {
    preview = null;
    commitButton.disabled = true;
    error.textContent = "";
    output.replaceChildren();
  }

  function showColumns() {
    clearOutput();
    const columns = metadata.sheets[Number(sheet.value)].columns;
    mapping.replaceChildren(...columns.map((column, index) => {
      const group = element("div", "", "min-w-0");
      const select = element("select", "", "finance-field w-full");
      select.id = `customerImportColumn${index}`;
      const label = element("label", column.title ? `${column.title} (${column.letter})` : `ستون ${column.letter}`, "wrap-break-word");
      label.htmlFor = select.id;
      select.add(new Option("نادیده گرفتن ستون", ""));
      for (const field of metadata.fields) {
        select.add(new Option(field.label + (field.required ? " (الزامی)" : ""), field.key));
      }
      select.value = column.field || "";
      group.append(label, select);
      return group;
    }));
    previewButton.disabled = !columns.length;
    if (!columns.length) error.textContent = "شیت انتخاب‌شده ستونی برای تطبیق ندارد.";
  }

  function fieldLabel(key) {
    if (key === "full_name") return "نام و نام خانوادگی";
    return metadata.fields.find((field) => field.key === key)?.label ?? key;
  }

  function issueList(issues) {
    const list = element("ul", "", "space-y-1 text-sm");
    for (const { field, message } of issues) {
      const item = element("li");
      item.append(element("strong", fieldLabel(field)), document.createTextNode(` — ${message}`));
      list.append(item);
    }
    return list;
  }

  function showPreview(result) {
    const count = (value) => formatNumber(value);
    output.append(
      element("h3", "پیش‌نمایش ورود", "mb-2 font-bold"),
      element("p", `${count(result.valid)} آماده ثبت، ${count(result.duplicate)} تکراری، ${count(result.invalid)} نامعتبر`, "mb-3 text-sm"),
    );
    if (!result.preview.length) {
      output.append(element("p", "ردیف داده‌ای در این شیت پیدا نشد."));
      return;
    }
    output.append(element("p", `نمایش ${count(result.preview.length)} ردیف اولِ دارای داده`, "mb-2 text-sm"));
    const scroller = element("div", "", "overflow-x-auto rounded-lg border border-french-gray/40");
    const table = element("table", "", "w-full text-right text-sm");
    const head = table.createTHead().insertRow();
    for (const title of ["ردیف اکسل", "اطلاعات مشتری", "وضعیت"]) {
      const header = element("th", title, "px-3 py-2");
      header.scope = "col";
      head.append(header);
    }
    const rows = table.createTBody();
    for (const item of result.preview) {
      const row = rows.insertRow();
      row.className = "border-t border-french-gray/30 align-top";
      for (let index = 0; index < 3; index++) row.insertCell().className = "px-3 py-2";
      row.cells[0].textContent = count(item.row);
      if (item.values) {
        const details = element("dl", "", "min-w-32 space-y-1 wrap-anywhere");
        for (const { key, label } of metadata.fields) {
          const value = item.values[key];
          if (!value || (Array.isArray(value) && !value.length)) continue;
          const description = Array.isArray(value)
            ? value.join("، ")
            : key === "last_contact_date"
              ? formatDate(value)
              : genders[value] && key === "gender" ? genders[value] : value;
          const displayed = description.length > 100 ? `${description.slice(0, 100)}…` : description;
          const entry = element("div");
          entry.append(element("dt", label, "me-2 inline font-bold"), element("dd", displayed, "inline"));
          details.append(entry);
        }
        row.cells[1].append(details);
      }
      row.cells[2].append(element("strong", statuses[item.status]));
      if (item.issues.length) row.cells[2].append(issueList(item.issues));
    }
    scroller.append(table);
    output.append(scroller);
  }

  function showReport(result) {
    output.replaceChildren(
      element("h3", "گزارش ورود مشتریان", "mb-2 font-bold"),
      element("p", `${formatNumber(result.inserted)} ثبت‌شده، ${formatNumber(result.duplicate)} تکراری، ${formatNumber(result.invalid)} نامعتبر`, "mb-3 text-sm"),
    );
    if (!result.report.length) return;
    const list = element("ol", "", "space-y-2");
    const more = element("button", "نمایش ردیف‌های بیشتر", "finance-button mt-3 border border-french-gray/40");
    more.type = "button";
    function appendRows() {
      const next = list.childElementCount;
      for (const item of result.report.slice(next, next + 50)) {
        const row = element("li", "", "rounded-lg border border-french-gray/40 px-3 py-2");
        row.append(element("strong", `ردیف ${formatNumber(item.row)} — ${statuses[item.status]}`), issueList(item.issues));
        list.append(row);
      }
      more.hidden = list.childElementCount >= result.report.length;
    }
    more.addEventListener("click", appendRows);
    appendRows();
    output.append(list, more);
  }

  fileInput.addEventListener("change", () => {
    clearOutput();
    options.hidden = true;
    workbook = fileInput.files[0];
    metadata = null;
    if (!workbook) return;
    if (!/\.xlsx$/i.test(workbook.name)) {
      error.textContent = "فایل با پسوند ‎.xlsx‎ انتخاب کنید.";
      fileInput.value = "";
      return;
    }
    void run("در حال خواندن شیت‌های اکسل…", async () => {
      try {
        metadata = await inspectCustomerWorkbook(workbook);
      } catch (failure) {
        fileInput.value = "";
        throw failure;
      }
      sheet.replaceChildren(...metadata.sheets.map(({ name, index }) => new Option(name, index)));
      get("SheetChoice").hidden = metadata.sheets.length === 1;
      options.hidden = false;
      showColumns();
    });
  });

  sheet.addEventListener("change", showColumns);
  mapping.addEventListener("change", clearOutput);
  const columns = () => Array.from(mapping.querySelectorAll("select"), (select) => select.value);
  previewButton.addEventListener("click", () => {
    clearOutput();
    void run("در حال اعتبارسنجی ردیف‌ها…", async () => {
      preview = await processCustomerWorkbook("preview", workbook, sheet.value, columns());
      showPreview(preview);
    });
  });
  commitButton.addEventListener("click", () => {
    if (!preview?.valid) return;
    void run("در حال ثبت مشتریان…", async () => {
      const result = await processCustomerWorkbook("commit", workbook, sheet.value, columns());
      preview = null;
      showReport(result);
    });
  });
  templateButton.addEventListener("click", () => {
    void run("در حال آماده‌سازی فایل نمونه…", async () => {
      const url = URL.createObjectURL(await getCustomerImportTemplate());
      const link = element("a");
      link.href = url;
      link.download = "customers-template.xlsx";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  });
  trigger.addEventListener("click", () => dialog.open(fileInput));
  trigger.disabled = false;
  panel.dataset.importReady = "true";
}
