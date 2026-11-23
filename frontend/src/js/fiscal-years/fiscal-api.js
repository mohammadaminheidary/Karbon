import { financeRequest } from "../finance/finance-api.js";

export const fiscalRequest = (path = "", options = {}) =>
  financeRequest(`/settings/fiscal-years${path}`, { cache: "no-store", ...options });

export const getFiscalDate = () => fiscalRequest("/current");
export const fiscalLabel = (value) => String(value).replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[digit]);

export function archiveLink(year, kind, record, version) {
  const params = new URLSearchParams({ fiscal_year: year });
  if (kind) params.set("kind", kind);
  if (record) params.set("record", record);
  if (version) params.set("version", version);
  return `/page/settings-page.html?${params}#fiscal-year`;
}
