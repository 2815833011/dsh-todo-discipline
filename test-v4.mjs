/**
 * Admit this plugin's injected messages through the kernel's own v4 validator.
 *
 * The unit tests in test-host.mjs assert the shape we intended; this file
 * asserts the shape the *kernel accepts*. They are not the same test: the
 * `{kind:'plugin', plugin}` wrapper passed every local assertion we wrote and
 * still killed a live conversation with
 *   "format v4 message requires a producer-owned source kind".
 * The lesson is that a hand-written assertion can only encode what its author
 * already believes — so the admission rule has to come from the kernel.
 *
 * Run: node test-v4.mjs
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

/**
 * Find the kernel's v4 migrator without assuming one install layout.
 *
 * Two layouts exist on this machine: the profile's flat `node_modules`, and
 * the npx cache the profile packages symlink into, which nests installs one
 * level down under a hash directory. Only the migrator's own file is imported,
 * so a miss is silent and the caller decides what to do about it.
 */
function findValidator() {
  const direct = join(
    os.homedir(),
    '.dsh',
    'profiles',
    'node_modules',
    '@deepseek-ai',
    'dsh-session-format-v3-to-v4',
    'lib',
    'index.js',
  );
  if (existsSync(direct)) return direct;
  const cache = join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  if (!existsSync(cache)) return null;
  for (const entry of readdirSync(cache)) {
    const candidate = join(cache, entry, 'node_modules', '@deepseek-ai', 'dsh-session-format-v3-to-v4', 'lib', 'index.js');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const target = findValidator();
if (target === null) {
  console.log('SKIP: the kernel v4 migrator is not installed on this machine');
  console.log('(this check needs @deepseek-ai/dsh-session-format-v3-to-v4)');
  process.exit(0);
}

const { assertV4RowAdmission } = await import(pathToFileURL(target).href);
const plugin = await import(new URL('./index.js', import.meta.url).href);

let failures = 0;
const check = (label, actual, expected) => {
  if (!Object.is(actual, expected)) {
    failures += 1;
    console.log(`FAIL ${label}: got ${String(actual)}, want ${String(expected)}`);
  } else console.log(`ok   ${label}`);
};

// --- drive the plugin to produce one message of each kind -----------------

const listeners = new Map();
const registrations = new Map();
const session = { id: 'v4', header: { origin: undefined, delegationDepth: 0 } };
const steered = [];
const ctx = {
  systemPrompt: { section: () => {}, context: () => {} },
  sessionProjections: {
    register: (definition) => (registrations.set(definition.key, { definition, states: new Map() }), () => {}),
    stateOf: (target, key) => registrations.get(key)?.states.get(target),
  },
  on: (event, handler) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(handler);
    return () => {};
  },
};
plugin.apply(ctx, {});

registrations.set('todos', {
  definition: {
    init: () => null,
    apply: (state, event) =>
      event.type === 'todo/write' ? event.data.todos : event.type === 'turn/start' ? null : state,
  },
  states: new Map(),
});
const fold = (event) => {
  for (const registration of registrations.values()) {
    const current = registration.states.get(session) ?? registration.definition.init();
    registration.states.set(session, registration.definition.apply(current, event));
  }
};
fold({ type: 'turn/start', data: { turn: 1 } });
fold({ type: 'step/start', data: { turn: 1, step: 1 } });
fold({
  type: 'todo/write',
  data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] },
});

const agent = { session, steer: (message) => steered.push(message) };
const reminder = (
  await listeners.get('tools/post-execute')[0]({ name: 'write', agent }, { content: [] }, async () => ({
    kind: 'accept',
  }))
).additionalContexts[0];
listeners.get('agent/turn-stopping')[0]({ agent, turn: 1 });
const steering = steered[0];

// --- the kernel decides whether these are admissible --------------------

const known = new Set(['agent/inbox/spliced']);
/** @returns the thrown message, or null when the kernel admits the row. */
const admit = (message) => {
  const row = { type: 'agent/inbox/spliced', seq: 1, data: { inserted: [message] } };
  try {
    assertV4RowAdmission(row, known);
    return null;
  } catch (error) {
    return error.message;
  }
};

check('the reminder is admitted', admit(reminder), null);
check('the steering is admitted', admit(steering), null);

// Negative control: without this, a validator that silently accepts anything
// would make both assertions above vacuous.
const retired = {
  role: 'user',
  content: [{ type: 'text', text: 'x' }],
  source: { kind: 'plugin', plugin: 'todo-discipline' },
  id: 'n1',
};
check('the retired plugin wrapper is rejected', admit(retired), 'format v4 message requires a producer-owned source kind');

console.log(failures === 0 ? '\nOK: injected messages pass kernel v4 admission' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
