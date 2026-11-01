import { request } from "./report-api.js";
import {
  number,
  date,
  element,
  fileSize,
  downloadButton,
} from "./report-ui.js";
import { CurtainDialog } from "../components/curtain-dialog.js";

export async function initializeReportDetails() {
  const $ = (id) => document.getElementById(id);
  const id = new URLSearchParams(location.search).get("id");
  const error = $("reportDetailsError");
  let report,
    pending = false;
  const dialog = new CurtainDialog("reportDeleteDialog", {
    canClose: () => !pending,
  });

  async function load() {
    error.hidden = $("reportDetailsRetry").hidden = true;
    $("reportDetailsStatus").textContent = "در حال دریافت گزارش…";
    try {
      if (!/^[1-9]\d*$/.test(id || ""))
        throw new Error("شناسه گزارش معتبر نیست.");
      report = await request(`/history/${id}`);
      $("reportDetailsTitle").textContent = report.name;
      const fields = [
        ["شناسه گزارش", number.format(report.id)],
        ["ماژول", report.dataset_title],
        ["تاریخ ایجاد", date.format(new Date(report.created_at))],
        ["فرمت", report.format === "pdf" ? "PDF" : "Excel"],
        ["تعداد رکوردها", number.format(report.record_count)],
        ["تعداد ستون‌ها", number.format(report.column_count)],
        ["حجم فایل", fileSize(report.size_bytes)],
      ];
      $("reportDetailsMetadata").replaceChildren(
        ...fields.map(([label, value]) => {
          const field = element("div");
          field.append(element("dt", label), element("dd", value));
          return field;
        }),
      );
      $("reportDetails").querySelector(".report-download")?.remove();
      $("reportDetails")
        .querySelector("footer")
        .prepend(downloadButton(report, error));
      $("reportDetails").hidden = false;
      $("reportDetailsStatus").textContent = "";
    } catch (err) {
      $("reportDetails").hidden = true;
      $("reportDetailsStatus").textContent = "";
      error.textContent = err.message || "دریافت گزارش انجام نشد.";
      error.hidden = $("reportDetailsRetry").hidden = false;
    }
  }
  $("reportDetailsRetry").onclick = () => void load();
  $("deleteReport").onclick = () => {
    $("reportDeleteDescription").textContent =
      `گزارش «${report.name}» و فایل ذخیره‌شدهٔ آن حذف می‌شود. آیا مطمئن هستید؟`;
    $("reportDeleteError").hidden = true;
    dialog.open($("cancelDeleteReport"));
  };
  $("confirmDeleteReport").onclick = async () => {
    if (pending) return;
    pending = true;
    $("reportDeleteError").hidden = true;
    $("reportDeleteDialog").setAttribute("aria-busy", "true");
    $("confirmDeleteReport").disabled = $("cancelDeleteReport").disabled = true;
    $("confirmDeleteReport").textContent = "در حال حذف…";
    try {
      await request(`/history/${id}`, undefined, undefined, false, "DELETE");
      window.location.replace("/page/reports-page.html");
    } catch (err) {
      $("reportDeleteError").textContent =
        err.message || "حذف گزارش انجام نشد. دوباره تلاش کنید.";
      $("reportDeleteError").hidden = false;
      pending = false;
      $("reportDeleteDialog").setAttribute("aria-busy", "false");
      $("confirmDeleteReport").disabled = $("cancelDeleteReport").disabled =
        false;
      $("confirmDeleteReport").textContent = "بله، حذف شود";
    }
  };
  await load();
}
