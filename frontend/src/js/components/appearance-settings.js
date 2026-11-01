import { notifyNavbar } from "./navbar-notification.js";

export function initializeAppearanceSettings() {
  const appearance = window.KarbonAppearance;
  const globalSlider = document.getElementById("appearanceFontSize");
  const globalValue = document.getElementById("appearanceFontValue");
  const pageList = document.getElementById("appearancePageList");
  const trigger = document.getElementById("appearancePageMenuButton");
  const menu = document.getElementById("appearancePageMenu");
  const message = document.getElementById("appearanceMessage");
  const formatter = new Intl.NumberFormat("fa-IR");
  const formatSize = (size) => `${formatter.format(size)}٪`;
  const rows = new Map();

  function save(patch) {
    const saved = appearance.updatePreferences(patch);
    message.textContent = saved
      ? "تغییرات ظاهر ذخیره شد."
      : "ذخیره در مرورگر انجام نشد؛ تنظیمات فقط تا بستن این صفحه اعمال می‌شود.";
    message.setAttribute("role", saved ? "status" : "alert");
  }

  for (const { id, label } of appearance.pages) {
    const row = document.createElement("div");
    row.className = "appearance-page-row";
    row.dataset.appearancePage = id;
    const heading = document.createElement("div");
    heading.className = "appearance-page-heading";
    const title = document.createElement("label");
    title.htmlFor = `appearance-size-${id}`;
    title.textContent = label;
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "appearance-reset";
    reset.textContent = "بازنشانی";
    reset.setAttribute(
      "aria-label",
      `بازنشانی اندازه قلم ${label} به اندازه عمومی`,
    );
    heading.append(title, reset);
    const control = document.createElement("div");
    control.className = "appearance-slider-row";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.id = title.htmlFor;
    slider.min = appearance.MIN_SIZE;
    slider.max = appearance.MAX_SIZE;
    slider.step = "5";
    slider.dir = "ltr";
    const output = document.createElement("output");
    output.htmlFor = slider.id;
    const hint = document.createElement("p");
    hint.id = `appearance-hint-${id}`;
    hint.className = "appearance-page-hint";
    slider.setAttribute("aria-describedby", hint.id);
    control.append(slider, output);
    row.append(heading, control, hint);
    pageList.append(row);
    rows.set(id, { slider, output, hint, reset });
    slider.addEventListener("input", () => {
      const current = appearance.getPreferences();
      save({
        pageFontSizes: { ...current.pageFontSizes, [id]: Number(slider.value) },
      });
    });
    reset.addEventListener("click", () => {
      if (reset.getAttribute("aria-disabled") === "true") return;
      const { pageFontSizes } = appearance.getPreferences();
      delete pageFontSizes[id];
      save({ pageFontSizes });
    });
  }

  function render() {
    const { theme, fontSize, pageFontSizes } = appearance.getPreferences();
    document.querySelectorAll("[data-appearance-theme]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.appearanceTheme === theme),
      );
    });
    globalSlider.value = fontSize;
    globalSlider.setAttribute("aria-valuetext", formatSize(fontSize));
    globalValue.value = formatSize(fontSize);
    for (const [id, { slider, output, hint, reset }] of rows) {
      const custom = Object.hasOwn(pageFontSizes, id);
      slider.value = pageFontSizes[id] ?? fontSize;
      slider.setAttribute("aria-valuetext", formatSize(Number(slider.value)));
      output.value = formatSize(Number(slider.value));
      hint.textContent = custom
        ? "اندازه اختصاصی این صفحه"
        : "پیروی از اندازه عمومی";
      // Keep the reset control focusable after activation.
      reset.setAttribute("aria-disabled", String(!custom));
    }
  }

  document.querySelectorAll("[data-appearance-theme]").forEach((button) => {
    button.addEventListener("click", () =>
      save({ theme: button.dataset.appearanceTheme }),
    );
  });
  globalSlider.addEventListener("input", () =>
    save({ fontSize: Number(globalSlider.value) }),
  );

  document
    .getElementById("appearanceResetDefaults")
    .addEventListener("click", () => {
      if (
        !window.confirm(
          "تنظیمات ظاهر به حالت پیش‌فرض بازگردد؟ رنگ آبی و اندازه قلم ۱۰۰٪ اعمال و اندازه‌های اختصاصی صفحات پاک می‌شود. تنظیمات امنیتی و سایر تنظیمات تغییر نمی‌کند.",
        )
      )
        return;
      const saved = appearance.resetPreferences();
      closeMenu();
      const text = saved
        ? "تنظیمات ظاهر به پیش‌فرض بازنشانی شد."
        : "ظاهر بازنشانی شد؛ ذخیره در مرورگر انجام نشد و پس از بازخوانی ممکن است تنظیمات قبلی برگردد.";
      message.textContent = text;
      message.setAttribute("role", saved ? "status" : "alert");
      notifyNavbar(text, { role: saved ? "status" : "alert" });
    });

  function closeMenu(restoreFocus = false) {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  }
  trigger.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    trigger.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden)
      rows.values().next().value.slider.focus({ preventScroll: true });
  });
  document.addEventListener("click", (event) => {
    if (
      !menu.hidden &&
      !menu.contains(event.target) &&
      !trigger.contains(event.target)
    )
      closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      closeMenu(true);
    }
  });
  // Collapse the disclosure when the user tabs out, without trapping focus.
  document
    .getElementById("appearanceFontControls")
    .addEventListener("focusout", (event) => {
      if (
        event.relatedTarget &&
        !event.currentTarget.contains(event.relatedTarget)
      )
        closeMenu();
    });
  window.addEventListener("karbon:appearance-change", render);
  render();
}
