/**
 * Pure half of the plugin: the per-turn fold over session events and the
 * model-facing state line rendered from it.
 *
 * This module imports nothing so it can be run and tested without the host's
 * package graph. {@link module:index} owns the projection and prompt
 * registration.
 *
 * @module dsh-todo-discipline/state
 */

/** Steps without an update before the first reminder, and the reminder spacing after it. */
export const DEFAULT_STALE_STEPS = 8;

/**
 * Tools whose success means the model could have moved the list forward.
 *
 * Kept narrow on purpose: `bash` can write files too, but it is also how a
 * model reads, greps and tests, so reminding after every `bash` call would put
 * a notice in front of the model on nearly every step.
 */
export const WRITE_LIKE_TOOLS = Object.freeze(['write', 'edit', 'str_replace_editor']);

/**
 * How many times one turn may be steered back before the gate releases.
 *
 * The upstream planning plugin defaults to 20. Two is deliberate: a model that
 * has not moved the list after two pushes will not move it after twenty, and
 * every extra block spends a whole model round-trip.
 */
export const DEFAULT_GATE_MAX_BLOCKS = 2;

/** State before any event of the open turn. */
export const INITIAL_STATE = Object.freeze({ turnSteps: 0, lastWriteStep: null, compactions: 0 });

/**
 * Fold one committed event into the discipline state.
 *
 * The todo tool clears its own projection on `turn/start`, so this state is
 * scoped the same way: a new turn starts with no list and no staleness.
 * @param state - previous state.
 * @param event - committed session event.
 * @returns the next state, or the same object when nothing changed.
 */
export function foldDiscipline(state, event) {
  switch (event.type) {
    case 'turn/start':
      return INITIAL_STATE;
    case 'step/start': {
      const step = typeof event.data?.step === 'number' ? event.data.step : state.turnSteps;
      return step === state.turnSteps ? state : { ...state, turnSteps: step };
    }
    case 'todo/write':
      return state.lastWriteStep === state.turnSteps
        ? state
        : { ...state, lastWriteStep: state.turnSteps };
    case 'compaction/end':
      return event.data?.error === undefined
        ? { ...state, compactions: state.compactions + 1 }
        : state;
    default:
      return state;
  }
}

/** Rank one todo status for the summary line; unknown values count as pending. */
function statusOf(todo) {
  return todo?.status === 'completed' || todo?.status === 'in_progress' ? todo.status : 'pending';
}

/** Count one list by status and remember the first in-progress item. */
function tally(todos) {
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  let active;
  for (const todo of todos) {
    const status = statusOf(todo);
    counts[status] += 1;
    if (status === 'in_progress') active ??= todo;
  }
  return { total: todos.length, counts, active };
}

/**
 * Render the model-facing state line, or `''` when there is nothing to say.
 *
 * Stability rule: the output may depend on the list and on reminder *buckets*,
 * never on the raw step number. The loop admits a runtime-context snapshot only
 * when the joined text differs from the retained one
 * (`RuntimeContextProjection.project`), so a per-step countdown would spend a
 * user message on every single step.
 * @param todos - current list from the `todos` projection, or null/undefined.
 * @param state - folded discipline state for the open turn.
 * @param staleSteps - steps without an update before the reminder repeats.
 * @returns the state line, or `''` when the turn has no list.
 */
export function todoStateText(todos, state, staleSteps = DEFAULT_STALE_STEPS) {
  if (!Array.isArray(todos) || todos.length === 0) return '';
  const { total, counts, active } = tally(todos);
  const window = Math.max(1, Math.floor(staleSteps));
  // A list with no recorded write in this turn is measured from the turn start:
  // the projection is cleared on `turn/start`, so a list that exists without a
  // write either predates this plugin loading or was restored mid-turn, and in
  // both cases the model has gone the whole turn without reaffirming it.
  const since = state.lastWriteStep === null ? state.turnSteps : Math.max(0, state.turnSteps - state.lastWriteStep);
  const bucket = Math.floor(since / window) * window;

  const lines = [];
  if (counts.completed === total) {
    lines.push(
      `Todo list: all ${String(total)} items completed. Report the result to the user now; do not end the turn silently.`,
    );
  } else {
    const parts = [`${String(counts.completed)} of ${String(total)} done`];
    if (active !== undefined) parts.push(`in progress: ${JSON.stringify(String(active.content ?? ''))}`);
    else parts.push(`${String(counts.in_progress)} in progress`);
    if (counts.pending > 0) parts.push(`${String(counts.pending)} pending`);
    lines.push(`Todo list (restated from the session log): ${parts.join(', ')}.`);
  }
  if (bucket > 0) {
    lines.push(
      `The list has not been updated for ${String(bucket)} steps. Call todo_write before the next tool call: mark what you finished \`completed\` and what you are starting \`in_progress\`.`,
    );
  }
  if (state.compactions > 0) {
    lines.push(
      `This restatement follows ${String(state.compactions)} context compaction${state.compactions === 1 ? '' : 's'} in this turn; the list may be absent from your visible history, so continue from this line.`,
    );
  }
  return lines.join(' ');
}

/**
 * Whether one tool name is a write-like tool.
 * @param name - the tool name from the execution, possibly absent.
 * @returns true when a successful call could have moved the list forward.
 */
export function isWriteLike(name) {
  return typeof name === 'string' && WRITE_LIKE_TOOLS.includes(name);
}

/**
 * Whether the list still has work the model promised but has not finished.
 * @param todos - candidate list; anything that is not a non-empty array is done.
 * @returns true when at least one item is not `completed`.
 */
export function hasUnfinished(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return false;
  return todos.some((todo) => statusOf(todo) !== 'completed');
}

/**
 * Fingerprint the list by its content and status only.
 *
 * The gate releases on a stalled list, and "stalled" means the model did not
 * change what it promised — not that no metadata field moved. Item ids and
 * timestamps are therefore excluded.
 * @param todos - candidate list.
 * @returns a stable string, or `''` when there is no list.
 */
export function listFingerprint(todos) {
  if (!Array.isArray(todos)) return '';
  return JSON.stringify(todos.map((todo) => [String(todo?.content ?? ''), statusOf(todo)]));
}

/** Render the progress phrase shared by the two reminders. */
function progressPhrase({ total, counts, active }) {
  const parts = [`${String(counts.completed)} of ${String(total)} done`];
  if (active !== undefined) parts.push(`in progress: ${JSON.stringify(String(active.content ?? ''))}`);
  else if (counts.in_progress > 0) parts.push(`${String(counts.in_progress)} in progress`);
  if (counts.pending > 0) parts.push(`${String(counts.pending)} pending`);
  return parts.join(', ');
}

/**
 * Render the reminder attached to a successful write-like tool result.
 * @param todos - current list, known to have unfinished work.
 * @returns one sentence naming the tool and the remaining work.
 */
export function writeReminderText(todos) {
  return `Todo list not yet updated for this step. You just finished a write-like tool call; if that step is done, call todo_write now — ${progressPhrase(tally(todos))}.`;
}

/**
 * Render the steering message that keeps the turn open.
 * @param todos - current list, known to have unfinished work.
 * @param blocks - how many times this turn has already been steered back.
 * @param max - the configured budget; the block that reaches it is the last.
 * @returns the steering text, including a release notice on the last attempt.
 */
export function gateText(todos, blocks, max) {
  const head = `Todo list still has unfinished work (${progressPhrase(tally(todos))}). The turn cannot close until every item is completed or the list is rewritten to match reality.`;
  return blocks + 1 >= max ? `${head} This is the last attempt before the gate releases; the turn will close anyway.` : head;
}
