import { startPage } from "../components/page-ready.js";
import { refreshData } from "../components/api-cache.js";
import { NavbarPanelDialog } from "../components/navbar-panel-dialog.js";
import { initializeNavbar } from "../components/navbar.js";
import { createNavbarNotification } from "../components/navbar-notification.js";
import { onPageRefresh } from "../components/data-events.js";
import { protectPage } from "../guards/auth-guard.js";
import {
  fullDate,
  todayKey,
  node,
  formatJalaliInput,
  normalizeJalaliDate,
} from "../finance/finance-utils.js";
import {
  getTasks,
  createTask,
  updateTaskStatus,
  updateTask,
  deleteTask,
} from "../tasks/tasks-api.js";
import { initializeTaskDrag } from "../tasks/task-drag.js";

initializeNavbar();
const $ = (id) => document.getElementById(id);
const titleIsland = document.querySelector(".navbar-title-island");
const notify = createNavbarNotification(titleIsland);
const curtain = $("taskCurtain");
const details = $("taskDetails");
const formDialog = new NavbarPanelDialog("taskCurtain", {
  canClose: () => !saving,
  onCancel: () => {
    void closeForm();
  },
});
const detailsDialog = new NavbarPanelDialog("taskDetails", {
  canClose: () => !saving,
  onCancel: () => {
    void closeDetails();
  },
});
const labels = {
  todo: "برای انجام",
  in_progress: "در حال انجام",
  completed: "انجام شده",
};
const lists = {
  todo: $("todoTasks"),
  in_progress: $("in_progressTasks"),
  completed: $("completedTasksList"),
};
const number = new Intl.NumberFormat("fa-IR");
let tasks = [],
  tasksLoaded = false,
  saving = false,
  loading = false,
  reloadRequested = false,
  loadVersion = 0,
  closing = false,
  editingId = null,
  detailsId = null;
const pending = new Set();

function showError(target, message = "") {
  target.textContent = message;
  target.hidden = !message;
}

function render(focusId) {
  tasksLoaded = true;
  for (const [status, list] of Object.entries(lists)) {
    const matching = tasks.filter((task) => task.status === status);
    $(status + "Count").textContent = number.format(matching.length);
    list.replaceChildren(...matching.map(card));
    if (!matching.length)
      list.append(node("p", "tasks-empty", "کاری در این ستون وجود ندارد."));
  }
  $("totalTasks").textContent = number.format(tasks.length);
  $("completedTasks").textContent = number.format(
    tasks.filter((task) => task.status === "completed").length,
  );
  $("inProgressTasks").textContent = number.format(
    tasks.filter((task) => task.status === "in_progress").length,
  );
  if (focusId)
    document
      .getElementById(`task-card-${focusId}`)
      ?.focus({ preventScroll: true });
}

function card(task) {
  const article = node("article", "task-card");
  article.id = `task-card-${task.id}`;
  article.dataset.taskId = String(task.id);
  article.draggable = !pending.has(task.id);
  article.tabIndex = 0;
  article.setAttribute("role", "button");
  article.setAttribute("aria-haspopup", "dialog");
  article.setAttribute("aria-label", `جزئیات ${task.title}`);
  article.setAttribute("aria-busy", String(pending.has(task.id)));
  article.append(node("h4", "", task.title));
  if (task.description) article.append(node("p", "", task.description));
  const date = node("time", "", fullDate(task.date));
  date.dateTime = task.date;
  article.append(date);
  article.addEventListener("click", () => openDetails(task.id));
  article.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetails(task.id);
    }
  });
  return article;
}

async function changeStatus(id, status, restoreFocus = false) {
  const task = tasks.find((item) => item.id === id);
  if (
    !task ||
    pending.has(id) ||
    !Object.hasOwn(labels, status) ||
    task.status === status
  )
    return;
  const previousStatus = task.status;
  pending.add(id);
  // Move the card and update counts immediately; revert if persistence fails.
  task.status = status;
  loadVersion++;
  showError($("tasksError"));
  render();
  try {
    const updated = await updateTaskStatus(id, status);
    tasks = tasks.map((item) => (item.id === id ? updated : item));
    notify("وضعیت کار بروزرسانی شد.");
  } catch (error) {
    task.status = previousStatus;
    showError($("tasksError"), error.message);
  } finally {
    pending.delete(id);
    render(restoreFocus ? id : undefined);
    if (reloadRequested) void loadTasks();
  }
}

initializeTaskDrag($("taskBoard"), {
  canDrag: (id) =>
    !pending.has(id) &&
    !curtain.open &&
    !details.open &&
    tasks.some((task) => task.id === id),
  onDrop: (id, status) => changeStatus(id, status),
});

function openDetails(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task || pending.has(id) || saving || details.open) return;
  detailsId = id;
  $("taskDetailsTitle").textContent = task.title;
  $("taskDetailsId").textContent = number.format(task.id);
  $("taskDetailsDate").textContent = fullDate(task.date);
  $("taskDetailsStatus").textContent = labels[task.status];
  $("taskDetailsCreated").textContent = new Intl.DateTimeFormat(
    "fa-IR-u-ca-persian",
    {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "Asia/Tehran",
    },
  ).format(
    new Date(
      task.created_at.endsWith("Z") ? task.created_at : `${task.created_at}Z`,
    ),
  );
  $("taskDetailsDescription").textContent =
    task.description || "توضیحی ثبت نشده است.";
  $("taskDeleteConfirmation").hidden = true;
  showError($("taskDetailsError"));
  detailsDialog.open();
}

async function closeDetails() {
  if (saving || detailsDialog.closing) return;
  const id = detailsId;
  await detailsDialog.close();
  detailsId = null;
  ($(`task-card-${id}`) || $("addTask")).focus({ preventScroll: true });
}

$("closeTaskDetails").addEventListener("click", closeDetails);
$("editTask").addEventListener("click", async () => {
  const task = tasks.find((item) => item.id === detailsId);
  if (!task || saving || detailsDialog.closing) return;
  await closeDetails();
  openForm(task);
});
$("deleteTask").addEventListener("click", () => {
  $("taskDeleteConfirmation").hidden = false;
  $("confirmDeleteTask").focus();
});
$("cancelDeleteTask").addEventListener("click", () => {
  $("taskDeleteConfirmation").hidden = true;
  $("deleteTask").focus();
});
$("confirmDeleteTask").addEventListener("click", async () => {
  if (saving || detailsId === null) return;
  const id = detailsId;
  saving = true;
  loadVersion++;
  showError($("taskDetailsError"));
  details.setAttribute("aria-busy", "true");
  details
    .querySelectorAll("button")
    .forEach((button) => (button.disabled = true));
  let deleted = false;
  try {
    await deleteTask(id);
    tasks = tasks.filter((task) => task.id !== id);
    render();
    deleted = true;
  } catch (error) {
    showError($("taskDetailsError"), error.message);
  } finally {
    saving = false;
    details.setAttribute("aria-busy", "false");
    details
      .querySelectorAll("button")
      .forEach((button) => (button.disabled = false));
  }
  if (deleted) {
    await closeDetails();
    notify("کار حذف شد.");
  }
  if (reloadRequested) void loadTasks();
});

async function loadTasks() {
  if (saving || pending.size || loading) {
    reloadRequested = true;
    return;
  }
  reloadRequested = false;
  loading = true;
  const version = ++loadVersion;
  $("refreshTasks").disabled = true;
  $("taskBoard").setAttribute("aria-busy", "true");
  showError($("tasksError"));
  try {
    const result = await getTasks();
    if (version !== loadVersion) return;
    const unchanged = tasksLoaded && JSON.stringify(tasks) === JSON.stringify(result);
    tasks = result;
    if (!unchanged) render();
    $("tasksStatus").hidden = true;
  } catch (error) {
    if (version !== loadVersion) return;
    $("tasksStatus").hidden = true;
    showError($("tasksError"), error.message);
  } finally {
    loading = false;
    $("refreshTasks").disabled = false;
    $("taskBoard").setAttribute("aria-busy", "false");
    if (version !== loadVersion || reloadRequested) void loadTasks();
  }
}

function openForm(task = null) {
  if (curtain.open || closing) return;
  editingId = task?.id ?? null;
  $("taskForm").reset();
  $("taskTitle").setCustomValidity("");
  $("taskDate").setCustomValidity("");
  $("taskDate").value = formatJalaliInput(task?.date || todayKey());
  $("taskTitle").value = task?.title || "";
  $("taskDescription").value = task?.description || "";
  $("taskFormHeading").textContent = editingId ? "ویرایش کار" : "افزودن کار";
  $("submitTask").textContent = editingId ? "ذخیره تغییرات" : "ثبت";
  showError($("taskFormError"));
  formDialog.open($("taskTitle"));
}

function updateCurtainHeight() {
  formDialog.position();
}

async function closeForm() {
  if (saving || closing || !curtain.open) return;
  closing = true;
  const id = editingId;
  await formDialog.close();
  closing = false;
  editingId = null;
  ($(`task-card-${id}`) || $("addTask")).focus({ preventScroll: true });
}

$("taskTitle").addEventListener("input", () =>
  $("taskTitle").setCustomValidity(""),
);
$("taskDate").addEventListener("input", () =>
  $("taskDate").setCustomValidity(""),
);
$("taskForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving || closing) return;
  const title = $("taskTitle").value.trim();
  if (!title) {
    $("taskTitle").setCustomValidity("عنوان کار را وارد کنید.");
    $("taskTitle").reportValidity();
    return;
  }
  let date;
  try {
    date = normalizeJalaliDate($("taskDate").value);
    if (!date) throw new Error("تاریخ شمسی الزامی است.");
  } catch (error) {
    $("taskDate").setCustomValidity(error.message);
    $("taskDate").reportValidity();
    return;
  }
  saving = true;
  loadVersion++;
  showError($("taskFormError"));
  $("taskForm").setAttribute("aria-busy", "true");
  const controls = [
    ...$("taskForm").querySelectorAll("input, textarea, button"),
  ];
  controls.forEach((control) => (control.disabled = true));
  $("submitTask").textContent = "در حال ثبت...";
  let saved = false;
  try {
    const data = {
      date,
      title,
      description: $("taskDescription").value.trim(),
    };
    const task = editingId
      ? await updateTask(editingId, data)
      : await createTask(data);
    if (editingId)
      tasks = tasks.map((item) => (item.id === task.id ? task : item));
    else tasks.push(task);
    tasks.sort((a, b) => a.date.localeCompare(b.date) || b.id - a.id);
    render();
    $("tasksStatus").hidden = true;
    saved = true;
  } catch (error) {
    showError($("taskFormError"), error.message);
    updateCurtainHeight();
  } finally {
    saving = false;
    controls.forEach((control) => (control.disabled = false));
    $("submitTask").textContent = editingId ? "ذخیره تغییرات" : "ثبت";
    $("taskForm").setAttribute("aria-busy", "false");
  }
  if (saved) {
    const created = editingId === null;
    await closeForm();
    if (created) notify("کار اضافه شد.");
    // Refresh also recovers the board if its initial request failed.
    await loadTasks();
  } else if (reloadRequested) {
    await loadTasks();
  }
});
$("cancelTask").addEventListener("click", closeForm);
$("addTask").addEventListener("click", () => openForm());
$("refreshTasks").addEventListener("click", refreshData(loadTasks));

async function initialize() {
  if (!(await protectPage())) return;
  $("addTask").disabled = false;
  await loadTasks();
  onPageRefresh(loadTasks);
}
startPage(initialize);
