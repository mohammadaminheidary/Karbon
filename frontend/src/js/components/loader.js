export function createSpinner() {
  const spinner = document.createElement("span");
  spinner.className = "inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent";
  spinner.setAttribute("aria-hidden", "true");
  return spinner;
}
