/**
 * Offline host-half test: drive the real `apply()` with a stand-in Cordis
 * context, then check the two things the plugin is responsible for.
 *
 * 1. The policy section is registered once, at a fixed order, with text that
 *    never changes — a section whose text varies would rewrite the system
 *    prompt mid-conversation.
 * 2. The runtime-context line is empty until the session has a list, tracks the
 *    list, and — critically — is *stable* between steps. The loop admits a
 *    snapshot only when the joined context text changes, so a line that moved
 *    on every step would inject a user message on every step.
 *
 * Run with: node test-host.mjs
 */

import { apply, inject, name } from './index.js';

let failures = 0;

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}\n     actual   ${JSON.stringify(actual)}`);
}

function checkTruthy(label, value) {
  const ok = Boolean(value);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

/** Fold one committed event into every registered projection, in registration order. */
function foldEvent(registry, session, event) {
  for (const registration of registry.registrations.values()) {
    const state = registration.states.get(session) ?? registration.def.init();
    registration.states.set(session, registration.def.apply(state, event));
  }
}

/**
 * Build the smallest stand-in for the Host context this plugin uses:
 * `systemPrompt.section`, `systemPrompt.context` and `sessionProjections`.
 */
function createHost() {
  const registrations = new Map();
  const sections = [];
  const contexts = [];
  const listeners = new Map();
  const steered = [];
  const session = { id: 's1', header: { origin: undefined, delegationDepth: 0 } };
  const agent = {
    session,
    steer(message) {
      steered.push(message);
    },
  };

  const registry = {
    registrations,
    register(definition) {
      if (!Number.isSafeInteger(definition.stateVersion)) throw new Error('stateVersion must be an integer');
      registrations.set(definition.key, { def: definition, states: new Map() });
      return () => registrations.delete(definition.key);
    },
    stateOf(target, key) {
      const registration = registrations.get(key);
      if (registration === undefined) return undefined;
      return registration.states.get(target);
    },
  };

  const systemPrompt = {
    section(definition) {
      sections.push(definition);
      return () => {};
    },
    context(definition) {
      contexts.push(definition);
      return () => {};
    },
  };

  const on = (event, handler) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(handler);
    return () => {};
  };

  const ctx = { systemPrompt, sessionProjections: registry, on };
  return {
    ctx,
    session,
    agent,
    steered,
    sections,
    contexts,
    registry,
    listeners,
    fold: (event) => foldEvent(registry, session, event),
  };
}

/** Render the plugin's context contribution the way the loop does. */
function renderState(host) {
  const entry = host.contexts.find((candidate) => candidate.name === 'todo:state');
  if (entry === undefined) return undefined;
  return typeof entry.text === 'function' ? entry.text({ agent: { session: host.session } }) : entry.text;
}

/**
 * Dispatch one hook the way the host does: a waterfall whose terminal `next()`
 * resolves with the innermost decision. A handler that never calls `next()`
 * hides every later handler, which is exactly what a test should catch.
 */
async function runHook(host, event, ...args) {
  const handlers = host.listeners.get(event) ?? [];
  let index = 0;
  const next = async () => {
    const handler = handlers[index];
    index += 1;
    if (handler === undefined) return { kind: 'accept' };
    return handler(...args, next);
  };
  return next();
}

// --- registration ---------------------------------------------------------

checkTruthy('the plugin declares its name', name === 'todo-discipline');
check('the plugin injects the prompt registry and projections', inject.join(','), 'systemPrompt,sessionProjections');

{
  const host = createHost();
  // The todo tool's own projection, as the host would already have it.
  host.registry.register({
    key: 'todos',
    stateVersion: 2,
    stateSchema: { parse: (value) => value },
    init: () => null,
    apply: (state, event) => (event.type === 'todo/write' ? event.data.todos : event.type === 'turn/start' ? null : state),
  });
  apply(host.ctx, {});

  check('one policy section is registered', host.sections.length, 1);
  check('one context line is registered', host.contexts.length, 1);
  check('the policy is placed between persona and plan policy', host.sections[0].order, 400);
  check('the state line follows the team identity context', host.contexts[0].order, 130);

  const policy = host.sections[0].text;
  checkTruthy('the policy forbids a stale list', /never update is worse than no list/.test(policy));
  checkTruthy('the policy names the tool', policy.includes('todo_write'));
  checkTruthy('the policy explains the compaction restatement', policy.includes('restates the current list'));
  checkTruthy('the policy asks for a closing report', policy.includes('report the result'));
  // The policy must not promise a specific number of blocks: gateMaxBlocks is
  // configurable, so a hard count in the prompt would go stale.
  checkTruthy('the policy says unfinished turns are steered back', policy.includes('steered back'));
  check('the policy promises no fixed block count', policy.includes('steered back once'), false);
  check('the policy is literal text, not interpolated', host.sections[0].interpolate, false);

  // --- empty session ------------------------------------------------------
  check('a session with no list renders nothing', renderState(host), '');

  // --- the model plans ----------------------------------------------------
  host.fold({ type: 'turn/start', data: { turn: 1 } });
  check('a new turn still has no list', renderState(host), '');

  host.fold({ type: 'step/start', data: { turn: 1, step: 1 } });
  host.fold({
    type: 'todo/write',
    data: {
      todos: [
        { content: 'read the loader', status: 'in_progress' },
        { content: 'rewrite it', status: 'pending' },
      ],
    },
  });
  const first = renderState(host);
  checkTruthy('the list appears once written', first.includes('0 of 2 done'));
  checkTruthy('the active item is named', first.includes('read the loader'));

  // --- the stability rule -------------------------------------------------
  // Seven more steps without a write stay inside the first reminder window, so
  // the rendered text must be byte-identical. This is what keeps the loop from
  // admitting a fresh runtime-context snapshot on every step.
  const seen = new Set([first]);
  for (let step = 2; step <= 8; step += 1) {
    host.fold({ type: 'step/start', data: { turn: 1, step } });
    seen.add(renderState(host));
  }
  check('eight steps without an update render one unchanged line', seen.size, 1);

  // --- the reminder fires once per window ---------------------------------
  host.fold({ type: 'step/start', data: { turn: 1, step: 9 } });
  const nudged = renderState(host);
  checkTruthy('the reminder appears at the window boundary', nudged.includes('has not been updated for 8 steps'));
  const afterNudge = new Set([nudged]);
  for (let step = 10; step <= 16; step += 1) {
    host.fold({ type: 'step/start', data: { turn: 1, step } });
    afterNudge.add(renderState(host));
  }
  check('the reminder itself is stable inside its window', afterNudge.size, 1);

  // --- an update silences the reminder ------------------------------------
  host.fold({ type: 'step/start', data: { turn: 1, step: 17 } });
  host.fold({
    type: 'todo/write',
    data: {
      todos: [
        { content: 'read the loader', status: 'completed' },
        { content: 'rewrite it', status: 'in_progress' },
      ],
    },
  });
  const updated = renderState(host);
  checkTruthy('an update moves the counter', updated.includes('1 of 2 done'));
  checkTruthy('an update is noticed by the loop', updated !== nudged);
  check('an update clears the reminder', updated.includes('has not been updated'), false);

  // --- compaction ---------------------------------------------------------
  // The list survives in the projection while the history loses it, so the
  // line must change — that difference is what re-admits the snapshot.
  const beforeCompaction = updated;
  host.fold({ type: 'compaction/end', data: { compactionId: 'c1' } });
  const afterCompaction = renderState(host);
  checkTruthy('a compaction is announced', afterCompaction.includes('1 context compaction in this turn'));
  checkTruthy('a compaction re-admits the snapshot', afterCompaction !== beforeCompaction);
  checkTruthy('the list survives the compaction', afterCompaction.includes('1 of 2 done'));

  // --- the next turn resets ----------------------------------------------
  host.fold({ type: 'turn/start', data: { turn: 2 } });
  check('the next turn starts with no list', renderState(host), '');
}

// --- disabled -------------------------------------------------------------

{
  const host = createHost();
  apply(host.ctx, { enabled: false });
  check('a disabled plugin registers no section', host.sections.length, 0);
  check('a disabled plugin registers no context', host.contexts.length, 0);
  check('a disabled plugin registers no projection', host.registry.registrations.size, 0);
}

// --- configurable window --------------------------------------------------

{
  const host = createHost();
  host.registry.register({
    key: 'todos',
    stateVersion: 2,
    stateSchema: { parse: (value) => value },
    init: () => null,
    apply: (state, event) => (event.type === 'todo/write' ? event.data.todos : event.type === 'turn/start' ? null : state),
  });
  apply(host.ctx, { staleSteps: 3 });
  host.fold({ type: 'turn/start', data: { turn: 1 } });
  host.fold({ type: 'step/start', data: { turn: 1, step: 1 } });
  host.fold({ type: 'todo/write', data: { todos: [{ content: 'a', status: 'in_progress' }] } });
  for (let step = 2; step <= 4; step += 1) host.fold({ type: 'step/start', data: { turn: 1, step } });
  checkTruthy('a configured window of 3 nags three steps after the write', renderState(host).includes('has not been updated for 3 steps'));
}

// --- the post-execute reminder -------------------------------------------

{
  const host = createHost();
  host.registry.register({
    key: 'todos',
    stateVersion: 2,
    stateSchema: { parse: (value) => value },
    init: () => null,
    apply: (state, event) => (event.type === 'todo/write' ? event.data.todos : event.type === 'turn/start' ? null : state),
  });
  apply(host.ctx, {});
  host.fold({ type: 'turn/start', data: { turn: 1 } });
  host.fold({ type: 'step/start', data: { turn: 1, step: 1 } });
  host.fold({ type: 'todo/write', data: { todos: [{ content: 'rewrite it', status: 'in_progress' }] } });

  const exec = (toolName) => ({
    callId: 'c1',
    name: toolName,
    arguments: {},
    agent: host.agent,
    signal: new AbortController().signal,
  });
  /** The second hook argument is the raw execution result, not a decision. */
  const RESULT = { content: [] };

  const notWrite = await runHook(host, 'tools/post-execute', exec('bash'), RESULT);
  check('a non-write tool gets no reminder', notWrite.additionalContexts, undefined);

  const written = await runHook(host, 'tools/post-execute', exec('write'), RESULT);
  check('a write with an unfinished list gets one reminder', written.additionalContexts.length, 1);
  checkTruthy('the reminder names the tool', written.additionalContexts[0].content[0].text.includes('todo_write'));
  check('the reminder is plugin-sourced', written.additionalContexts[0].source.kind, 'todo-discipline');
  // Session format v4 refuses the retired plugin wrapper: a source kind of
  // 'plugin' turns the turn into "format v4 message requires a producer-owned
  // source kind" and the conversation dies. Assert the absence directly, so a
  // regression here fails a unit test instead of a live session.
  check('the reminder source is not the retired plugin wrapper', written.additionalContexts[0].source.kind === 'plugin', false);
  check('the reminder source declares a notice form', written.additionalContexts[0].source.form, 'notice');
  checkTruthy('the reminder summary is bounded', written.additionalContexts[0].source.summary.length <= 120);
  checkTruthy(
    'the reminder carries an id',
    typeof written.additionalContexts[0].id === 'string' && written.additionalContexts[0].id.length > 0,
  );

  const again = await runHook(host, 'tools/post-execute', exec('edit'), RESULT);
  check('the same step gets no second reminder', again.additionalContexts, undefined);

  host.fold({ type: 'step/start', data: { turn: 1, step: 2 } });
  const nextStep = await runHook(host, 'tools/post-execute', exec('edit'), RESULT);
  check('a new step gets a fresh reminder', nextStep.additionalContexts.length, 1);

  host.fold({ type: 'todo/write', data: { todos: [{ content: 'rewrite it', status: 'completed' }] } });
  host.fold({ type: 'step/start', data: { turn: 1, step: 3 } });
  const done = await runHook(host, 'tools/post-execute', exec('write'), RESULT);
  check('a completed list gets no reminder', done.additionalContexts, undefined);

  // An execution with no agent (PTC sub-dispatch) must pass straight through.
  const anonymous = { callId: 'c2', name: 'write', arguments: {}, signal: new AbortController().signal };
  const orphan = await runHook(host, 'tools/post-execute', anonymous, RESULT);
  check('an execution with no agent is untouched', orphan.additionalContexts, undefined);
  check('an execution with no agent still returns a decision', orphan.kind, 'accept');
}

// --- a downstream block keeps its feedback and gains our context ---------

{
  const host = createHost();
  host.registry.register({
    key: 'todos',
    stateVersion: 2,
    stateSchema: { parse: (value) => value },
    init: () => null,
    apply: (state, event) => (event.type === 'todo/write' ? event.data.todos : event.type === 'turn/start' ? null : state),
  });
  apply(host.ctx, {});
  // Registered AFTER the plugin, so the plugin's handler runs first and its
  // `next()` lands on this one — that is what a real downstream veto looks like.
  host.listeners.get('tools/post-execute').push(async () => ({
    kind: 'block',
    feedback: [{ type: 'text', text: 'no' }],
  }));
  host.fold({ type: 'turn/start', data: { turn: 1 } });
  host.fold({ type: 'step/start', data: { turn: 1, step: 1 } });
  host.fold({ type: 'todo/write', data: { todos: [{ content: 'rewrite it', status: 'in_progress' }] } });
  const exec = (toolName) => ({
    callId: 'c1',
    name: toolName,
    arguments: {},
    agent: host.agent,
    signal: new AbortController().signal,
  });

  const blocked = await runHook(host, 'tools/post-execute', exec('write'), { content: [] });
  check('a blocked decision keeps its kind', blocked.kind, 'block');
  check('a blocked decision keeps its feedback', blocked.feedback[0].text, 'no');
  check('a blocked decision still gains the reminder', blocked.additionalContexts.length, 1);
}

// --- the turn-stopping gate ----------------------------------------------

{
  const host = createHost();
  host.registry.register({
    key: 'todos',
    stateVersion: 2,
    stateSchema: { parse: (value) => value },
    init: () => null,
    apply: (state, event) => (event.type === 'todo/write' ? event.data.todos : event.type === 'turn/start' ? null : state),
  });
  apply(host.ctx, {});
  const stop = (turn = 1) =>
    runHook(host, 'agent/turn-stopping', { agent: host.agent, turn, signal: new AbortController().signal });

  // No list at all: the gate has nothing to say.
  host.fold({ type: 'turn/start', data: { turn: 1 } });
  await stop();
  check('a turn with no list is not steered', host.steered.length, 0);

  // A completed list: the model is done.
  host.fold({ type: 'step/start', data: { turn: 1, step: 1 } });
  host.fold({ type: 'todo/write', data: { todos: [{ content: 'a', status: 'completed' }] } });
  await stop();
  check('a completed list is not steered', host.steered.length, 0);

  // An unfinished list: steered once, with an id and the remaining work.
  host.fold({
    type: 'todo/write',
    data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] },
  });
  await stop();
  check('an unfinished list is steered once', host.steered.length, 1);
  checkTruthy('the steering names the work left', host.steered[0].content[0].text.includes('"b"'));
  check('the steering is plugin-sourced', host.steered[0].source.kind, 'todo-discipline');
  check('the steering source is not the retired plugin wrapper', host.steered[0].source.kind === 'plugin', false);
  check('the steering source declares a notice form', host.steered[0].source.form, 'notice');
  checkTruthy('the steering carries an id', typeof host.steered[0].id === 'string' && host.steered[0].id.length > 0);

  // Same list again: stall release, no second steering.
  await stop();
  check('an unchanged list releases the gate', host.steered.length, 1);

  // The list moved but still is not done: one more block, and it is the last.
  host.fold({
    type: 'todo/write',
    data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] },
  });
  await stop();
  check('progress earns one more block', host.steered.length, 2);
  checkTruthy('the last block announces the release', host.steered[1].content[0].text.includes('will close anyway'));

  host.fold({
    type: 'todo/write',
    data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] },
  });
  await stop();
  check('the budget releases the gate', host.steered.length, 2);

  // A new turn resets the budget.
  host.fold({ type: 'turn/start', data: { turn: 2 } });
  host.fold({ type: 'step/start', data: { turn: 2, step: 1 } });
  host.fold({ type: 'todo/write', data: { todos: [{ content: 'c', status: 'pending' }] } });
  await stop(2);
  check('the next turn gets a fresh budget', host.steered.length, 3);
}

// --- the gate leaves subagents alone -------------------------------------

{
  const host = createHost();
  host.agent.session.header = { origin: 'subagent', delegationDepth: 1 };
  host.registry.register({
    key: 'todos',
    stateVersion: 2,
    stateSchema: { parse: (value) => value },
    init: () => null,
    apply: (state, event) => (event.type === 'todo/write' ? event.data.todos : event.type === 'turn/start' ? null : state),
  });
  apply(host.ctx, {});
  host.fold({ type: 'turn/start', data: { turn: 1 } });
  host.fold({ type: 'step/start', data: { turn: 1, step: 1 } });
  host.fold({ type: 'todo/write', data: { todos: [{ content: 'a', status: 'pending' }] } });
  await runHook(host, 'agent/turn-stopping', { agent: host.agent, turn: 1, signal: new AbortController().signal });
  check('a subagent turn is never steered', host.steered.length, 0);
}

// --- the gate can be turned off ------------------------------------------

{
  const host = createHost();
  host.registry.register({
    key: 'todos',
    stateVersion: 2,
    stateSchema: { parse: (value) => value },
    init: () => null,
    apply: (state, event) => (event.type === 'todo/write' ? event.data.todos : event.type === 'turn/start' ? null : state),
  });
  apply(host.ctx, { gate: false });
  host.fold({ type: 'turn/start', data: { turn: 1 } });
  host.fold({ type: 'step/start', data: { turn: 1, step: 1 } });
  host.fold({ type: 'todo/write', data: { todos: [{ content: 'a', status: 'pending' }] } });
  await runHook(host, 'agent/turn-stopping', { agent: host.agent, turn: 1, signal: new AbortController().signal });
  check('gate: false disables the steering', host.steered.length, 0);
}

console.log(failures === 0 ? '\nOK: host half registers and renders as intended' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
