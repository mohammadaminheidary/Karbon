// Local SVG charts: no CDN, analytics service, or duplicate data store.
import { dashboardPalette } from "./theme.js";
export const number = new Intl.NumberFormat("fa-IR", {
  maximumFractionDigits: 1,
});
const compact = new Intl.NumberFormat("fa-IR", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const scientific = new Intl.NumberFormat("fa-IR", {
  notation: "scientific",
  maximumFractionDigits: 1,
});
const dateFormat = new Intl.DateTimeFormat("fa-IR", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
export const dateLabel = (value) =>
  dateFormat.format(new Date(`${value}T12:00:00Z`));
export const exact = (value) => number.format(BigInt(value ?? 0));
export const element = (tag, className = "", text = "") => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
const svgNode = (tag, attrs = {}) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs))
    node.setAttribute(key, value);
  return node;
};
let chartSequence = 0;

export class Chart {
  constructor(
    host,
    { series, bars = false, donut = false, money = false, height = 200 },
  ) {
    Object.assign(this, {
      host,
      series,
      bars,
      donut,
      money,
      height,
      rows: [],
      lo: 0,
      hi: 0,
    });
    this.uid = `karbon-chart-${++chartSequence}`;
    this.palette = dashboardPalette(host);
    host.dataset.chart = "true";
    this.plot = element("div", "dash-plot");
    this.svg = svgNode("svg", {
      role: "img",
      "aria-label": host.getAttribute("aria-label") || "نمودار تعاملی",
    });
    this.plot.tabIndex = 0;
    this.plot.setAttribute("role", "group");
    this.plot.setAttribute(
      "aria-label",
      donut
        ? "نمودار سهم هزینه؛ کلیدهای جهت برای مشاهده هر بخش، Escape برای بازنشانی"
        : "نمودار؛ کلیدهای جهت برای مشاهده، مثبت و منفی برای بزرگ‌نمایی، Escape برای بازنشانی",
    );
    this.tip = element("div", "dash-tooltip");
    this.tip.hidden = true;
    this.readout = element("p", "dash-sr");
    this.readout.setAttribute("aria-live", "polite");
    this.plot.append(this.svg, this.tip, this.readout);
    this.controls = element("div", "dash-chart-controls");
    this.legend = element("div", "dash-legend");
    series.forEach((s) => {
      const item = element("span", "", s.label);
      item.style.setProperty("--series-color", s.color);
      this.legend.append(item);
    });
    const actions = element("div", "dash-chart-actions");
    actions.hidden = donut;
    for (const [label, text, action] of [
      ["بزرگ‌نمایی", "+", () => this.zoom(0.5)],
      ["کوچک‌نمایی", "−", () => this.zoom(2)],
      ["بازنشانی نمودار", "↔", () => this.reset()],
    ]) {
      const button = element("button", "", text);
      button.type = "button";
      button.setAttribute("aria-label", label);
      button.title = label;
      button.addEventListener("click", action);
      actions.append(button);
    }
    this.controls.append(this.legend, actions);
    this.range = element("div", "dash-chart-range");
    this.sliders = ["آغاز نمایش", "پایان نمایش"].map((label, index) => {
      const input = element("input");
      input.type = "range";
      input.min = "0";
      input.setAttribute("aria-label", label);
      input.addEventListener("input", () => {
        if (index === 0) this.lo = Math.min(Number(input.value), this.hi);
        else this.hi = Math.max(Number(input.value), this.lo);
        this.draw();
      });
      this.range.append(input);
      return input;
    });
    this.rangeLabel = element("span");
    this.range.append(this.rangeLabel);
    this.details = element("details", "dash-data-details");
    this.details.append(element("summary", "", "مشاهده جدول داده‌ها"));
    this.tableHost = element("div", "dash-table-scroll");
    this.details.append(this.tableHost);
    host.append(this.plot, this.controls, this.range, this.details);
    this.plot.addEventListener("pointermove", (event) => {
      if (this.tip.contains(event.target)) return;
      const rect = this.svg.getBoundingClientRect();
      if (this.drag && Math.abs(event.clientX - this.drag.x) > 5) {
        this.drag.moved = true;
        const shift = Math.round(
          ((this.drag.x - event.clientX) / (rect.width - 65)) * this.drag.span,
        );
        this.setWindow(this.drag.lo + shift, this.drag.span);
      } else if (!this.pinned)
        this.inspect(this.indexAt(event.clientX, event.clientY));
    });
    this.plot.addEventListener("pointerdown", (event) => {
      if (event.target !== this.svg && !this.svg.contains(event.target)) return;
      if (
        !this.donut &&
        (event.pointerType === "mouse" || event.pointerType === "pen")
      ) {
        this.drag = {
          x: event.clientX,
          lo: this.lo,
          span: this.hi - this.lo + 1,
          moved: false,
        };
        this.plot.setPointerCapture(event.pointerId);
      }
    });
    this.plot.addEventListener("pointerup", (event) => {
      if (!this.drag?.moved) {
        this.pinned = !this.pinned;
        this.inspect(this.indexAt(event.clientX, event.clientY));
      }
      this.drag = undefined;
    });
    this.plot.addEventListener("pointercancel", () => {
      this.drag = undefined;
    });
    this.plot.addEventListener("pointerleave", () => {
      if (!this.pinned && !this.drag) this.hideTip();
    });
    this.plot.addEventListener(
      "wheel",
      (event) => {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          this.zoom(event.deltaY < 0 ? 0.65 : 1.5, this.indexAt(event.clientX));
        }
      },
      { passive: false },
    );
    this.plot.addEventListener("keydown", (event) => {
      if (
        [
          "ArrowLeft",
          "ArrowRight",
          "+",
          "=",
          "-",
          "Escape",
          "Home",
          "End",
        ].includes(event.key)
      )
        event.preventDefault();
      if (event.key === "+" || event.key === "=") this.zoom(0.5);
      else if (event.key === "-") this.zoom(2);
      else if (event.key === "Escape") this.reset();
      else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        let index = this.selected ?? this.lo;
        index =
          event.key === "Home"
            ? this.lo
            : event.key === "End"
              ? this.hi
              : index + (event.key === "ArrowRight" ? 1 : -1);
        this.inspect(Math.max(this.lo, Math.min(this.hi, index)), true);
      }
    });
    this.observer = new ResizeObserver(() => {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = requestAnimationFrame(() => this.draw());
    });
    this.observer.observe(host);
    this.observer.observe(this.plot);
  }

  update(rows, reset = false) {
    const oldLength = this.rows.length;
    this.rows = rows;
    if (reset || oldLength !== rows.length) {
      this.lo = 0;
      this.hi = Math.max(0, rows.length - 1);
      this.pinned = false;
      this.selected = rows.length
        ? rows.reduce(
            (selected, row, index) =>
              Number(row[this.series[0].key]) >
              Number(rows[selected][this.series[0].key])
                ? index
                : selected,
            0,
          )
        : undefined;
    }
    this.tableHost.replaceChildren();
    const table = element("table", "dash-table");
    const caption = element(
      "caption",
      "dash-sr",
      this.svg.getAttribute("aria-label"),
    );
    const head = element("thead");
    const tr = element("tr");
    [
      "تاریخ / عنوان",
      ...this.series.map((s) => s.label + (this.money ? " (تومان)" : "")),
    ].forEach((label) => {
      const th = element("th", "", label);
      th.scope = "col";
      tr.append(th);
    });
    head.append(tr);
    const body = element("tbody");
    rows.forEach((row) => {
      const tr = element("tr");
      tr.append(element("td", "", row.label));
      this.series.forEach((s) =>
        tr.append(element("td", "dash-numeric", exact(row[s.key]))),
      );
      body.append(tr);
    });
    table.append(caption, head, body);
    this.tableHost.append(table);
    this.draw();
  }

  reset() {
    this.pinned = false;
    this.lo = 0;
    this.hi = Math.max(0, this.rows.length - 1);
    this.draw();
  }
  setWindow(lo, span) {
    span = Math.max(1, Math.min(this.rows.length, span));
    this.lo = Math.max(0, Math.min(this.rows.length - span, lo));
    this.hi = this.lo + span - 1;
    this.draw();
  }
  zoom(factor, center = (this.lo + this.hi) / 2) {
    if (!this.rows.length || this.donut) return;
    const span = Math.max(1, Math.round((this.hi - this.lo + 1) * factor));
    this.setWindow(Math.round(center - (span - 1) / 2), span);
  }
  indexAt(clientX, clientY) {
    const rect = this.svg.getBoundingClientRect();
    if (this.donut && this.sectors) {
      const angle =
        (Math.atan2(
          (clientY ?? rect.top) - rect.top - this.height / 2,
          clientX - rect.left - this.width / 2,
        ) +
          Math.PI / 2 +
          Math.PI * 2) %
        (Math.PI * 2);
      return this.sectors.findIndex((sector) => angle <= sector.end);
    }
    const { left, right } = this.geometry || {
      left: 52,
      right: rect.width - 12,
    };
    const fraction = Math.max(
      0,
      Math.min(1, (clientX - rect.left - left) / Math.max(1, right - left)),
    );
    const span = this.hi - this.lo + 1;
    return Math.min(
      this.hi,
      this.lo +
        (this.bars
          ? Math.floor(fraction * span)
          : Math.round(fraction * (span - 1))),
    );
  }
  hideTip() {
    this.tip.hidden = true;
    this.crosshair?.setAttribute("visibility", "hidden");
    this.highlight();
  }
  highlight(index = this.selected) {
    this.svg.querySelectorAll(".dash-bar").forEach((bar) => {
      bar.setAttribute(
        "fill",
        `url(#${this.uid}-${Number(bar.dataset.index) === index ? `selected-${bar.dataset.series}` : `bar-${bar.dataset.series}`})`,
      );
    });
  }
  inspect(index, announce = false) {
    const row = this.rows[index];
    if (!row || index < this.lo || index > this.hi) return;
    this.selected = index;
    this.tip.replaceChildren(element("strong", "", row.label));
    const values = this.series.map(
      (s) => `${s.label}: ${exact(row[s.key])}${this.money ? " تومان" : ""}`,
    );
    values.forEach((value) => this.tip.append(element("span", "", value)));
    if (row.detail) this.tip.append(element("small", "", row.detail));
    this.tip.append(
      element(
        "small",
        "",
        this.pinned
          ? "انتخاب ثابت؛ برای آزادسازی کلیک کنید"
          : "برای ثابت نگه‌داشتن کلیک کنید",
      ),
    );
    this.tip.hidden = false;
    this.tip.style[this.x(index) > this.width / 2 ? "left" : "right"] = "8px";
    this.tip.style[this.x(index) > this.width / 2 ? "right" : "left"] = "auto";
    if (this.crosshair) {
      this.crosshair.setAttribute("x1", this.x(index));
      this.crosshair.setAttribute("x2", this.x(index));
      this.crosshair.setAttribute("visibility", "visible");
    }
    this.highlight(index);
    if (this.donut && this.total) {
      this.donutValue.textContent = `${number.format((Number(row[this.series[0].key]) / this.total) * 100)}٪`;
      this.donutLabel.textContent =
        row.label.length > this.donutLabelLimit
          ? `${row.label.slice(0, this.donutLabelLimit - 1)}…`
          : row.label;
    }
    if (announce)
      this.readout.textContent = `${row.label}؛ ${values.join("؛ ")}`;
  }
  draw() {
    this.svg.replaceChildren();
    this.crosshair = null;
    this.hideTip();
    this.width = Math.max(160, this.host.clientWidth);
    const inWidget = this.host.closest(".dash-widget");
    const availableHeight = inWidget ? this.plot.clientHeight : this.height;
    const w = this.width,
      h = Math.max(100, availableHeight),
      right = w - 12,
      bottom = h - 26,
      top = 12;
    this.height = h;
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    if (!inWidget) this.plot.style.height = `${h}px`;
    const rows = this.rows.slice(this.lo, this.hi + 1);
    this.host.dataset.visiblePoints = rows.length;
    this.range.hidden = this.rows.length <= 1 || this.donut;
    this.sliders.forEach((slider, i) => {
      slider.max = Math.max(0, this.rows.length - 1);
      slider.value = i === 0 ? this.lo : this.hi;
      slider.setAttribute(
        "aria-valuetext",
        this.rows[i === 0 ? this.lo : this.hi]?.label || "",
      );
    });
    this.rangeLabel.textContent = rows.length
      ? `${rows[0].label} — ${rows.at(-1).label}`
      : "";
    if (!rows.length) {
      const empty = svgNode("text", {
        x: w / 2,
        y: h / 2,
        "text-anchor": "middle",
        class: "dash-axis",
      });
      empty.textContent = "داده‌ای در این بازه ثبت نشده است";
      this.svg.append(empty);
      return;
    }
    const defs = svgNode("defs");
    for (const [id, stops] of [
      ["selected-0", [this.palette.strong, this.palette.primary]],
      ["selected-1", [this.palette.primary, this.palette.secondary]],
      ["bar-0", [this.palette.secondary, this.palette.light]],
      ["bar-1", [this.palette.soft, this.palette.light]],
      ["area", [this.series[0].color, "#ffffff"]],
    ]) {
      const gradient = svgNode("linearGradient", {
        id: `${this.uid}-${id}`,
        x1: "0",
        y1: "0",
        x2: "0",
        y2: "1",
      });
      stops.forEach((color, index) =>
        gradient.append(
          svgNode("stop", { offset: `${index * 100}%`, "stop-color": color }),
        ),
      );
      defs.append(gradient);
    }
    this.svg.append(defs);
    if (this.donut) {
      this.drawDonut(rows, w, h);
      return;
    }
    const values = rows.flatMap((row) =>
      this.series.map((s) => Number(row[s.key] ?? 0)),
    );
    const min = values.reduce((min, value) => Math.min(min, value), 0);
    const rawMax = values.reduce((max, value) => Math.max(max, value), 1);
    // Counts use integer ticks; a third of a task is not a useful axis label.
    const ticks = h < 160 ? 2 : 3;
    const max = this.money
      ? rawMax
      : Math.max(ticks, Math.ceil(rawMax / ticks) * ticks);
    this.measureContext ||= document.createElement("canvas").getContext("2d");
    this.measureContext.font = `9px ${getComputedStyle(this.host).fontFamily}`;
    const axisLabels = Array.from({ length: ticks + 1 }, (_, index) => {
      const value = min + ((max - min) * index) / ticks;
      const label = compact.format(value);
      return this.measureContext.measureText(label).width > w * 0.4 - 12
        ? scientific.format(value)
        : label;
    });
    const left = Math.max(
      w < 300 ? 42 : 52,
      Math.min(
        w * 0.4,
        Math.ceil(
          Math.max(
            ...axisLabels.map(
              (label) => this.measureContext.measureText(label).width,
            ),
          ) + 12,
        ),
      ),
    );
    this.geometry = { left, right };
    const y = (v) =>
      bottom - ((Number(v) - min) / (max - min)) * (bottom - top);
    this.x = (index) =>
      this.bars
        ? left + ((index - this.lo + 0.5) / rows.length) * (right - left)
        : left +
          (rows.length === 1 ? 0.5 : (index - this.lo) / (rows.length - 1)) *
            (right - left);
    for (let i = 0; i <= ticks; i++) {
      const value = min + ((max - min) * i) / ticks,
        pos = y(value);
      this.svg.append(
        svgNode("line", {
          x1: left,
          x2: right,
          y1: pos,
          y2: pos,
          class: "dash-gridline",
        }),
      );
      const label = svgNode("text", {
        x: left - 7,
        y: pos + 4,
        "text-anchor": "end",
        class: "dash-axis",
      });
      label.textContent = axisLabels[i];
      this.svg.append(label);
    }
    this.series.forEach((s, si) => {
      if (this.bars)
        rows.forEach((row, i) => {
          const slot = (right - left) / rows.length,
            barW = Math.max(1, Math.min(26, (slot * 0.5) / this.series.length));
          const value = Number(row[s.key]);
          const x = this.x(i + this.lo) + (si - this.series.length / 2) * barW;
          const barY = Math.min(y(0), y(value));
          const barHeight = Math.max(
            value === 0 ? 0 : 1,
            Math.abs(y(value) - y(0)),
          );
          const radius = Math.min(barW / 2, 8, barHeight);
          this.svg.append(
            svgNode("path", {
              d: `M ${x} ${barY + barHeight} V ${barY + radius} Q ${x} ${barY} ${x + radius} ${barY} H ${x + barW - radius} Q ${x + barW} ${barY} ${x + barW} ${barY + radius} V ${barY + barHeight} Z`,
              fill: `url(#${this.uid}-${(this.selected ?? this.hi) === i + this.lo ? `selected-${si % 2}` : `bar-${si % 2}`})`,
              class: "dash-bar",
              "data-index": i + this.lo,
              "data-series": si % 2,
            }),
          );
        });
      else {
        const points = rows
          .map((row, i) => `${this.x(i + this.lo)},${y(row[s.key])}`)
          .join(" ");
        if (this.series.length === 1 && rows.length > 1)
          this.svg.append(
            svgNode("polygon", {
              points: `${this.x(this.lo)},${y(0)} ${points} ${this.x(this.hi)},${y(0)}`,
              fill: `url(#${this.uid}-area)`,
              opacity: 0.12,
            }),
          );
        this.svg.append(
          svgNode("polyline", {
            points,
            fill: "none",
            stroke: s.color,
            "stroke-width": 2.2,
            "stroke-linejoin": "round",
            "stroke-linecap": "round",
          }),
        );
        if (rows.length === 1)
          this.svg.append(
            svgNode("circle", {
              cx: this.x(this.lo),
              cy: y(rows[0][s.key]),
              r: 4,
              fill: s.color,
            }),
          );
      }
    });
    [
      ...new Set(
        w < 330
          ? [0, rows.length - 1]
          : [0, Math.floor((rows.length - 1) / 2), rows.length - 1],
      ),
    ].forEach((i, index, arr) => {
      const label = svgNode("text", {
        x: this.x(i + this.lo),
        y: h - 5,
        class: "dash-axis",
        "text-anchor":
          arr.length === 1
            ? "middle"
            : index === 0
              ? "start"
              : index === arr.length - 1
                ? "end"
                : "middle",
      });
      const text = rows[i].shortLabel || rows[i].label;
      const maxLabel = w < 330 ? 12 : 18;
      label.textContent =
        text.length > maxLabel ? `${text.slice(0, maxLabel - 2)}…` : text;
      this.svg.append(label);
    });
    this.crosshair = svgNode("line", {
      y1: top,
      y2: bottom,
      stroke: this.palette.primary,
      "stroke-dasharray": "3 3",
      visibility: "hidden",
    });
    this.svg.append(this.crosshair);
    this.host.dataset.visiblePoints = rows.length;
    if (this.pinned)
      this.inspect(
        Math.max(this.lo, Math.min(this.hi, this.selected ?? this.lo)),
      );
  }
  drawDonut(rows, w, h) {
    const cx = w / 2,
      cy = h / 2;
    const radius = Math.max(28, Math.min(w / 2 - 35, h / 2 - 20));
    const thickness = Math.max(12, Math.min(30, radius * 0.29));
    const circumference = Math.PI * 2 * radius;
    this.total = rows.reduce(
      (sum, row) => sum + Number(row[this.series[0].key]),
      0,
    );
    this.x = () => w / 2;
    this.svg.append(
      svgNode("circle", {
        cx,
        cy,
        r: radius,
        fill: "none",
        stroke: this.palette.tint,
        "stroke-width": thickness,
      }),
    );
    this.svg.append(
      svgNode("circle", {
        cx,
        cy,
        r: radius - thickness / 2 - 7,
        fill: "none",
        stroke: this.palette.border,
        "stroke-width": 3,
      }),
    );
    let angle = 0;
    const palette = [
      this.palette.primary,
      this.palette.secondary,
      this.palette.soft,
      this.palette.light,
      this.palette.strong,
    ];
    this.legend.classList.add("dash-donut-legend");
    this.legend.replaceChildren(
      ...rows.map((row, index) => {
        const label = element("span", "", row.label);
        label.style.setProperty(
          "--series-color",
          palette[index % palette.length],
        );
        label.title = `${row.label}: ${exact(row[this.series[0].key])} تومان`;
        return label;
      }),
    );
    this.sectors = rows.map((row, index) => {
      const portion = this.total
        ? Number(row[this.series[0].key]) / this.total
        : 0;
      this.svg.append(
        svgNode("circle", {
          cx,
          cy,
          r: radius,
          fill: "none",
          stroke: palette[index % palette.length],
          "stroke-width": thickness,
          "stroke-dasharray": `${Math.max(0, circumference * portion - (rows.length > 1 ? 3 : 0))} ${circumference}`,
          transform: `rotate(${(angle * 180) / Math.PI - 90} ${cx} ${cy})`,
          class: "dash-donut-sector",
        }),
      );
      angle += portion * Math.PI * 2;
      return { end: angle };
    });
    this.donutValue = svgNode("text", {
      x: cx,
      y: cy + 2,
      "text-anchor": "middle",
      class: "dash-donut-value",
    });
    this.donutValue.style.fontSize = `${Math.min(25, radius * 0.5)}px`;
    this.donutLabelLimit = Math.max(
      8,
      Math.floor(((radius - thickness / 2) * 2) / 5.5),
    );
    this.donutLabel = svgNode("text", {
      x: cx,
      y: cy + 23,
      "text-anchor": "middle",
      class: "dash-axis",
    });
    const largest = rows.reduce(
      (index, row, i) =>
        Number(row[this.series[0].key]) >
        Number(rows[index][this.series[0].key])
          ? i
          : index,
      0,
    );
    this.donutValue.textContent = `${number.format(this.total ? (Number(rows[largest][this.series[0].key]) / this.total) * 100 : 0)}٪`;
    this.donutLabel.textContent = "بیشترین سهم";
    this.svg.append(this.donutValue, this.donutLabel);
    if (this.pinned) this.inspect(this.selected ?? largest);
  }
}
