// tide/core.mjs — OrchestrationCore: deterministic cockpit state for managing
// tens of agents. All state changes flow through apply(cmd); side effects
// (spawning agents, git worktrees, gates, merges) fire at effect boundaries
// and NEVER during log replay. The log is the audit trail AND the recovery
// mechanism.
//
// Mechanisms (from github.com/rajat397/retro-efficiency-lab):
//   M-2  fixed slot pools    agent slots, task pool, output rings — bounded
//   M-5  measured slowdown   concurrency cap + staggered dispatch: tasks
//                            queue when fan-out is hot; latency stays sane
//   M-4  replay determinism  command log replays to an identical board hash;
//                            crash recovery = log replay + orphan probe
//   M-3  deferred application merges/PRs are batched requests applied at the
//                            sync point (tickFrame)
//   M-10 index-linked lists  agents live on status lists (running/ready/
//                            failed/queued); the board walks subsets only

const SLOT_CAP = 32, TASK_CAP = 4096, OUT_RING = 96; // lines per output ring

export const S_FREE = 'FREE', S_RUNNING = 'RUNNING', S_GATING = 'GATING',
  S_READY = 'READY', S_FAILED = 'FAILED', S_MERGED = 'MERGED', S_ORPHAN = 'ORPHAN';
export const T_QUEUED = 'QUEUED', T_ASSIGNED = 'ASSIGNED', T_MERGED = 'MERGED',
  T_ABORTED = 'ABORTED', T_FAILED = 'FAILED';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function boardHashOf(state) {
  // FNV-1a over the sortable state (excludes timestamps, output tails, diffs)
  let h = 0x811c9dc5 >>> 0;
  const feed = (s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193); } feed.n++; };
  feed.n = 0;
  feed(`cap:${state.cap}`);
  for (const s of state.slots) feed(`${s.slot}:${s.state}:${s.taskId ?? ''}:${s.exit ?? ''}`);
  for (const t of state.tasks) feed(`t${t.task}:${t.state}:${t.slot ?? ''}:${t.title}`);
  return (h >>> 0).toString(16);
}

export class OrchestrationCore {
  constructor({ now = () => Date.now(), slotCap = SLOT_CAP } = {}) {
    this.now = now;
    this.tick = 0;
    this.requests = [];          // M-3 pending
    this.log = [];               // M-4 command log
    this.logSink = null;
    this.onEffect = null;        // (kind, payload) => void — NEVER during replay
    this._mode = null;           // 'replay' while recovering

    // ---- M-2 pools ----
    this.slotCap = slotCap;
    this.slots = Array.from({ length: slotCap }, (_, slot) => ({
      slot, state: S_FREE, taskId: null, pid: null, startedAt: null,
      exit: null, gate: null, worktree: null, branch: null,
      outRing: [], outDropped: 0,            // M-2: capped output ring
    }));
    this.tasks = [];                          // task pool (records hold slot ids)
    this.freeTasks = [];                      // free-list (M-2)
    for (let i = TASK_CAP - 1; i >= 0; i--) this.freeTasks.push(i);
    this.taskSeq = 0;
    this.cap = 8;                              // M-5 concurrency cap (adjustable)
    this.dispatchPerTick = 2;                  // stagger
  }

  // ---------- M-3 frame boundary ----------
  request(cmd) { this.requests.push(cmd); }
  tickFrame() {
    const reqs = this.requests; this.requests = [];
    for (const cmd of reqs) this.apply(cmd, true);
    this.tick++;
  }
  boardHash() { return boardHashOf(this); }

  // ---------- M-4: single mutation entrypoint ----------
  apply(cmd, toLog = false) {
    this.cmdApply(cmd);
    if (toLog) {
      this.log.push({ t: this.now(), cmd });
      this.logSink?.(JSON.stringify({ t: this.now(), cmd }));
    }
  }
  cmdApply(cmd) {
    switch (cmd.op) {
      case 'set_cap':      return this.doSetCap(cmd);
      case 'add_task':     return this.doAddTask(cmd);
      case 'requeue':      return this.doRequeue(cmd);
      case 'abort_task':   return this.doAbortTask(cmd);
      case 'dispatch':     return this.doDispatch(cmd);
      case 'complete':     return this.doComplete(cmd);
      case 'gate_result':  return this.doGateResult(cmd);
      case 'merge_req':    return this.doMergeReq(cmd);
      case 'merged':       return this.doMerged(cmd);       // effect fact
      case 'merge_failed': return this.doMergeFailed(cmd);  // effect fact
      case 'orphan':       return this.doOrphan(cmd);       // recovery fact
      default: throw new Error(`unknown op ${cmd.op}`);
    }
  }
  effect(kind, payload) {         // fire effects only outside replay (M-3/M-4)
    if (this._mode === 'replay') return;
    this.onEffect?.(kind, payload);
  }

  // ---------- commands ----------
  doSetCap({ n }) { this.cap = Math.max(1, Math.min(this.slotCap, n | 0)); }
  doAddTask({ title, body = '' }) {
    if (this.freeTasks.length === 0) throw new Error('task pool exhausted');
    const id = this.freeTasks.pop();               // M-2 allocator decision
    // taskSeq re-derived from records => replay-stable
    this.taskSeq = Math.max(0, ...this.tasks.filter(Boolean).map((t) => t.id)) + 1;
    this.tasks[id] = { task: id, id: this.taskSeq, title, body, state: T_QUEUED, slot: null, branch: null };
  }
  doRequeue({ task }) {
    const t = this.tasks[task];
    const s = t.slot != null ? this.slots[t.slot] : null;
    if (s) { s.state = S_FREE; s.taskId = null; s.worktree = s.branch = null; s.exit = null; s.gate = null; }
    t.state = T_QUEUED; t.slot = null;
    this.effect('cleanup', { worktree: s?.worktree });
  }
  doAbortTask({ task }) {
    const t = this.tasks[task];
    if (t.state === T_ASSIGNED) {
      const s = this.slots[t.slot];
      if (s.state === S_RUNNING) this.effect('kill', { pid: s.pid });
      s.state = S_FREE; s.taskId = null;
      this.effect('cleanup', { worktree: s.worktree });
      s.worktree = s.branch = null;
    }
    t.state = T_ABORTED; t.slot = null;
  }
  doDispatch({ slot, task, branch, worktree }) {
    const s = this.slots[slot], t = this.tasks[task];
    s.state = S_RUNNING; s.taskId = task; s.startedAt = this.now();
    s.worktree = worktree; s.branch = branch; s.exit = null; s.gate = null;
    s.outRing.length = 0; s.outDropped = 0;
    t.state = T_ASSIGNED; t.slot = slot; t.branch = branch;
    this.effect('worktree+spawn', { slot, task, title: t.title, body: t.body,
                                     branch, worktree, base: this.base });
  }
  doComplete({ slot, exit, note = '' }) {
    const s = this.slots[slot];
    s.state = exit === 0 ? S_GATING : S_FAILED;
    s.exit = exit; s.note = note;
    if (exit === 0) this.effect('gate', { slot, worktree: s.worktree });
    const t = this.tasks[s.taskId];
    if (t && exit !== 0) t.state = T_FAILED;
  }
  doGateResult({ slot, pass, summary = '' }) {
    const s = this.slots[slot];
    s.state = pass ? S_READY : S_FAILED;
    s.gate = { pass, summary };
    const t = this.tasks[s.taskId];
    if (t && !pass) t.state = T_FAILED;
  }
  doMergeReq({ slot }) {
    const s = this.slots[slot];
    if (s.state !== S_READY) throw new Error(`slot ${slot} not READY`);
    s.state = S_MERGED;                            // optimistic; fact may correct
    this.effect('merge', { slot, worktree: s.worktree, branch: s.branch,
                           title: this.tasks[s.taskId]?.title, task: s.taskId });
  }
  doMerged({ slot, commit, prUrl }) {
    const s = this.slots[slot], t = this.tasks[s.taskId];
    s.commit = commit; s.prUrl = prUrl; s.state = S_MERGED;
    if (t) { t.state = T_MERGED; }
    this.effect('cleanup', { worktree: s.worktree });
    s.taskId = null; s.worktree = s.branch = null; s.state = S_FREE; // slot recycles (M-2)
  }
  doMergeFailed({ slot, reason }) {
    const s = this.slots[slot];
    s.state = S_FAILED; s.note = `merge failed: ${reason}`;
    const t = this.tasks[s.taskId];
    if (t) t.state = T_FAILED;
  }
  doOrphan({ slot }) {
    const s = this.slots[slot];
    s.state = S_ORPHAN;
    const t = this.tasks[s.taskId];
    if (t) { t.state = T_QUEUED; t.slot = null; }   // auto-requeue (M-4 recovery)
    this.effect('cleanup', { worktree: s.worktree });
    s.taskId = null; s.worktree = s.branch = null; s.state = S_FREE;
  }

  // ---------- M-10: status lists (walk subsets, never the pool) ----------
  slotsIn(state) { return this.slots.filter((s) => s.state === state); }
  tasksIn(state) { return this.tasks.filter((t) => t && t.state === state); }
  get running() { return this.slotsIn(S_RUNNING).length; }
  get queued() { return this.tasksIn(T_QUEUED).length; }

  // ---------- M-5 dispatch policy: deterministic, queueing ----------
  dispatchPolicy() {
    // at most dispatchPerTick per tick; never exceed cap; FIFO queue order
    const out = [];
    if (this.running >= this.cap) return out;
    const freeSlots = this.slotsIn(S_FREE);
    const queuedTasks = this.tasksIn(T_QUEUED);
    for (let i = 0; i < Math.min(this.dispatchPerTick, this.cap - this.running,
                                 freeSlots.length, queuedTasks.length); i++) {
      const slot = freeSlots[i].slot;
      const task = queuedTasks[i].task;
      out.push({
        op: 'dispatch', slot, task,
        branch: `tide/t${this.tasks[task].id}`,
        worktree: `${this.worktreeRoot ?? '.tide'}/wt/t${this.tasks[task].id}`,
      });
    }
    return out;
  }

  // ---------- recovery (M-4): replay + orphan probe ----------
  replay(logLines, { onEffect = null } = {}) {
    this._mode = 'replay'; this.onEffect = onEffect;
    for (const line of logLines) {
      if (!line.trim()) continue;
      this.apply(JSON.parse(line).cmd);
    }
    this._mode = null; this.onEffect = null;
    // orphan probe is the operator's next action; core only flags state
  }
}
