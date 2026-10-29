import { getToken } from "../auth/auth-storage.js";
import { element, number } from "./chart.js";
import {
  GAP,
  ROW_UNIT,
  cloneLayout,
  defaultLayout,
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
          this.begin?.(event, id, index ? "resize" : "move"),
        );
        control.addEventListener("pointermove", (event) => this.move?.(event));
        control.addEventListener("pointerup", (event) => this.finish?.(event));
        control.addEventListener("pointercancel", () => this.abortGesture());
        control.addEventListener("lostpointercapture", () =>
          this.abortGesture(),
        );
        control.addEventListener("keydown", (event) =>
          this.key?.(event, id, index ? "resize" : "move"),
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
      .addEventListener("click", () => this.save?.());
    document
      .getElementById("cancelDashboardLayout")
      .addEventListener("click", () => this.cancel?.());
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
  async enter() {
    try {
      this.toolsLoading ||= import("./layout-tools.js");
      const { LayoutTools } = await this.toolsLoading;
      const methods = Object.getOwnPropertyDescriptors(LayoutTools.prototype);
      delete methods.constructor;
      Object.defineProperties(this, methods);
      this.enter();
    } catch {
      this.toolsLoading = undefined;
      this.status.textContent = "دریافت ابزار چیدمان انجام نشد؛ دوباره تلاش کنید.";
      window.dispatchEvent(new CustomEvent("karbon:startup-error", { detail: this.status.textContent }));
    }
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
        if (child.hidden) continue;
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
