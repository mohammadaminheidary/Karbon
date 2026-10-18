import { getToken } from "../auth/auth-storage.js";
import { element, number } from "./chart.js";
import {
  GAP,
  ROW_UNIT,
  cloneLayout,
  defaultLayout,
  limits,
  resolveLayout,
  restoreLayout,
} from "./layout-model.js";

export class LayoutEditor {
  constructor(grid) {
    this.grid = grid;
    this.widgets = new Map();
    this.definitions = [...grid.children].map((surface) => {
      const id = surface.dataset.widgetId;
      const wrapper = element("section", "dash-widget");
      wrapper.dataset.widget = id;
      const kind = surface.querySelector('[id$="Chart"]')
        ? "chart"
        : surface.classList.contains("dash-kpi")
          ? "kpi"
          : "report";
      wrapper.dataset.kind = kind;
      const title = surface.querySelector("h2")?.textContent || id;
      wrapper.setAttribute("aria-label", title);
      const toolbar = element("div", "dash-widget-tools");
      const handle = element("button", "dash-move-handle", "⠿");
      handle.type = "button";
      handle.title = "کشیدن برای جابجایی؛ کلیدهای جهت برای حرکت";
      handle.setAttribute("aria-label", `جابجایی ${title}`);
      handle.append(element("span", "", title));
      toolbar.append(handle);
      const resize = element("button", "dash-resize-handle", "⌟");
      resize.type = "button";
      resize.setAttribute("aria-label", `تغییر اندازه ${title}`);
      resize.title = "کشیدن برای تغییر اندازه؛ کلیدهای جهت برای عرض و ارتفاع";
      grid.replaceChild(wrapper, surface);
      wrapper.append(toolbar, surface, resize);
      surface.classList.add("dash-widget-surface");
      this.widgets.set(id, wrapper);
      [handle, resize].forEach((control, index) => {
        control.addEventListener("pointerdown", (event) =>
          this.begin(event, id, index ? "resize" : "move"),
        );
        control.addEventListener("pointermove", (event) => this.move(event));
        control.addEventListener("pointerup", (event) => this.finish(event));
        control.addEventListener("pointercancel", () => this.abortGesture());
        control.addEventListener("lostpointercapture", () =>
          this.abortGesture(),
        );
        control.addEventListener("keydown", (event) =>
          this.key(event, id, index ? "resize" : "move"),
        );
      });
      return {
        id,
        kind,
        w: Number(surface.dataset.defaultWidth),
        h: Number(surface.dataset.defaultHeight),
      };
    });
    let owner = "local";
    try {
      owner =
        JSON.parse(
          atob(getToken().split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
        ).sub || owner;
    } catch {
      /* Preferences only; no credentials are saved. */
    }
    this.storageKey = `karbon-dashboard-layout-v1:${encodeURIComponent(owner)}`;
    try {
      const stored = JSON.parse(localStorage.getItem(this.storageKey));
      this.saved = stored?.version === 1 ? stored.layouts || {} : {};
    } catch {
      this.saved = {};
    }
    this.layouts = {};
    this.editButton = document.getElementById("editDashboardLayout");
    this.actions = document.getElementById("dashboardLayoutActions");
    this.status = document.getElementById("dashboardLayoutStatus");
    this.editButton.addEventListener("click", () => this.enter());
    document
      .getElementById("saveDashboardLayout")
      .addEventListener("click", () => this.save());
    document
      .getElementById("cancelDashboardLayout")
      .addEventListener("click", () => this.cancel());
    document
      .getElementById("resetDashboardLayout")
      .addEventListener("click", () => {
        this.abortGesture();
        this.layouts[this.mode] = defaultLayout(this.definitions, this.columns);
        this.apply();
        this.contentChanged();
        this.status.textContent =
          "چیدمان پیش‌فرض این نما آماده است؛ برای نگهداری تغییرات ذخیره کنید.";
      });
    this.media = [
      matchMedia("(min-width: 1150px)"),
      matchMedia("(min-width: 700px)"),
    ];
    this.media.forEach((query) =>
      query.addEventListener("change", () => this.breakpoint()),
    );
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.gesture) {
        event.preventDefault();
        this.abortGesture();
      }
    });
    window.addEventListener("pagehide", () => this.abortGesture());
    this.observer = new ResizeObserver(() => this.contentChanged());
    this.observer.observe(grid);
    grid.addEventListener("toggle", () => this.contentChanged(), true);
    this.widgets.forEach((widget) =>
      this.observer.observe(widget.querySelector(".dash-widget-surface")),
    );
    this.breakpoint();
  }
  breakpoint() {
    this.abortGesture();
    this.mode = this.media[0].matches
      ? "desktop"
      : this.media[1].matches
        ? "tablet"
        : "mobile";
    this.columns =
      this.mode === "desktop" ? 12 : this.mode === "tablet" ? 8 : 4;
    this.layouts[this.mode] ||= restoreLayout(
      this.saved[this.mode],
      this.definitions,
      this.columns,
    );
    this.grid.style.setProperty("--grid-columns", this.columns);
    document.getElementById("dashboardLayoutMode").textContent = {
      desktop: "نمای دسکتاپ",
      tablet: "نمای تبلت",
      mobile: "نمای موبایل",
    }[this.mode];
    this.apply();
    this.contentChanged();
  }
  enter() {
    if (this.editing) return;
    this.beforeEditing = structuredClone(this.layouts);
    this.editing = true;
    this.grid.dataset.editing = "true";
    this.editButton.setAttribute("aria-pressed", "true");
    this.editButton.disabled = true;
    this.actions.hidden = false;
    this.status.textContent =
      "کارت‌ها را از دستگیره بالا جابجا و از گوشه پایین تغییر اندازه دهید. کلیدهای جهت هم در دسترس‌اند. سپس ذخیره کنید.";
    this.contentChanged();
  }
  exit() {
    this.editing = false;
    this.grid.dataset.editing = "false";
    this.editButton.setAttribute("aria-pressed", "false");
    this.editButton.disabled = false;
    this.actions.hidden = true;
    this.apply();
    this.editButton.focus();
  }
  save() {
    this.abortGesture();
    try {
      const layouts = { ...this.saved, ...this.layouts };
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({ version: 1, layouts }),
      );
      this.saved = structuredClone(layouts);
      this.exit();
      this.status.textContent =
        "چیدمان ذخیره شد؛ در بازدید بعدی همین مرورگر و حساب کاربری بازیابی می‌شود.";
    } catch {
      this.status.textContent =
        "ذخیره چیدمان در مرورگر انجام نشد. تغییرات فعلی حفظ شده‌اند؛ دسترسی ذخیره‌سازی مرورگر را بررسی و دوباره تلاش کنید.";
    }
  }
  cancel() {
    this.abortGesture();
    this.layouts = this.beforeEditing;
    this.breakpoint();
    this.exit();
    this.status.textContent = "تغییرات چیدمان لغو شد.";
  }
  apply() {
    const layout = this.layouts[this.mode];
    if (!layout) return;
    const visualOrder = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const item of layout) {
      const widget = this.widgets.get(item.id);
      widget.style.gridColumn = `${item.x + 1} / span ${item.w}`;
      widget.style.gridRow = `${item.y + 1} / span ${item.h}`;
      for (const field of ["x", "y", "w", "h"])
        widget.dataset[field] = item[field];
      widget
        .querySelector(".dash-resize-handle")
        .setAttribute(
          "aria-description",
          `${number.format(item.w)} ستون، ${number.format(item.h)} ردیف`,
        );
    }
    // Reading and tab order follow the visible rows, including after a move.
    if (!this.gesture) {
      const focused = document.activeElement;
      visualOrder.forEach((item, index) => {
        const widget = this.widgets.get(item.id);
        if (this.grid.children[index] !== widget)
          this.grid.insertBefore(widget, this.grid.children[index] || null);
      });
      if (this.grid.contains(focused) && document.activeElement !== focused)
        focused.focus({ preventScroll: true });
    }
  }
  constraints(id) {
    const definition = this.definitions.find((def) => def.id === id);
    return {
      ...limits(definition, this.columns),
      minH: Math.max(
        limits(definition, this.columns).minH,
        Number(this.widgets.get(id).dataset.minH || 0),
      ),
    };
  }
  change(id, patch, base = this.layouts[this.mode]) {
    const item = base.find((item) => item.id === id),
      bounds = this.constraints(id);
    const next = { ...item, ...patch };
    next.w = Math.max(bounds.minW, Math.min(this.columns, next.w));
    next.h = Math.max(bounds.minH, Math.min(30, next.h));
    this.layouts[this.mode] = resolveLayout(
      base.map((item) => (item.id === id ? next : item)),
      this.definitions,
      this.columns,
      id,
    );
    this.apply();
  }
  begin(event, id, type) {
    if (!this.editing || event.button !== 0 || this.gesture) return;
    event.preventDefault();
    const item = this.layouts[this.mode].find((item) => item.id === id);
    this.gesture = {
      id,
      type,
      pointer: event.pointerId,
      control: event.currentTarget,
      clientX: event.clientX,
      clientY: event.clientY,
      item: { ...item },
      before: cloneLayout(this.layouts[this.mode]),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    this.widgets.get(id).dataset.active = "true";
    const tick = () => {
      if (!this.gesture) return;
      const y = this.gesture.latestY ?? this.gesture.clientY;
      const bottom = innerHeight - 110;
      const delta = y < 90 ? -16 : y > bottom ? 16 : 0;
      if (delta && this.gesture.latestY !== undefined) {
        scrollBy(0, delta);
        this.updateGesture();
      }
      this.scrollFrame = requestAnimationFrame(tick);
    };
    this.startScrollY = scrollY;
    this.scrollFrame = requestAnimationFrame(tick);
  }
  move(event) {
    if (!this.gesture || event.pointerId !== this.gesture.pointer) return;
    this.gesture.latestX = event.clientX;
    this.gesture.latestY = event.clientY;
    this.updateGesture();
  }
  updateGesture() {
    const gesture = this.gesture;
    const columnUnit = (this.grid.clientWidth + GAP) / this.columns;
    const dx = Math.round(
      (gesture.clientX - (gesture.latestX ?? gesture.clientX)) / columnUnit,
    );
    const dy = Math.round(
      ((gesture.latestY ?? gesture.clientY) -
        gesture.clientY +
        scrollY -
        this.startScrollY) /
        ROW_UNIT,
    );
    const patch =
      gesture.type === "move"
        ? { x: gesture.item.x + dx, y: gesture.item.y + dy }
        : { w: gesture.item.w + dx, h: gesture.item.h + dy };
    this.change(gesture.id, patch, gesture.before);
  }
  finish(event) {
    if (!this.gesture || event.pointerId !== this.gesture.pointer) return;
    const { id, control, pointer } = this.gesture;
    this.gesture = null;
    cancelAnimationFrame(this.scrollFrame);
    if (control.hasPointerCapture(pointer))
      control.releasePointerCapture(pointer);
    delete this.widgets.get(id).dataset.active;
    this.apply();
    this.announce(id);
    this.contentChanged();
  }
  abortGesture() {
    if (!this.gesture) return;
    const { id, control, pointer, before } = this.gesture;
    this.gesture = null;
    cancelAnimationFrame(this.scrollFrame);
    this.layouts[this.mode] = before;
    if (control.hasPointerCapture(pointer))
      control.releasePointerCapture(pointer);
    delete this.widgets.get(id).dataset.active;
    this.apply();
  }
  key(event, id, type) {
    if (
      !this.editing ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    const item = this.layouts[this.mode].find((item) => item.id === id);
    const dx =
      event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    const dy = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    this.change(
      id,
      type === "move"
        ? { x: item.x + dx, y: item.y + dy }
        : { w: item.w + dx, h: item.h + dy },
    );
    this.announce(id);
  }
  announce(id) {
    const item = this.layouts[this.mode].find((item) => item.id === id);
    this.status.textContent = `${this.widgets.get(id).getAttribute("aria-label")}؛ ${number.format(item.w)} ستون × ${number.format(item.h)} ردیف. برای نگهداری تغییرات ذخیره کنید.`;
  }
  contentChanged() {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => this.fit());
  }
  fit() {
    if (this.gesture || !this.layouts[this.mode] || !this.grid.clientWidth)
      return;
    let changed = false;
    const layout = cloneLayout(this.layouts[this.mode]);
    for (const item of layout) {
      const widget = this.widgets.get(item.id),
        surface = widget.querySelector(".dash-widget-surface");
      const style = getComputedStyle(surface);
      let minimum =
        parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 4;
      for (const child of surface.children) {
        const childStyle = getComputedStyle(child);
        const margins =
          parseFloat(childStyle.marginTop) +
          parseFloat(childStyle.marginBottom);
        if (child.matches("[data-chart]")) {
          minimum +=
            108 +
            [...child.children]
              .filter(
                (node) => !node.classList.contains("dash-plot") && !node.hidden,
              )
              .reduce((sum, node) => {
                const css = getComputedStyle(node);
                return (
                  sum +
                  node.getBoundingClientRect().height +
                  parseFloat(css.marginTop) +
                  parseFloat(css.marginBottom)
                );
              }, 0) +
            margins;
        } else
          minimum +=
            (child.classList.contains("dash-receivables")
              ? 96
              : child.getBoundingClientRect().height) + margins;
      }
      if (this.editing) minimum += 34;
      const minH = Math.min(30, Math.ceil((minimum + GAP) / ROW_UNIT));
      widget.dataset.minH = minH;
      if (item.h < minH) {
        item.h = minH;
        changed = true;
      }
    }
    if (changed) {
      this.layouts[this.mode] = resolveLayout(
        layout,
        this.definitions,
        this.columns,
      );
      this.apply();
    }
  }
}
