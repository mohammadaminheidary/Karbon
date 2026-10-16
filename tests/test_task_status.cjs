const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

// Exercise the page's shared drop/select mutation with deferred API responses.
const source = fs.readFileSync(
  path.join(__dirname, "../src/js/page/daily-tasks.js"),
  "utf8",
);
const mutation = source.slice(
  source.indexOf("async function changeStatus("),
  source.indexOf("initializeTaskDrag($("),
);

function scenario() {
  let resolve, reject;
  const request = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  const calls = [],
    renders = [],
    errors = [];
  const context = {
    tasks: [
      { id: 1, status: "todo" },
      { id: 2, status: "completed" },
    ],
    pending: new Set(),
    labels: {
      todo: "To Do",
      in_progress: "In Progress",
      completed: "Completed",
    },
    loadVersion: 0,
    reloadRequested: false,
    $: () => ({}),
    showError: (_, message) => errors.push(message),
    notify() {},
    render: () => renders.push(context.tasks.map((task) => task.status)),
    updateTaskStatus: (...args) => {
      calls.push(args);
      return request;
    },
  };
  vm.runInNewContext(mutation, context);
  return { context, calls, renders, errors, resolve, reject };
}

async function run() {
  const success = scenario();
  const saved = success.context.changeStatus(1, "in_progress");
  assert.deepEqual(
    success.renders[0],
    ["in_progress", "completed"],
    "drop moves the card before the API responds",
  );
  assert.equal(success.context.pending.has(1), true);
  await success.context.changeStatus(1, "completed");
  assert.equal(
    success.calls.length,
    1,
    "a pending card cannot be submitted twice",
  );
  success.resolve({ id: 1, status: "in_progress" });
  await saved;
  assert.equal(success.context.pending.size, 0);
  assert.equal(success.context.tasks[0].status, "in_progress");

  const failure = scenario();
  const failed = failure.context.changeStatus(1, "completed");
  assert.equal(failure.context.tasks[0].status, "completed");
  failure.reject(new Error("Save failed"));
  await failed;
  assert.equal(
    failure.context.tasks[0].status,
    "todo",
    "failed saves restore the source column and counts",
  );
  assert.equal(
    failure.context.tasks[1].status,
    "completed",
    "rollback leaves other cards alone",
  );
  assert.equal(failure.context.pending.size, 0);
  assert.equal(failure.errors.at(-1), "Save failed");

  const ignored = scenario();
  await ignored.context.changeStatus(1, "todo");
  await ignored.context.changeStatus(1, "invalid");
  await ignored.context.changeStatus(999, "completed");
  assert.equal(
    ignored.calls.length,
    0,
    "same-column and invalid drops do not persist changes",
  );
  console.log(
    "Task status checks passed: immediate moves, persistence, duplicate guards, rollback, and ignored drops.",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
