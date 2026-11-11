// tide/session.mjs — the operator-facing session: ties core decisions to
// runner effects, wires agent output into capped rings, and runs the
// deterministic dispatch policy each frame.
//
// Ordering rule (M-3): operator commands and runner facts APPLY IMMEDIATELY
// (they are single pure-data commands, logged); agent/merge effects are
// QUEUED and flushed at the next tick's boundary before the dispatch policy
// runs. The core never re-enters its own apply loop.

import { OrchestrationCore, S_RUNNING, S_READY, T_QUEUED, T_ASSIGNED } from './core.mjs';

export class TideSession {
  constructor({ cfg, now = () => Date.now(), logSink = null } = {}) {
    this.cfg = cfg ?? {};
    this.core = new OrchestrationCore({ now });
    this.core.base = this.cfg.base ?? 'main';
    this.core.worktreeRoot = this.cfg.worktreeDir ?? '.tide';
    this.core.logSink = logSink;
    this.runner = null;
    this.effects = [];               // recorded by the fake runner (tests)
    this.effectQueue = [];           // M-3: effects wait for the boundary
    this.outRings = new Map();       // slot -> array of chunks (capped)
    this.core.onEffect = (kind, payload) => this.effectQueue.push({ kind, payload });
  }

  setRunner(runner) { this.runner = runner; }
  this_effects() { return this.effects; }

  // ---- test fake: records effects, auto-passes gates, auto-merges ----
  fakeRunner() {
    const self = this;
    return {
      async onEffect(kind, p) {
        self.effects.push({ kind, payload: p });
        if (kind === 'gate') self.gateResult(p.slot, p.pass ?? true, 'fake gate');
        if (kind === 'merge') self.merged(p.slot, `fake${self.effects.length}`, null);
      },
    };
  }

  // ---- frame loop (M-3): flush effects -> dispatch policy -> apply ----
  tick(n = 1) {
    for (let i = 0; i < n; i++) {
      this.flushEffects();
      for (const cmd of this.core.dispatchPolicy()) this.core.apply(cmd, true);
      this.core.tick++;
    }
  }
  flushEffects() {
    const q = this.effectQueue; this.effectQueue = [];
    for (const { kind, payload } of q) {
      if (!this.runner) continue;
      try {
        const r = this.runner.onEffect(kind, payload);
        if (r?.catch) r.catch((err) => this.runner.onError?.(err, kind, payload));
      } catch (err) { this.runner.onError?.(err, kind, payload); }
    }
  }

  // ---- operator surface: immediate apply, logged ----
  addTask(title, body = '') { this.core.apply({ op: 'add_task', title, body }, true); }
  setCap(n) { this.core.apply({ op: 'set_cap', n }, true); }
  abortTask(task) { this.core.apply({ op: 'abort_task', task }, true); }
  requeue(task) { this.core.apply({ op: 'requeue', task }, true); }
  requestMerge(slot) { this.core.apply({ op: 'merge_req', slot }, true); }
  mergeAllReady() {
    for (const s of this.core.slotsIn(S_READY)) this.core.apply({ op: 'merge_req', slot: s.slot }, true);
  }

  // ---- runner callbacks (facts): immediate apply, logged ----
  agentExited(slot, code, note = '') { this.core.apply({ op: 'complete', slot, exit: code, note }, true); }
  gateResult(slot, pass, summary = '') { this.core.apply({ op: 'gate_result', slot, pass, summary }, true); }
  merged(slot, commit, prUrl) { this.core.apply({ op: 'merged', slot, commit, prUrl }, true); }
  mergeFailed(slot, reason) { this.core.apply({ op: 'merge_failed', slot, reason }, true); }
  failDispatch(slot, reason) {
    const s = this.core.slots[slot];
    if (s.taskId != null) this.core.apply({ op: 'requeue', task: s.taskId }, true);
  }

  // ---- agent output: capped ring outside core state (view data, not state) ----
  pushOut(slot, chunk) {
    let r = this.outRings.get(slot);
    if (!r) { r = []; this.outRings.set(slot, r); }
    r.push(String(chunk).replace(/[^\n]*$/g, '').slice(0, 200));
    while (r.length > 96) { r.shift(); this.core.slots[slot].outDropped++; } // M-2 cap
  }
  outTail(slot, n = 12) {
    const r = this.outRings.get(slot) ?? [];
    return r.join('').trimEnd().split('\n').slice(-n).join('\n');
  }

  // ---- recovery (M-4): replay log, then probe for dead agents ----
  recover(logLines) {
    this.core.replay(logLines);
    let orphans = 0;
    for (const s of this.core.slots) {
      if (s.state === S_RUNNING) { this.core.apply({ op: 'orphan', slot: s.slot }, true); orphans++; }
    }
    return orphans;
  }
}
