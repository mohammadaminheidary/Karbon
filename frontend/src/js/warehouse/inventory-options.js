import { financeRequest } from "../finance/finance-api.js";

export const getInventoryOptions = () =>
  financeRequest("/settings/inventory-options", { cache: "no-store" });

export const saveInventoryOption = (kind, data, id) =>
  financeRequest(`/settings/inventory-options/${kind}${id ? `/${id}` : ""}`, {
    method: id ? "PUT" : "POST",
    body: data,
  });
