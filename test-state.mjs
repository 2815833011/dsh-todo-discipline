/**
 * Offline tests for the two pure halves of the plugin: the state fold and the
 * rendered state line. Both decide what the model sees, and both have a
 * stability rule that is easy to break by accident 鈥?the line must not change
 * per step, or the loop admits a fresh runtime-context snapshot on every
 * single step.
 *
 * Run with: node test-state.mjs
 */

import {
  DEFAULT_GATE_MAX_BLOCKS,
  WRITE_LIKE_TOOLS,
  foldDiscipline,
  gateText,
  hasUnfinished,
  isWriteLike,
  listFingerprint,
  todoStateText,
  writeReminderText,
} from './state.js';

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

/** Build the event shape the session log uses for one committed event. */
function event(type, data = {}) {
  return { type, data };
}

// --- foldDiscipline -------------------------------------------------------

{
  let state = foldDiscipline({ turnSteps: 0, lastWriteStep: null, compactions: 0 }, event('turn/start'));
  check('turn/start clears the previous turn', state.turnSteps, 0);
  check('turn/start clears the last write', state.lastWriteStep, null);

  state = foldDiscipline(state, event('step/start', { turn: 1, step: 1 }));
  state = foldDiscipline(state, event('step/start', { turn: 1, step: 2 }));
  check('step/start tracks the highest step', state.turnSteps, 2);

  state = foldDiscipline(state, event('todo/write', { todos: [] }));
  check('todo/write records the step it happened on', state.lastWriteStep, 2);

  const untouched = foldDiscipline(state, event('assistant/message', { turn: 1, step: 2 }));
  check('unrelated events return the same object', untouched, state);

  state = foldDiscipline(state, event('step/start', { turn: 1, step: 3 }));
  check('a later step does not move the last write', state.lastWriteStep, 2);

  state = foldDiscipline(state, event('compaction/end', { compactionId: 'c1' }));
  check('a completed compaction is counted', state.compactions, 1);

  const failed = foldDiscipline(state, event('compaction/end', { compactionId: 'c2', error: 'boom' }));
  check('a failed compaction is not counted', failed.compactions, 1);

  const nextTurn = foldDiscipline(state, event('turn/start'));
  check('the next turn forgets the previous turn\'s compactions', nextTurn.compactions, 0);
}

// --- todoStateText -------------------------------------------------------

const LIST = [
  { content: 'read the config', status: 'completed' },
  { content: 'rewrite the loader', status: 'in_progress' },
  { content: 'run the suite', status: 'pending' },
];

{
  check('no list renders nothing', todoStateText(null, { turnSteps: 3, lastWriteStep: 1, compactions: 0 }), '');
  check('an empty list renders nothing', todoStateText([], { turnSteps: 3, lastWriteStep: 1, compactions: 0 }), '');

  const fresh = todoStateText(LIST, { turnSteps: 3, lastWriteStep: 3, compactions: 0 });
  checkTruthy('a fresh list counts the finished items', fresh.includes('1 of 3 done'));
  checkTruthy('a fresh list names the active item', fresh.includes('rewrite the loader'));
  checkTruthy('a fresh list counts the pending items', fresh.includes('1 pending'));
  check('a fresh list does not nag', fresh.includes('has not been updated'), false);

  const stale = todoStateText(LIST, { turnSteps: 12, lastWriteStep: 3, compactions: 0 });
  checkTruthy('a stale list asks for an update', stale.includes('has not been updated for 8 steps'));

  // The stability rule: within one reminder window the text must not change,
  // because a changing text costs a user message on every step.
  // 3 written + 8 = the window boundary; the next window opens 8 steps later.
  const at8 = todoStateText(LIST, { turnSteps: 11, lastWriteStep: 3, compactions: 0 });
  const at15 = todoStateText(LIST, { turnSteps: 15, lastWriteStep: 3, compactions: 0 });
  check('the reminder text is identical inside one window', at15, at8);
  const at19 = todoStateText(LIST, { turnSteps: 19, lastWriteStep: 3, compactions: 0 });
  checkTruthy('the next window restates a larger gap', at19.includes('has not been updated for 16 steps'));

  const compacted = todoStateText(LIST, { turnSteps: 4, lastWriteStep: 2, compactions: 1 });
  checkTruthy('one compaction reads in the singular', compacted.includes('1 context compaction in this turn'));

  const twice = todoStateText(LIST, { turnSteps: 4, lastWriteStep: 2, compactions: 2 });
  checkTruthy('two compactions read in the plural', twice.includes('2 context compactions in this turn'));

  const done = todoStateText(
    [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
    ],
    { turnSteps: 5, lastWriteStep: 5, compactions: 0 },
  );
  checkTruthy('a finished list asks for the report', done.includes('all 2 items completed'));

  const unknown = todoStateText([{ content: 'x', status: 'nonsense' }], { turnSteps: 1, lastWriteStep: 1, compactions: 0 });
  checkTruthy('an unknown status counts as pending', unknown.includes('1 pending'));

  // A never-written list is stale from the start of the turn, but still only
  // inside a reminder window.
  const never = todoStateText(LIST, { turnSteps: 3, lastWriteStep: null, compactions: 0 });
  check('a never-written list is quiet before the first window', never.includes('has not been updated'), false);
  const neverLate = todoStateText(LIST, { turnSteps: 9, lastWriteStep: null, compactions: 0 });
  checkTruthy('a never-written list nags once the window fills', neverLate.includes('has not been updated for 8 steps'));
}

// --- isWriteLike ---------------------------------------------------------

{
  check('write is a write-like tool', isWriteLike('write'), true);
  check('edit is a write-like tool', isWriteLike('edit'), true);
  check('str_replace_editor is a write-like tool', isWriteLike('str_replace_editor'), true);
  check('bash is not a write-like tool', isWriteLike('bash'), false);
  check('an unknown name is not a write-like tool', isWriteLike('todo_write'), false);
  check('a non-string is not a write-like tool', isWriteLike(undefined), false);
  check('the tool list is frozen', Object.isFrozen(WRITE_LIKE_TOOLS), true);
}

// --- hasUnfinished -------------------------------------------------------

{
  check('no list is not unfinished', hasUnfinished(null), false);
  check('an empty list is not unfinished', hasUnfinished([]), false);
  check('a non-array is not unfinished', hasUnfinished('nope'), false);
  check(
    'an all-completed list is not unfinished',
    hasUnfinished([{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }]),
    false,
  );
  check('one in_progress item is unfinished', hasUnfinished([{ content: 'a', status: 'in_progress' }]), true);
  check(
    'one pending item is unfinished',
    hasUnfinished([{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }]),
    true,
  );
  check('an unknown status counts as unfinished', hasUnfinished([{ content: 'a', status: 'nonsense' }]), true);
}

// --- listFingerprint -----------------------------------------------------

{
  const list = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }];
  check('the same list fingerprints the same', listFingerprint(list), listFingerprint([...list]));
  check(
    'a status change fingerprints differently',
    listFingerprint(list) === listFingerprint([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }]),
    false,
  );
  check(
    'a retitled item fingerprints differently',
    listFingerprint(list) === listFingerprint([{ content: 'a2', status: 'completed' }, { content: 'b', status: 'pending' }]),
    false,
  );
  check('a reordered list fingerprints differently', listFingerprint(list) === listFingerprint([...list].reverse()), false);
  check('no list fingerprints as empty', listFingerprint(null), '');
}

// --- writeReminderText ---------------------------------------------------

{
  const text = writeReminderText([
    { content: 'read the loader', status: 'completed' },
    { content: 'rewrite it', status: 'in_progress' },
    { content: 'run the suite', status: 'pending' },
  ]);
  checkTruthy('the write reminder names the tool', text.includes('todo_write'));
  checkTruthy('the write reminder counts the work', text.includes('1 of 3 done'));
  checkTruthy('the write reminder names the active item', text.includes('rewrite it'));
}

// --- gateText ------------------------------------------------------------

{
  check('the default gate limit is two', DEFAULT_GATE_MAX_BLOCKS, 2);

  const list = [
    { content: 'read the loader', status: 'completed' },
    { content: 'rewrite it', status: 'in_progress' },
  ];
  const first = gateText(list, 0, 2);
  checkTruthy('the gate says the turn cannot close', first.includes('cannot close'));
  checkTruthy('the gate counts the remaining work', first.includes('1 of 2 done'));
  checkTruthy('the gate names what is left', first.includes('rewrite it'));
  check('the first block does not mention the budget', first.includes('last attempt'), false);

  const second = gateText(list, 1, 2);
  checkTruthy('the last block announces the budget', second.includes('last attempt'));
  checkTruthy('the last block says it will release', second.includes('will close anyway'));
}

console.log(failures === 0 ? '\nOK: todo state fold and state line behave' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

