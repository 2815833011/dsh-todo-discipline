/**
 * Keep the todo list alive across a long DSH turn.
 *
 * Two independent failures make a long task look abandoned:
 *
 * 1. The list is written once and never updated. `todo_write` is a whole-list
 *    replacement appended to the session, so the last write wins — a model that
 *    calls it once leaves every later step invisible, and the panel keeps
 *    naming step one while the work has moved on.
 * 2. Context compaction removes the list from the model's history. The `todos`
 *    session projection still folds it out of the event log, so the UI keeps
 *    rendering a list the model can no longer see; the model has no way to know
 *    it ever planned anything.
 *
 * This plugin addresses both halves the only way a host-side plugin can:
 *
 * - a standing policy in the system prompt, which is a system message and is
 *   therefore never summarized away, telling the model what the list is for;
 * - a runtime-context state line restated from the projection, so the list
 *   comes back in front of the model after compaction and when it has gone stale.
 *
 * The state line is deliberately stable between events. The loop re-renders
 * every context provider on every step and admits a new snapshot only when the
 * joined text differs from the retained one
 * (`RuntimeContextProjection.project` in dsh-agent-loop), so a line that
 * printed a per-step countdown would cost a user message on every step.
 *
 * The plugin imports nothing. A profile installs it with `pnpm add
 * link:<dir>`, so this file is reached through its real path and bare imports
 * of packages that exist only under the profile's `node_modules` would not
 * resolve; the projection schema is hand-written in `./schema.js` for the same
 * reason.
 *
 * @module dsh-todo-discipline
 */

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_GATE_MAX_BLOCKS,
  DEFAULT_STALE_STEPS,
  INITIAL_STATE,
  foldDiscipline,
  gateText,
  hasUnfinished,
  isWriteLike,
  listFingerprint,
  todoStateText,
  writeReminderText,
} from './state.js';
import { disciplineStateSchema } from './schema.js';

/** Stable Cordis plugin name used by loader diagnostics. */
export const name = 'todo-discipline';

/** Prompt registries plus the session projections the state line reads. */
export const inject = ['systemPrompt', 'sessionProjections'];

/** Projection key owned by this plugin. */
const STATE_KEY = 'todoDiscipline';

/** Projection key the todo tool owns; read here, never written. */
const TODOS_KEY = 'todos';

/** Prompt-section name for the standing policy. */
const POLICY_SECTION = 'todo:policy';

/** Runtime-context name for the restated state line. */
const STATE_CONTEXT = 'todo:state';

/**
 * Placement of the policy inside the model-facing prompt.
 *
 * It sits after the deployment persona (0) and before the plan (500) and team
 * (600) policies: a working rule, not a persona.
 */
const POLICY_ORDER = 400;

/**
 * Placement inside the "Current runtime context" snapshot.
 *
 * `CONTEXT_ORDERS` puts working directory (100), sandbox (110), approval (115),
 * subagent delegation (120) and team identity (125) ahead of the harness/web
 * orientation (200/210). A todo restatement belongs with the first group, and
 * 130 keeps it after the team identity.
 */
const STATE_ORDER = 130;

/**
 * Bound for a `form: 'notice'` summary.
 *
 * Mirrors `CONTEXT_SUMMARY_MAX_CHARS` from dsh-llm, which this plugin cannot
 * import: the profile installs it through a `link:` symlink, so bare
 * `@deepseek-ai/*` specifiers resolve against the plugin's real path and fail
 * with ERR_MODULE_NOT_FOUND. Keep in sync if the kernel changes its bound; an
 * over-long summary is truncated rather than rejected, so drift is cosmetic.
 */
const SUMMARY_MAX_CHARS = 120;

/**
 * The standing policy. Constant text: identical on every request, or the system
 * prompt changes shape mid-conversation for no gain.
 *
 * Every paragraph answers a failure seen in practice — a list never updated, a
 * list re-planned from scratch after compaction, and a turn that ends without
 * telling the user what happened.
 */
const POLICY_TEXT = [
  'The todo list is a promise to the user, not a note. A list you never update is worse than no list: it tells the user that work is still in progress which you finished or abandoned long ago.',
  'Keep it current. Before starting a new step, call todo_write with the complete list, marking the item you just finished `completed` and the item you are starting `in_progress`. If the work no longer matches the list, rewrite it from scratch rather than appending.',
  'Long turns lose the list from your history when the context is compacted. The runtime context restates the current list; trust that restatement and continue from it instead of re-planning the work.',
  'Say one short sentence about what you are about to do before a batch of tool calls, so the user can follow the work without reading tool output. When every item is completed, report the result in your own words instead of ending the turn silently. A turn that ends with unfinished items is steered back before it closes, so either finish them or rewrite the list before stopping.',
].join('\n\n');

/** Read a positive integer option, falling back when the value is unusable. */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Build one plugin-sourced user message.
 *
 * The `id` is not optional: the loop de-duplicates pending inbox messages by
 * identity (`dsh-agent-loop`, `if (ids.has(message.id)) throw new Error(...)`),
 * so a message without one passes once and throws on the second delivery.
 *
 * The source kind must be a PRODUCER-OWNED kind, never `{ kind: 'plugin' }`.
 * Session format v4 refuses that wrapper outright — "format v4 message requires
 * a producer-owned source kind" (dsh-session-format-v3-to-v4, `message-sources.js`)
 * — and the failure surfaces as a dead turn, not as a caught error. The
 * kernel's own injectors flatten the same way for the same reason: see
 * dsh-repeat-tool-reminder's `const REMINDER_SOURCE = { kind: 'repeat-tool-reminder' }`.
 *
 * `form: 'notice'` plus a one-line `summary` is what makes the row render as an
 * injected context row instead of a user prompt; an unlabeled injection renders
 * as a user message in derived history.
 * @param text - the model-facing message body.
 * @param summary - the one-line account shown without expanding the row.
 * @returns an identified, plugin-sourced user message.
 */
function pluginMessage(text, summary) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: name, form: 'notice', summary: summary.slice(0, SUMMARY_MAX_CHARS) },
    id: randomUUID(),
  };
}

/**
 * Register the policy section and the restated state line.
 * @param ctx - plugin context carrying every {@link inject} service.
 * @param config - optional `{ enabled?: boolean, staleSteps?: number }`; omission selects the defaults.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const staleSteps = positiveInteger(config.staleSteps, DEFAULT_STALE_STEPS);
  const gate = config.gate !== false;
  const gateMaxBlocks = positiveInteger(config.gateMaxBlocks, DEFAULT_GATE_MAX_BLOCKS);

  ctx.sessionProjections.register({
    key: STATE_KEY,
    stateVersion: 1,
    stateSchema: disciplineStateSchema,
    init: () => INITIAL_STATE,
    apply: foldDiscipline,
  });

  ctx.systemPrompt.section({
    name: POLICY_SECTION,
    order: POLICY_ORDER,
    interpolate: false,
    text: POLICY_TEXT,
  });

  ctx.systemPrompt.context({
    name: STATE_CONTEXT,
    order: STATE_ORDER,
    interpolate: false,
    text: (context) => {
      const session = context?.agent?.session;
      if (session === undefined) return '';
      const todos = ctx.sessionProjections.stateOf(session, TODOS_KEY);
      if (todos === undefined) return '';
      const state = ctx.sessionProjections.stateOf(session, STATE_KEY) ?? INITIAL_STATE;
      return todoStateText(todos, state, staleSteps);
    },
  });

  /**
   * Steps already reminded in this session, keyed `${sessionId}#${step}`.
   *
   * Volatile on purpose: this is a per-step de-duplication, and the projection
   * next to it is durable folded state that must stay a pure function of the
   * event log. Persisting a reminder that did or did not happen would make the
   * projection depend on plugin load order.
   */
  const reminded = new Set();

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const downstream = await next();
    const session = exec.agent?.session;
    if (session === undefined || !isWriteLike(exec.name)) return downstream;
    const todos = ctx.sessionProjections.stateOf(session, TODOS_KEY);
    if (!hasUnfinished(todos)) return downstream;
    const state = ctx.sessionProjections.stateOf(session, STATE_KEY) ?? INITIAL_STATE;
    const key = `${session.id}#${String(state.turnSteps)}`;
    if (reminded.has(key)) return downstream;
    if (reminded.size > 200) reminded.clear();
    reminded.add(key);
    return {
      ...downstream,
      additionalContexts: [pluginMessage(writeReminderText(todos), `todo list not updated · ${exec.name}`), ...(downstream.additionalContexts ?? [])],
    };
  });

  if (gate) {
    /**
     * Per-session gate budget: `{ turn, blocks, fingerprint }`.
     *
     * Keyed on the turn number, which is the right reset boundary: a steered
     * continuation keeps running inside the same turn (`dsh-agent-loop` breaks
     * its step loop only when `turnEnds && inbox.nextStep.length === 0`, and a
     * steer fills that inbox), so blocks accumulate across continuations of one
     * turn. A new user turn increments `turn` (`const turn = phase.turn + 1`),
     * which is exactly when the budget should start over.
     *
     * Volatile for the same reason `reminded` is: a durable record of a block
     * that did or did not fire would make replay depend on plugin load order.
     */
    const gates = new Map();

    ctx.on('agent/turn-stopping', ({ agent, turn }) => {
      const session = agent?.session;
      if (session === undefined) return;
      const header = session.header;
      if (header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0) return;
      const todos = ctx.sessionProjections.stateOf(session, TODOS_KEY);
      if (!hasUnfinished(todos)) return;
      if (gates.size > 200) gates.clear();
      const previous = gates.get(session.id);
      const entry = previous?.turn === turn ? previous : { turn, blocks: 0, fingerprint: '' };
      if (entry.blocks >= gateMaxBlocks) return;
      const fingerprint = listFingerprint(todos);
      // A model that resubmits the same list has not moved; releasing here is
      // what keeps the gate from spending the budget on a model that is stuck
      // rather than merely slow. The entry is left untouched, so the same
      // unchanged list keeps releasing until the model actually edits it.
      if (fingerprint === entry.fingerprint) return;
      gates.set(session.id, { turn, blocks: entry.blocks + 1, fingerprint });
      agent.steer(
        pluginMessage(
          gateText(todos, entry.blocks, gateMaxBlocks),
          `todo list has unfinished work · block ${String(entry.blocks + 1)} of ${String(gateMaxBlocks)}`,
        ),
      );
    });
  }
}
