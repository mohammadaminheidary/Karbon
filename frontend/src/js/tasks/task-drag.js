// Keep native card dragging separate from opening a card's details.
export function initializeTaskDrag(board, { canDrag, onDrop }) {
  let draggedId = null;
  let source;
  let target;
  let suppressClickUntil = 0;

  function clearTarget() {
    target?.classList.remove("is-drag-over");
    target = undefined;
  }

  function reset() {
    if (draggedId !== null) suppressClickUntil = Date.now() + 250;
    clearTarget();
    source?.classList.remove("is-dragging");
    source = undefined;
    draggedId = null;
    board.classList.remove("is-dragging");
  }

  board.addEventListener(
    "click",
    (event) => {
      if (
        Date.now() < suppressClickUntil &&
        event.target.closest(".task-card")
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );

  function columnFor(event) {
    const column = event.target.closest(".tasks-column");
    return column && board.contains(column) ? column : null;
  }

  board.addEventListener("dragstart", (event) => {
    const card = event.target.closest(".task-card");
    if (!card || !board.contains(card)) return;
    const id = Number(card.dataset.taskId);
    if (
      event.target.closest("select, input, textarea, button, a") ||
      !canDrag(id)
    ) {
      event.preventDefault();
      return;
    }
    source = card;
    draggedId = id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(id));
    source.classList.add("is-dragging");
    board.classList.add("is-dragging");
  });

  board.addEventListener("dragover", (event) => {
    const column = columnFor(event);
    if (draggedId === null || !column || !canDrag(draggedId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (target !== column) {
      clearTarget();
      target = column;
      target.classList.add("is-drag-over");
    }
  });

  board.addEventListener("dragleave", (event) => {
    if (target && !target.contains(event.relatedTarget)) clearTarget();
  });

  board.addEventListener("drop", (event) => {
    const column = columnFor(event);
    const id = draggedId;
    if (id === null || !column) return;
    event.preventDefault();
    reset();
    if (canDrag(id)) onDrop(id, column.dataset.status);
  });
  board.addEventListener("dragend", reset);
  window.addEventListener("pagehide", reset);
}
