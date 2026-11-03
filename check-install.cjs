/**
 * Load the installed plugin through the profile's own resolution, the way the
 * Host loader does, and drive `apply()` against the register/context APIs it
 * really uses. This catches the failure mode the link install can hide: the
 * real path is outside `node_modules`, so any bare import would fail here even
 * though it resolves from the workspace.
 *
 * Run with: node check-install.cjs   (from the profile directory)
 */
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const PROFILE = 'C:\\Users\\28158\\.dsh\\profiles\\desktop';
const INSTALLED = join(PROFILE, 'node_modules', 'dsh-todo-discipline', 'index.js');

async function main() {
  const module = await import(pathToFileURL(INSTALLED).href);
  console.log('name:', module.name);
  console.log('inject:', module.inject.join(', '));
  console.log('apply is a function:', typeof module.apply === 'function');

  const sections = [];
  const contexts = [];
  const registrations = new Map();
  const session = { id: 'check' };
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
  };

  module.apply(ctx, { enabled: true, staleSteps: 8 });
  console.log('sections:', sections.map((entry) => `${entry.name}@${entry.order}`).join(', '));
  console.log('contexts:', contexts.map((entry) => `${entry.name}@${entry.order}`).join(', '));
  console.log('projections:', [...registrations.keys()].join(', '));

  // Fold a realistic turn and render what the model would see.
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

  console.log(problems.length === 0 ? '\nOK: the installed plugin loads and renders' : `\nFAIL: ${problems.join('; ')}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
