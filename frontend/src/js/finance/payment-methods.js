import { node } from "./finance-utils.js";

export const paymentMethods = [
  ["pos", "کارت‌خوان", "▣"],
  ["cash", "نقدی", "◈"],
  ["transfer", "کارت‌به‌کارت", "⇄"],
];

export const paymentMethodLabels = Object.fromEntries(paymentMethods);

export function paymentMethodCard(id, label, icon, { group, value, checked = false } = {}) {
  const card = node("div", "orders-method card-tilt");
  const choice = node("label", "orders-method-choice");
  const input = node("input");
  input.id = id;
  input.type = group ? "radio" : "checkbox";
  input.defaultChecked = checked;
  if (group) {
    input.name = group;
    input.value = value;
    input.required = true;
  }
  const symbol = node("span", "orders-method-icon", icon);
  symbol.setAttribute("aria-hidden", "true");
  choice.append(input, symbol, node("span", "", label));
  card.append(choice);
  return card;
}
