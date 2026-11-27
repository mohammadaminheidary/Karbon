import { fullDate, money, node } from "./finance-utils.js";

const series = ["balance", "income", "expense"];
const labels = { income: "درآمد", expense: "هزینه" };
const axisAmount = new Intl.NumberFormat("fa-IR", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const clockDigits = new Intl.NumberFormat("fa-IR", { minimumIntegerDigits: 2 });
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const clock = (time) =>
  time
    .split(":")
    .map((part) => clockDigits.format(part))
    .join(":");

function svgNode(tag, attrs = {}, text) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs))
    element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function amountTicks(points) {
  let min = 0;
  let max = 1;
  for (const point of points) {
    min = Math.min(min, point.balance);
    max = Math.max(max, point.income, point.expense);
  }
  const interval = Math.max(1, (max - min) / 4);
  const magnitude = 10 ** Math.floor(Math.log10(interval));
  const step = [1, 2, 2.5, 5, 10]
    .map((value) => value * magnitude)
    .find((value) => value >= interval);
  const first = Math.floor(min / step);
  const last = Math.ceil(max / step);
  return Array.from(
    { length: last - first + 1 },
    (_, index) => (first + index) * step,
  );
}

function transactionTime(item) {
  return [
    item.transaction_date && fullDate(item.transaction_date),
    item.transaction_time && clock(item.transaction_time),
  ]
    .filter(Boolean)
    .join(" · ");
}

export class DailyFinanceChart {
  constructor(host) {
    this.host = host;
    this.marks = [];
    this.svg = svgNode("svg", {
      class: "daily-finance-svg",
      "aria-hidden": "true",
    });
    this.tip = node("div", "daily-finance-tooltip");
    this.tip.setAttribute("aria-hidden", "true");
    this.readout = node("p", "daily-finance-readout");
    this.readout.setAttribute("role", "status");
    host.append(this.svg, this.tip, this.readout);

    this.observer = new ResizeObserver(() => {
      if (
        this.data &&
        (host.clientWidth !== this.width || host.clientHeight !== this.height)
      )
        this.draw();
    });
    this.observer.observe(host);
    host.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      this.touchPinned = false;
      this.pointer = event;
      if (!this.frame)
        this.frame = requestAnimationFrame(() => {
          this.frame = null;
          this.inspectPointer(this.pointer);
        });
    });
    host.addEventListener("pointerleave", () => {
      if (!this.touchPinned) this.dismiss();
    });
    host.addEventListener("pointerup", (event) => {
      if (event.pointerType === "touch") {
        this.touchPinned = true;
        this.inspectPointer(event);
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (this.touchPinned && !host.contains(event.target)) this.dismiss();
    });
    host.addEventListener("focus", () => {
      if (host.matches(":focus-visible")) this.inspectKey(0);
    });
    host.addEventListener("blur", () => {
      if (!this.touchPinned) this.dismiss();
    });
    host.addEventListener("keydown", (event) => this.handleKey(event));
  }

  clear() {
    this.dismiss();
    this.data = null;
    this.marks = [];
    this.svg.replaceChildren();
    this.host.hidden = true;
  }

  update(data) {
    if (!data.transactions.length) {
      this.clear();
      return;
    }
    this.data = data;
    this.host.hidden = false;
    this.draw();
  }

  draw() {
    this.dismiss();
    const { chart, transactions } = this.data;
    const width = (this.width = this.host.clientWidth);
    const height = (this.height = this.host.clientHeight);
    if (!width || !height) return;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const ticks = amountTicks(chart);
    const tickLabels = ticks.map((value) => axisAmount.format(value));
    const left = Math.max(
      40,
      15 + 6 * Math.max(...tickLabels.map((label) => label.length)),
    );
    const right = width - 22;
    const top = 24;
    const bottom = height - 34;
    this.bounds = { left, right, top, bottom };
    const min = ticks[0];
    const max = ticks.at(-1);
    const y = (value) =>
      bottom - ((value - min) / (max - min)) * (bottom - top);
    const positions = chart.map(({ time }) => {
      const [hour, minute, second = 0] = time.split(":").map(Number);
      return (
        left + ((hour * 3600 + minute * 60 + second) / 86400) * (right - left)
      );
    });

    const grid = svgNode("g", { class: "daily-finance-grid" });
    const axes = svgNode("g", {
      class: "daily-finance-axes",
      direction: "ltr",
    });
    ticks.forEach((value, index) => {
      const row = y(value);
      grid.append(
        svgNode("line", {
          x1: left,
          x2: right,
          y1: row,
          y2: row,
          class: value === 0 ? "daily-finance-zero" : "",
        }),
      );
      axes.append(
        svgNode(
          "text",
          {
            x: left - 9,
            y: row,
            "text-anchor": "start",
            "dominant-baseline": "middle",
            direction: "rtl",
          },
          tickLabels[index],
        ),
      );
    });
    const hourStep = width < 480 ? 6 : width < 760 ? 4 : 3;
    for (let hour = 0; hour <= 24; hour += hourStep) {
      const x = left + (hour / 24) * (right - left);
      grid.append(svgNode("line", { x1: x, x2: x, y1: top, y2: bottom }));
      axes.append(
        svgNode(
          "text",
          {
            x,
            y: bottom + 21,
            "text-anchor": "middle",
          },
          clock(`${hour}:00`),
        ),
      );
    }

    // The API emits a point per transaction in ascending order and the ledger in reverse order.
    this.marks = transactions
      .slice()
      .reverse()
      .map((item, index) => {
        const x = positions[index + 1];
        const row = y(chart[index + 1][item.kind]);
        const element = svgNode("g", {
          class: "daily-finance-marker",
          "data-series": item.kind,
        });
        const shape =
          item.kind === "income"
            ? svgNode("circle", { cx: x, cy: row, r: 3.7 })
            : svgNode("rect", {
                x: x - 3.6,
                y: row - 3.6,
                width: 7.2,
                height: 7.2,
                rx: 1.7,
              });
        element.append(
          svgNode("circle", {
            cx: x,
            cy: row,
            r: 7.5,
            class: "daily-finance-halo",
          }),
          shape,
        );
        return { index, x, y: row, item, element };
      });

    const traces = svgNode("g", { id: "dailyFinanceTraces" });
    const fills = svgNode("g");
    this.segments = [];
    for (const key of series) {
      let previousY = y(chart[0][key]);
      let path = `M ${positions[0]} ${previousY}`;
      let lastMark;
      for (let index = 1; index < chart.length; index++) {
        const x = positions[index];
        const nextY = y(chart[index][key]);
        const mark = this.marks[index - 1];
        path += ` H ${x}`;
        if (lastMark && x > positions[index - 1]) {
          this.segments.push({
            left: positions[index - 1],
            right: x,
            top: previousY,
            bottom: previousY,
            mark: lastMark,
          });
        }
        if (mark && (key === mark.item.kind || key === "balance")) {
          path += ` V ${nextY}`;
          this.segments.push({
            left: x,
            right: x,
            top: Math.min(previousY, nextY),
            bottom: Math.max(previousY, nextY),
            mark,
          });
          lastMark = mark;
        }
        previousY = nextY;
      }
      if (key !== "balance") {
        fills.append(
          svgNode("path", {
            class: "daily-finance-area",
            "data-series": key,
            d: `${path} V ${y(0)} H ${positions[0]} Z`,
          }),
        );
      }
      traces.append(
        svgNode("path", {
          d: path,
          class: "daily-finance-trace",
          "data-series": key,
        }),
      );
    }
    for (const mark of this.marks) traces.append(mark.element);

    this.guide = svgNode("line", {
      class: "daily-finance-guide",
      y1: top,
      y2: bottom,
    });
    this.lens = svgNode("g", { class: "daily-finance-lens" });
    const lensClip = svgNode("clipPath", { id: "dailyFinanceLensClip" });
    lensClip.append(svgNode("circle", { r: 23 }));
    const lens = svgNode("g", { "clip-path": "url(#dailyFinanceLensClip)" });
    lens.append(
      svgNode("circle", { class: "daily-finance-lens-surface", r: 23 }),
    );
    const zoom = svgNode("g", { class: "daily-finance-lens-zoom" });
    zoom.append(
      svgNode("use", {
        class: "daily-finance-lens-image",
        href: "#dailyFinanceTraces",
      }),
    );
    lens.append(zoom);
    this.lens.append(
      lens,
      svgNode("circle", { class: "daily-finance-lens-ring", r: 22.5 }),
    );
    this.svg.replaceChildren(
      lensClip,
      grid,
      fills,
      this.guide,
      traces,
      this.lens,
      axes,
    );
  }

  inspectPointer(event) {
    if (!this.marks.length) return;
    const { left, top, right, bottom } = this.bounds;
    const rect = this.svg.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < left - 7 || x > right + 7 || y < top - 7 || y > bottom + 7) {
      this.dismiss();
      return;
    }

    let nearest;
    let distance = Infinity;
    for (const mark of this.marks) {
      const delta = (x - mark.x) ** 2 + (y - mark.y) ** 2;
      if (delta < distance) {
        distance = delta;
        nearest = mark;
      }
    }
    let target = { x: nearest.x, y: nearest.y, mark: nearest };
    if (distance > 8 ** 2) {
      let limit = Math.min(distance, 13 ** 2);
      // Type-specific segments win over a balance segment at the same position.
      for (let index = this.segments.length - 1; index >= 0; index--) {
        const segment = this.segments[index];
        const sx = clamp(x, segment.left, segment.right);
        const sy = clamp(y, segment.top, segment.bottom);
        const delta = (x - sx) ** 2 + (y - sy) ** 2;
        if (delta < limit) {
          limit = delta;
          target = { x: sx, y: sy, mark: segment.mark };
        }
      }
    }
    this.inspect(target, { x, y }, rect);
  }

  inspect({ mark, x, y }, anchor, rect, keyboard = false) {
    if (this.selected !== mark) {
      for (const active of this.activeMarks ?? [])
        active.element.removeAttribute("data-active");
      // A simultaneous income and expense can share the same plotted position.
      const overlap = this.marks.find(
        (other) =>
          other.item.kind !== mark.item.kind &&
          other.x === mark.x &&
          other.y === mark.y,
      );
      this.activeMarks = overlap ? [mark, overlap] : [mark];
      const rows = document.createDocumentFragment();
      for (const active of this.activeMarks) {
        active.element.setAttribute("data-active", "");
        const item = active.item;
        const row = node("div", "daily-finance-tooltip-row");
        row.dataset.series = item.kind;
        const amount = node(
          "bdi",
          "daily-finance-tooltip-amount",
          money(item.amount),
        );
        const date = transactionTime(item);
        row.append(
          node("span", "daily-finance-tooltip-kind", labels[item.kind]),
          amount,
        );
        if (date) row.append(node("span", "daily-finance-tooltip-time", date));
        rows.append(row);
      }
      this.tip.replaceChildren(rows);
      this.selected = mark;
      this.tipSize = {
        width: this.tip.offsetWidth,
        height: this.tip.offsetHeight,
      };
    }
    this.lens.toggleAttribute(
      "data-following",
      this.host.hasAttribute("data-inspecting"),
    );
    this.lens.dataset.series = mark.item.kind;
    this.lens.style.setProperty("--finance-focus-x", `${x}px`);
    this.lens.style.setProperty("--finance-focus-y", `${y}px`);
    this.guide.setAttribute("x1", x);
    this.guide.setAttribute("x2", x);
    this.placeTip(anchor, rect);
    this.host.dataset.inspecting = "";
    if (keyboard) {
      const item = mark.item;
      this.readout.textContent = [
        labels[item.kind],
        money(item.amount),
        transactionTime(item),
      ]
        .filter(Boolean)
        .join("، ");
    }
  }

  placeTip({ x, y }, rect) {
    const { width, height } = this.tipSize;
    const left = Math.max(6, 8 - rect.left);
    const right = Math.min(
      rect.width - 6,
      document.documentElement.clientWidth - rect.left - 8,
    );
    const top = Math.max(6, 8 - rect.top);
    const bottom = Math.min(rect.height - 6, window.innerHeight - rect.top - 8);
    const tipX = x + 14 + width <= right ? x + 14 : x - 14 - width;
    const tipY = y - 14 - height >= top ? y - 14 - height : y + 14;
    this.tip.style.transform = `translate(${clamp(tipX, left, right - width)}px, ${clamp(tipY, top, bottom - height)}px)`;
  }

  inspectKey(index) {
    if (!this.marks.length) return;
    const mark = this.marks[clamp(index, 0, this.marks.length - 1)];
    this.inspect(
      { mark, x: mark.x, y: mark.y },
      mark,
      this.svg.getBoundingClientRect(),
      true,
    );
  }

  handleKey(event) {
    if (event.key === "Escape" && this.selected) {
      this.dismiss();
      return;
    }
    const index = this.selected?.index;
    const positions = {
      ArrowLeft: (index ?? 1) - 1,
      ArrowRight: (index ?? -1) + 1,
      Home: 0,
      End: this.marks.length - 1,
    };
    if (!Object.hasOwn(positions, event.key)) return;
    event.preventDefault();
    this.inspectKey(positions[event.key]);
  }

  dismiss() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
    for (const mark of this.activeMarks ?? [])
      mark.element.removeAttribute("data-active");
    this.activeMarks = [];
    this.selected = null;
    this.touchPinned = false;
    delete this.host.dataset.inspecting;
    this.readout.textContent = "";
  }
}
