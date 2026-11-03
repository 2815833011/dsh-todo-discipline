/**
 * Load the installed plugin through the web profile's own resolution and drive
 * apply() against the register/context APIs it really uses. Same checks as the
 * author's check-install.cjs, with this machine's paths.
 */
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const os = require('node:os');

const PROFILE = join(os.homedir(), '.dsh', 'profiles', 'web');
const INSTALLED = join(PROFILE, 'node_modules', 'dsh-todo-discipline', 'index.js');

async function main() {
  const module = await import(pathToFileURL(INSTALLED).href);
  console.log('name:', module.name);
  console.log('inject:', module.inject.join(', '));
  console.log('apply is a function:', typeof module.apply === 'function');

  const sections = [];
  const contexts = [];
  const registrations = new Map();
  const listeners = new Map();
  const session = { id: 'check', header: { origin: undefined, delegationDepth: 0 } };
  const ctx = {
    systemPrompt: {
      section: (definition) => (sections.push(definition), () => {}),
      context: (definition) => (contexts.push(definition), () => {}),
    },
    sessionProjections: {
      register(definition) {
        registrations.set(definition.key, { definition, states: new Map() });
        return () => registrations.delete(definition.key);
      },
      stateOf(target, key) {
        return registrations.get(key)?.states.get(target);
      },
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {};
    },
  };

  module.apply(ctx, { enabled: true, staleSteps: 8 });
  console.log('sections:', sections.map((e) => `${e.name}@${e.order}`).join(', '));
  console.log('contexts:', contexts.map((e) => `${e.name}@${e.order}`).join(', '));
  console.log('projections:', [...registrations.keys()].join(', '));
  console.log('hooks:', [...listeners.keys()].join(', '));

  const fold = (event) => {
    for (const registration of registrations.values()) {
      const current = registration.states.get(session) ?? registration.definition.init();
      registration.states.set(session, registration.definition.apply(current, event));
    }
  };
  registrations.set('todos', {
    definition: {
      init: () => null,
      apply: (state, event) =>
        event.type === 'todo/write' ? event.data.todos : event.type === 'turn/start' ? null : state,
    },
    states: new Map(),
  });
  fold({ type: 'turn/start', data: { turn: 1 } });
  fold({ type: 'step/start', data: { turn: 1, step: 1 } });
  fold({
    type: 'todo/write',
    data: {
      todos: [
        { content: 'inspect the loader', status: 'completed' },
        { content: 'write the plugin', status: 'in_progress' },
        { content: 'test it', status: 'pending' },
      ],
    },
  });
  fold({ type: 'step/start', data: { turn: 1, step: 12 } });
  fold({ type: 'compaction/end', data: { compactionId: 'c1' } });

  const rendered = contexts[0].text({ agent: { session } });
  console.log('\n--- model-facing runtime context ---');
  console.log(rendered);

  const problems = [];
  if (typeof module.apply !== 'function') problems.push('apply is missing');
  if (sections.length !== 1) problems.push(`expected 1 section, got ${String(sections.length)}`);
  if (contexts.length !== 1) problems.push(`expected 1 context, got ${String(contexts.length)}`);
  if (!registrations.has('todoDiscipline')) problems.push('the discipline projection was not registered');
  if (!rendered.includes('1 of 3 done')) problems.push('the rendered line lost the list counts');
  if (!rendered.includes('context compaction')) problems.push('the rendered line lost the compaction note');
  const hooks = [...listeners.keys()].sort().join(',');
  if (hooks !== 'agent/turn-stopping,tools/post-execute') problems.push(`unexpected hooks: ${hooks}`);

  console.log(problems.length === 0 ? '\nOK: the installed plugin loads and renders' : `\nFAIL: ${problems.join('; ')}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
