import { request, downloadBlob } from "./report-api.js";

export const number = new Intl.NumberFormat("fa-IR");
export const date = new Intl.DateTimeFormat("fa-IR", {
  timeZone: "Asia/Tehran",
  dateStyle: "medium",
  timeStyle: "short",
});
export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function fileSize(bytes) {
  return bytes < 1024 * 1024
    ? `${number.format(Math.ceil(bytes / 1024))} کیلوبایت`
    : `${number.format(Math.round((bytes / 1024 / 1024) * 10) / 10)} مگابایت`;
}

export function downloadButton(report, error) {
  const download = element(
    "button",
    "دریافت فایل",
    "reports-history-button report-download",
  );
  download.type = "button";
  download.setAttribute(
    "aria-label",
    `دریافت ${report.name} (${report.format === "pdf" ? "PDF" : "Excel"})`,
  );
  download.onclick = async () => {
    download.disabled = true;
    download.textContent = "در حال دریافت…";
    error.hidden = true;
    try {
      const blob = await request(
        `/history/${report.id}/download`,
        undefined,
        undefined,
        true,
      );
      downloadBlob(
        blob,
        `karbon-${report.dataset}-${report.id}.${report.format}`,
      );
    } catch (err) {
      error.textContent =
        err.message || "دریافت فایل انجام نشد. دوباره تلاش کنید.";
      error.hidden = false;
    } finally {
      download.disabled = false;
      download.textContent = "دریافت فایل";
    }
  };
  return download;
}
