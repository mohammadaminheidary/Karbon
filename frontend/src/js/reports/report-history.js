import { request } from "./report-api.js";
import {
  number,
  date,
  element,
  fileSize,
  downloadButton,
} from "./report-ui.js";
import { onPageRefresh } from "../components/data-events.js";

export async function initializeReportHistory() {
  const list = document.getElementById("reportHistoryList");
  const status = document.getElementById("reportHistoryStatus");
  const error = document.getElementById("reportHistoryError");
  const refresh = document.getElementById("refreshReports");
  const previous = document.getElementById("reportHistoryPrevious");
  const next = document.getElementById("reportHistoryNext");
  const pagination = document.querySelector(".reports-history-pagination");
  let offset = 0,
    total = 0,
    controller;
  const limit = 50;

  function row(report) {
    const item = element("li", undefined, "report-history-entry");
    const badge = element(
      "span",
      report.format === "pdf" ? "PDF" : "Excel",
      "report-format",
    );
    badge.dir = "ltr";
    const info = element("div", undefined, "report-history-info");
    const link = element("a", undefined, "report-card-link");
    link.href = `/page/report-details-page.html?id=${report.id}`;
    link.append(element("h2", report.name));
    info.append(link);
    const metadata = element("p", undefined, "report-history-metadata");
    const time = element("time", date.format(new Date(report.created_at)));
    time.dateTime = report.created_at;
    metadata.append(
      element("span", `شناسه: ${number.format(report.id)}`),
      element("span", report.dataset_title),
      time,
      element("span", `${number.format(report.record_count)} رکورد`),
      element("span", `${number.format(report.column_count)} ستون`),
      element("span", fileSize(report.size_bytes)),
    );
    info.append(metadata);
    const download = downloadButton(report, error);
    item.append(badge, info, download);
    return item;
  }

  async function load() {
    controller?.abort();
    const current = (controller = new AbortController());
    list.setAttribute("aria-busy", "true");
    refresh.disabled = previous.disabled = next.disabled = true;
    error.hidden = true;
    status.textContent = "در حال دریافت گزارش‌ها…";
    try {
      const data = await request(
        `/history?${new URLSearchParams({ offset, limit })}`,
        undefined,
        current.signal,
      );
      if (current !== controller) return;
      total = data.total;
      if (offset && offset >= total) {
        offset = Math.max(0, Math.floor((total - 1) / limit) * limit);
        return await load();
      }
      list.replaceChildren(...data.items.map(row));
      document.getElementById("reportHistoryTitle").textContent =
        `${number.format(total)} گزارش`;
      status.textContent = total
        ? ""
        : "هنوز گزارشی ذخیره نشده است. برای ساخت اولین گزارش، «گزارش جدید» را انتخاب کنید.";
      pagination.hidden = total <= limit;
      document.getElementById("reportHistoryPage").textContent =
        `${number.format(offset + 1)}–${number.format(Math.min(offset + limit, total))} از ${number.format(total)}`;
    } catch (err) {
      if (current !== controller || err.name === "AbortError") return;
      error.textContent =
        err.message || "دریافت گزارش‌ها انجام نشد. دوباره تلاش کنید.";
      error.hidden = false;
      status.textContent = "برای تلاش مجدد، بروزرسانی را انتخاب کنید.";
    } finally {
      if (current === controller) {
        list.setAttribute("aria-busy", "false");
        refresh.disabled = false;
        previous.disabled = offset === 0;
        next.disabled = offset + limit >= total;
      }
    }
  }
  refresh.onclick = () => void load();
  previous.onclick = () => {
    offset -= limit;
    void load();
  };
  next.onclick = () => {
    offset += limit;
    void load();
  };
  window.addEventListener("karbon:report-generated", () => {
    offset = 0;
    void load();
  });
  onPageRefresh(load, { maxAge: 0 });
  await load();
}
