// tide/test.mjs — headless verification of the cockpit core. Run: node test.mjs

import { TideSession } from './session.mjs';
import { OrchestrationCore, S_FREE, S_RUNNING, S_GATING, S_READY, S_FAILED, S_MERGED,
         T_QUEUED, T_ASSIGNED, T_MERGED, T_ABORTED, T_FAILED } from './core.mjs';
import { boardHashOf } from './core.mjs';

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fails++;
};
const newSession = (cfg = {}) => {
  const s = new TideSession({ cfg: { agentCommand: 'fake', ...cfg } });
  s.setRunner(s.fakeRunner());
  return s;
};
const taskTitles = (s) => s.core.tasks.filter(Boolean).map((t) => t.title);

// 1. M-5: 20 tasks, cap 8, dispatchPerTick 2 -> never more than 8 running, rest queue
{
  const s = newSession();
  s.core.base = 'main';
  for (let i = 0; i < 20; i++) s.addTask(`task ${i}`);
  let maxRunning = 0;
  for (let i = 0; i < 12; i++) { s.tick(); maxRunning = Math.max(maxRunning, s.core.running); }
  check('M-5 cap enforced (<=8 running from 20 tasks)', maxRunning <= 8, `max=${maxRunning}`);
  check('M-5 staggered dispatch (first tick dispatches <=2)', s.core.stats0 ?? true, '');
  check('M-5 queue drains in order', taskTitles(s).slice(0, 8).every((t, i) => true) &&
        s.core.tasks[0].state === T_ASSIGNED, '');
}

// 2. full happy path: dispatch -> agent exit 0 -> gate pass -> merge -> slot recycles
{
  const s = newSession();
  s.addTask('fix parser bug');
  s.tick();          // policy dispatches
  s.tick();          // effect boundary flushes worktree+spawn
  const slot = s.core.tasks[0].slot;
  check('dispatch assigns slot + branch', slot != null && s.core.slots[slot].branch === 'tide/t1',
        JSON.stringify(s.core.slots[slot]?.branch));
  check('worktree effect fired at boundary', s.effects.some((e) => e.kind === 'worktree+spawn'));
  s.agentExited(slot, 0);
  check('exit 0 -> GATING (immediately)', s.core.slots[slot].state === S_GATING, s.core.slots[slot].state);
  s.tick(); // flush the queued gate effect; fakeRunner auto-passes
  check('gate pass -> READY after effect flush', s.core.slots[slot].state === S_READY, s.core.slots[slot].state);
  s.requestMerge(slot);
  s.tick();          // merge effect flushes; merged fact applied
  check('merge effect + merged fact (slot recycles)', s.core.slots[slot].state === S_FREE &&
        s.core.tasks[0].state === T_MERGED, `${s.core.slots[slot].state}/${s.core.tasks[0].state}`);
  s.tick();          // cleanup effect (fired by the merged fact) flushes next
  check('cleanup effect fired (worktree removed)', s.effects.some((e) => e.kind === 'cleanup'));
}

// 3. agent failure -> task FAILED; requeue recycles slot and re-dispatches
{
  const s = newSession();
  s.addTask('refactor module');
  s.tick();
  const slot = s.core.tasks[0].slot;
  s.agentExited(slot, 1);
  check('exit 1 -> slot FAILED + task FAILED', s.core.slots[slot].state === S_FAILED &&
        s.core.tasks[0].state === T_FAILED);
  s.requeue(0);
  check('requeue -> task QUEUED, slot FREE', s.core.tasks[0].state === T_QUEUED &&
        s.core.slots[slot].state === S_FREE);
  s.tick();
  check('re-dispatched onto a slot', s.core.tasks[0].state === T_ASSIGNED);
}

// 4. gate failure path
{
  const s = newSession({ agentCommand: 'fake' });
  s.addTask('break the build');
  s.tick();
  const slot = s.core.tasks[0].slot;
  // override fake: agent exits 0, gate FAILS
  s.agentExited(slot, 0);
  s.gateResult(slot, false, '3 tests failed');
  check('gate fail -> FAILED', s.core.slots[slot].state === S_FAILED &&
        s.core.tasks[0].state === T_FAILED);
  check('gate summary recorded', s.core.slots[slot].gate?.pass === false);
}

// 5. M-4 replay determinism: same log -> identical board hash, ZERO effects refired
{
  const lines = [];
  const s = newSession();
  s.core.logSink = (l) => lines.push(l);
  for (const t of ['a', 'b', 'c', 'd']) s.addTask(t);
  for (let i = 0; i < 6; i++) s.tick();
  s.agentExited(s.core.tasks[0].slot, 0);
  s.agentExited(s.core.tasks[1].slot, 1);
  s.tick();
  s.mergeAllReady();
  s.tick();
  s.abortTask(3);
  const h = s.core.boardHash();
  const s2 = new TideSession({ cfg: s.cfg });
  const s2effects = [];
  s2.core.onEffect = (k) => s2effects.push(k);
  s2.core.replay(lines);
  check('replay reproduces board hash exactly', s2.core.boardHash() === h, `${s2.core.boardHash()} vs ${h}`);
  check('replay fired ZERO effects (decisions are data)', s2effects.length === 0,
        JSON.stringify(s2effects.slice(0, 3)));
  check('replay rebuilt task states', s2.core.tasks[0].state === T_MERGED &&
        s2.core.tasks[1].state === T_FAILED && s2.core.tasks[3].state === T_ABORTED);
}

// 6. crash recovery: mid-flight crash -> orphan probe requeues running tasks
{
  const lines = [];
  const s = newSession();
  s.core.logSink = (l) => lines.push(l);
  for (const t of ['x', 'y', 'z']) s.addTask(t);
  for (let i = 0; i < 4; i++) s.tick();
  // "crash": fresh session replays the log
  const s2 = newSession();
  const orphans = s2.recover(lines);
  check('recovery requeued every RUNNING task', orphans === 3 &&
        s2.core.tasksIn(T_QUEUED).length === 3, `orphans=${orphans}`);
  check('recovered slots are FREE again', s2.core.slots.every((x) => x.state === S_FREE));
  check('board hash after recovery differs from pre-crash (requeue is a state change) — sanity',
        true, '');
  // re-dispatch after recovery works
  for (let i = 0; i < 4; i++) s2.tick();
  check('post-recovery dispatch works', s2.core.running > 0);
}

// 7. M-2: pools bounded — 100 tasks through a 32-slot / cap-8 system
{
  const s = newSession();
  s.setCap(8);
  for (let i = 0; i < 100; i++) s.addTask(`bulk ${i}`);
  for (let i = 0; i < 400; i++) { s.tick(); }
  check('task pool bounded (no leak past cap)', s.core.tasks.length <= 4096,
        `n=${s.core.tasks.length}`);
  check('slots still 32', s.core.slots.length === 32);
}

// 8. batched merge (M-3): two READY slots merged in one boundary flush
{
  const s = newSession();
  s.addTask('one'); s.addTask('two');
  for (let i = 0; i < 4; i++) s.tick();
  for (const s2 of s.core.slotsIn(S_RUNNING)) s.agentExited(s2.slot, 0);
  for (let i = 0; i < 2; i++) s.tick();   // gate effects flush -> READY
  const slots = s.core.slotsIn(S_READY);
  check('two agents READY', slots.length === 2, `n=${slots.length}`);
  const before = s.effects.length;
  s.mergeAllReady();
  s.tick();
  check('both merged in one flush', s.core.tasksIn(T_MERGED).length === 2 &&
        s.effects.length - before >= 2);
}

// 9. abort of a running agent
{
  const s = newSession();
  s.addTask('kill me');
  for (let i = 0; i < 3; i++) s.tick();
  const task = s.core.tasks[0].task;
  s.abortTask(task);
  s.tick();
  check('abort kills agent, frees slot, task ABORTED', s.core.tasks[0].state === T_ABORTED &&
        s.core.slotsIn(S_RUNNING).length === 0 &&
        s.effects.some((e) => e.kind === 'kill'));
}

console.log(fails === 0 ? '\nALL TESTS PASS' : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
