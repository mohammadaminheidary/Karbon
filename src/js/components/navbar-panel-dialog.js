import { createNavbarPanelTransition } from "../documents/navbar-panel-transition.js";

// Use the same native surface, navbar geometry, and transition as registration.
export class NavbarPanelDialog {
  constructor(id, { canClose = () => true, onCancel = () => {} } = {}) {
    this.root = document.getElementById(id);
    this.content = this.root.querySelector(
      ".navbar-panel-content, .orders-glass",
    );
    this.navbar = document.getElementById("mainNavbar");
    this.canClose = canClose;
    this.onCancel = onCancel;
    this.root.classList.add(
      "navbar-transition-panel",
      "navbar-registration-panel",
    );
    this.root.tabIndex = -1;
    this.root.setAttribute(
      "aria-labelledby",
      this.content.getAttribute("aria-labelledby"),
    );
    this.content.removeAttribute("role");
    this.content.removeAttribute("aria-modal");
    this.content.removeAttribute("aria-labelledby");
    this.transition = createNavbarPanelTransition(this.root, {
      position: () => this.position(),
      show: () => {
        this.root.inert = false;
        this.root.setAttribute("aria-hidden", "false");
        document.body.classList.add("overflow-hidden");
        this.root.showModal();
      },
      hide: () => {
        this.root.close();
        this.root.setAttribute("aria-hidden", "true");
        if (
          !document.querySelector(
            'dialog[open], [aria-hidden="false"] [aria-modal="true"]',
          )
        )
          document.body.classList.remove("overflow-hidden");
        if (this.previousFocus?.isConnected && !this.previousFocus.disabled)
          this.previousFocus.focus({ preventScroll: true });
      },
    });
    this.root.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.cancel();
    });
    this.root.querySelectorAll("[data-dialog-close]").forEach((button) => {
      button.addEventListener("click", () => this.cancel());
    });
    this.observer = new ResizeObserver(() => {
      if (this.active && !this.closing) this.position();
    });
    this.observer.observe(this.content);
  }

  position() {
    const rect = this.navbar.getBoundingClientRect();
    const width =
      this.root.getBoundingClientRect().width || window.innerWidth - 32;
    const bottom = Math.max(12, window.innerHeight - rect.bottom);
    this.root.style.setProperty(
      "--task-curtain-left",
      `${(window.innerWidth - width) / 2}px`,
    );
    this.root.style.setProperty("--task-navbar-height", `${rect.height}px`);
    this.root.style.setProperty("--task-curtain-bottom", `${bottom}px`);
    this.root.style.setProperty(
      "--task-form-height",
      `${Math.min(this.content.scrollHeight, window.innerHeight - bottom - 16)}px`,
    );
  }

  get active() {
    return this.transition.active;
  }

  async open(focusTarget) {
    if (this.active) return;
    this.previousFocus = document.activeElement;
    await this.transition.open();
    if (this.active && !this.closing)
      (focusTarget && !focusTarget.disabled ? focusTarget : this.root).focus({
        preventScroll: true,
      });
  }

  cancel() {
    if (this.closing || !this.canClose()) return;
    this.onCancel();
    void this.close();
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.transition.close();
    } finally {
      this.closing = false;
    }
  }
}
