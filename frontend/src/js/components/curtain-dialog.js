// Shared navbar curtain, extracted from the Daily Tasks form.
const openCurtains = new Set();

export class CurtainDialog {
  constructor(
    id,
    {
      canClose = () => true,
      onCancel = () => {},
      onClosed = () => {},
      restoreFocus = () =>
        this.previousFocus
          ?.closest?.("details:not([open])")
          ?.querySelector("summary") || this.previousFocus,
    } = {},
  ) {
    this.root = document.getElementById(id);
    this.content = this.root.querySelector(".curtain-content");
    // Put the accessible name and alert role on the native modal itself.
    for (const attribute of ["role", "aria-labelledby", "aria-describedby"]) {
      const value = this.content.getAttribute(attribute);
      if (value) {
        this.root.setAttribute(attribute, value);
        this.content.removeAttribute(attribute);
      }
    }
    this.content.removeAttribute("aria-modal");
    this.navbar = document.getElementById("mainNavbar");
    this.canClose = canClose;
    this.onCancel = onCancel;
    this.onClosed = onClosed;
    this.restoreFocus = restoreFocus;
    this.closing = false;
    this.root.tabIndex = -1;
    this.navbar.append(this.root);
    this.root.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.cancel();
    });
    this.root.querySelectorAll("[data-dialog-close]").forEach((button) => {
      button.addEventListener("click", () => this.cancel());
    });
    this.root.addEventListener("animationend", (event) => {
      if (event.target === this.root && !this.closing)
        this.root.classList.remove("is-expanding");
    });
    window.addEventListener("resize", () => {
      if (this.root.open) this.updateHeight();
    });
    // Options, validation errors, and expandable fields can change form height.
    this.observer = new ResizeObserver(() => {
      if (this.root.open && !this.closing) this.updateHeight();
    });
    this.observer.observe(this.content);
  }

  updateHeight() {
    const rect = this.navbar.getBoundingClientRect();
    const bottom = Math.max(12, window.innerHeight - rect.bottom);
    this.root.style.setProperty("--task-curtain-left", `${rect.left}px`);
    this.root.style.setProperty("--task-curtain-width", `${rect.width}px`);
    this.root.style.setProperty("--task-navbar-height", `${rect.height}px`);
    this.root.style.setProperty("--task-curtain-bottom", `${bottom}px`);
    this.root.style.setProperty(
      "--task-form-height",
      `${Math.min(
        this.content.scrollHeight,
        window.innerHeight - bottom - 16,
      )}px`,
    );
  }

  open(focusTarget) {
    if (this.root.open || this.closing) return;
    this.previousFocus = document.activeElement;
    this.root.inert = false;
    this.root.setAttribute("aria-hidden", "false");
    this.updateHeight();
    openCurtains.add(this);
    document.body.classList.add("bottom-curtain-open");
    this.root.showModal();
    this.updateHeight();
    this.root.classList.add("is-expanding");
    (focusTarget || this.root).focus({ preventScroll: true });
  }

  cancel() {
    if (!this.root.open || this.closing || !this.canClose()) return;
    this.onCancel();
    this.close();
  }

  close() {
    if (!this.root.open || this.closing) return;
    this.closing = true;
    this.root.classList.remove("is-expanding");
    this.root.classList.add("is-closing");
    const finish = (event) => {
      if (event && event.target !== this.root) return;
      clearTimeout(timer);
      this.root.removeEventListener("animationend", finish);
      this.root.close();
      this.root.classList.remove("is-closing");
      this.root.setAttribute("aria-hidden", "true");
      openCurtains.delete(this);
      document.body.classList.toggle(
        "bottom-curtain-open",
        openCurtains.size > 0,
      );
      this.closing = false;
      const target = this.restoreFocus();
      if (target?.isConnected && !target.disabled)
        target.focus({ preventScroll: true });
      this.onClosed();
    };
    this.root.addEventListener("animationend", finish);
    const timer = setTimeout(finish, 250);
  }
}
