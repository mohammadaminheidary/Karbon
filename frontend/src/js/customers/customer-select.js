import { getCustomerOptions } from "./customer-api.js";

// Keep the native select, its validation and keyboard interaction. Search and
// explicit pagination avoid downloading every customer's options on form open.
export class CustomerSelect {
  constructor(select, { rows, busy = () => {} }) {
    Object.assign(this, {
      select,
      onRows: rows,
      onBusy: busy,
      items: [],
      offset: 0,
      total: 0,
      version: 0,
    });
    this.search = document.createElement("input");
    Object.assign(this.search, {
      type: "search",
      className: select.className,
      maxLength: 200,
      placeholder: "جستجوی نام، کد یا تلفن مشتری",
      autocomplete: "off",
    });
    this.search.setAttribute("aria-label", this.search.placeholder);
    this.more = document.createElement("button");
    Object.assign(this.more, {
      type: "button",
      className: "finance-button border border-french-gray/40",
      textContent: "نمایش بیشتر",
    });
    this.status = document.createElement("span");
    this.status.setAttribute("role", "status");
    const label = select.closest("label");
    if (label) {
      const field = document.createElement("div");
      field.className = label.className;
      field.style.display = "grid";
      field.style.gap = "8px";
      label.before(field);
      label.className = "";
      label.htmlFor = select.id;
      field.append(label, this.search, select, this.status, this.more);
    } else {
      select.before(this.search);
      select.after(this.status, this.more);
    }
    this.search.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.cancel();
      this.setBusy(true);
      this.timer = setTimeout(() => void this.load().catch(() => {}), 200);
    });
    this.more.addEventListener(
      "click",
      () =>
        void this.load({ more: this.more.dataset.retry !== "true" }).catch(
          () => {},
        ),
    );
    select.addEventListener("change", () => {
      this.selected = this.items.find((row) => String(row.id) === select.value);
    });
    window.addEventListener("pagehide", () => this.cancel());
    this.setActive(false);
  }
  setActive(active) {
    this.active = active;
    this.search.hidden = !active;
    this.status.hidden = !active;
    this.more.hidden = !active || this.offset >= this.total;
    if (!active) this.cancel();
  }
  setBusy(value) {
    this.busy = value;
    this.select.disabled = value;
    this.more.disabled = value;
    this.onBusy(value);
  }
  cancel() {
    clearTimeout(this.timer);
    this.controller?.abort();
    this.version++;
    this.setBusy(false);
  }
  async reset(selectedId) {
    this.cancel();
    this.search.value = "";
    this.selected = undefined;
    this.items = [];
    return this.load({ selectedId });
  }
  async load({ more = false, selectedId } = {}) {
    this.controller?.abort();
    const controller = (this.controller = new AbortController()),
      version = ++this.version;
    this.setBusy(true);
    this.status.textContent = "در حال جستجو…";
    try {
      const page = await getCustomerOptions({
        search: this.search.value.trim(),
        skip: more ? this.offset : 0,
        limit: 100,
        signal: controller.signal,
      });
      let selectedRow =
        page.items.find((row) => row.id === this.selected?.id) || this.selected;
      if (selectedId && !page.items.some((row) => row.id === selectedId)) {
        const selected = await getCustomerOptions({
          customer_id: selectedId,
          limit: 1,
          signal: controller.signal,
        });
        selectedRow = selected.items.find((row) => row.id === selectedId);
      } else if (selectedId)
        selectedRow = page.items.find((row) => row.id === selectedId);
      if (controller.signal.aborted || version !== this.version)
        return this.items;
      this.selected = selectedRow;
      this.offset = (more ? this.offset : 0) + page.items.length;
      this.total = page.total;
      this.items = more
        ? [
            ...new Map(
              [...this.items, ...page.items].map((row) => [row.id, row]),
            ).values(),
          ]
        : page.items;
      if (
        this.selected &&
        !this.items.some((row) => row.id === this.selected.id)
      )
        this.items = [this.selected, ...this.items];
      this.items.sort((a, b) => b.id - a.id); // Match the endpoint's order, including a retained selection.
      this.more.dataset.retry = "false";
      this.more.textContent = "نمایش بیشتر";
      this.more.hidden = !this.active || this.offset >= this.total;
      this.status.textContent = page.total ? "" : "مشتری پیدا نشد.";
      this.onRows(this.items, this.selected?.id);
      return this.items;
    } catch (error) {
      if (controller.signal.aborted || version !== this.version)
        return this.items;
      this.status.textContent = error.message;
      this.more.dataset.retry = "true";
      this.more.textContent = "تلاش مجدد";
      this.more.hidden = !this.active;
      throw error;
    } finally {
      if (version === this.version) this.setBusy(false);
    }
  }
}
