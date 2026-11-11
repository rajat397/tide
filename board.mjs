// tide/board.mjs — TUI: the cockpit. Board of agent slots + task queue +
// detail pane (agent output tail, diff stat). Keys are operator commands.

import { TideSession } from './session.mjs';
import { RealRunner } from './runner.mjs';
import { S_RUNNING, S_GATING, S_READY, S_FAILED, S_MERGED, S_ORPHAN, T_QUEUED } from './core.mjs';
import fs from 'node:fs';

const ESC = '\x1b';
const C = {
  reset: ESC + '[0m', dim: ESC + '[90m', bold: ESC + '[1m',
  rev: ESC + '[7m', grn: ESC + '[32m', red: ESC + '[31m', yel: ESC + '[33m',
  blu: ESC + '[36m', mg: ESC + '[35m',
};
const ALT_ON = ESC + '[?1049h' + ESC + '[?25l', ALT_OFF = ESC + '[?25h' + ESC + '[?1049l';
const STATE_COLOR = { FREE: C.dim, RUNNING: C.blu, GATING: C.yel, READY: C.grn,
                      FAILED: C.red, MERGED: C.grn, ORPHAN: C.mg };

export function runBoard({ cfg }) {
  const session = new TideSession({ cfg, logSink: cfg._logSink });
  const runner = new RealRunner({ cfg, core: session.core, session });
  session.setRunner(runner);
  const core = session.core;

  process.stdout.write(ALT_ON);
  let cols = process.stdout.columns ?? 100, rows = process.stdout.rows ?? 30;
  process.stdout.on('resize', () => { cols = process.stdout.columns; rows = process.stdout.rows; });

  let sel = 0, mode = 'board', promptText = '', running = true, lastDetailSlot = -1;
  let detail = { out: '', diff: null };

  // board rows = live slots in work order + queue
  const rowsFor = () => {
    const live = core.slots.filter((s) => s.state !== 'FREE');
    const queued = core.tasksIn(T_QUEUED);
    return { live, queued };
  };

  function render() {
    const h = rows - 4;
    const out = [];
    const { live, queued } = rowsFor();
    out.push(`${C.bold}TIDE${C.reset} ${C.dim}│ ${core.running}/${core.cap} running │ ${queued.length} queued │ ${core.slotsIn(S_READY).length} ready │ ${core.slotsIn(S_FAILED).length} failed │ ${C.reset}${C.dim}n=new task m=merge [ ]=select g=gate r=requeue a=abort q=quit${C.reset}`);
    // slots
    live.forEach((s, i) => {
      const t = core.tasks[s.taskId];
      const mins = s.startedAt ? Math.floor((Date.now() - s.startedAt) / 60000) : 0;
      const mark = i === sel ? C.rev : '';
      const col = STATE_COLOR[s.state] ?? '';
      const gate = s.gate ? (s.gate.pass ? '✓gate' : '✗gate') : '';
      const pr = s.prUrl ? ' PR!' : '';
      out.push(`${mark}${col}${String(s.slot).padStart(2)} ${s.state.padEnd(8)}${C.reset} ${mark}#${t?.id ?? '?'} ${((t?.title ?? '').slice(0, Math.max(8, cols - 52)))}${C.reset}${C.dim} ${mins}m ${gate}${pr}${s.note ? ' ⚠' + s.note.slice(0, 20) : ''}${C.reset}`);
    });
    if (!live.length) out.push(`${C.dim}  no live agents — press n to add a task${C.reset}`);
    // queue
    out.push(`${C.dim}── queue ──${C.reset}`);
    for (const t of queued.slice(0, Math.max(0, h - live.length - 2)))
      out.push(`${C.dim}  · #${t.id} ${t.title.slice(0, cols - 12)}${C.reset}`);
    while (out.length < h) out.push(ESC + '[2K');
    // detail pane for selected slot
    if (live[sel] && lastDetailSlot !== live[sel].slot) {
      lastDetailSlot = live[sel].slot;
      detail = { out: session.outTail(live[sel].slot), diff: runner.diffStat?.(live[sel].slot) ?? null };
    }
    let s = ESC + '[H' + ESC + '[2J';
    out.slice(0, h).forEach((line, i) => { s += ESC + `[${i + 1};1H` + ESC + '[2K' + line; });
    // status + detail
    const selSlot = live[sel];
    s += ESC + `[${h + 1};1H${C.rev} ${selSlot ? `slot ${selSlot.slot} ${selSlot.state} #${core.tasks[selSlot.taskId]?.id}` : 'no selection'} ${C.reset}`;
    const dlines = (detail.out || '').split('\n').slice(-3);
    s += ESC + `[${h + 2};1H${C.dim}${(detail.diff ?? '').replace(/\n/g, ' ¦ ').slice(0, cols - 4)}${C.reset}`;
    dlines.forEach((dl, i) => {
      s += ESC + `[${h + 3 + i};1H${ESC + '[2K'}${dl.slice(0, cols - 4)}${C.reset}`;
    });
    if (mode === 'prompt') {
      s += ESC + `[${rows};1H${C.rev} task title: ${promptText}${C.reset}`;
    }
    process.stdout.write(s);
  }

  function submitPrompt() {
    if (promptText.trim()) session.addTask(promptText.trim(), '');
    mode = 'board'; promptText = ''; lastDetailSlot = -1;
  }

  function key(ch) {
    const { live, queued } = rowsFor();
    if (mode === 'prompt') {
      if (ch === ESC) { mode = 'board'; promptText = ''; }
      else if (ch === '\r') submitPrompt();
      else if (ch === '\x7f') promptText = promptText.slice(0, -1);
      else if (ch.length === 1 && ch >= ' ') promptText += ch;
      return;
    }
    if (ch === 'q' || ch === 'Q') { running = false; return; }
    if (ch === 'n') { mode = 'prompt'; promptText = ''; return; }
    if (ch === '[') { sel = Math.max(0, sel - 1); lastDetailSlot = -1; return; }
    if (ch === ']') { sel = Math.min(Math.max(0, live.length - 1), sel + 1); lastDetailSlot = -1; return; }
    const s = live[sel];
    if (ch === 'm' && s?.state === S_READY) session.requestMerge(s.slot);
    if (ch === 'M') session.mergeAllReady();                       // batch (M-3)
    if (ch === 'g' && (s?.state === S_GATING || s?.state === S_READY)) core.effect?.('gate', { slot: s.slot, worktree: s.worktree });
    if (ch === 'r' && s?.taskId != null) session.requeue(s.taskId);
    if (ch === 'a' && s?.taskId != null) session.abortTask(s.taskId);
    if (ch === '+' || ch === '=') session.setCap(Math.min(core.slotCap, core.cap + 1));
    if (ch === '-') session.setCap(Math.max(1, core.cap - 1));
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => {
    const s = d.toString('utf8');
    for (const ch of s) {
      if (ch === ESC) continue;            // arrows ignored in v0.1 board
      key(ch);
    }
  });
  const timer = setInterval(() => {
    session.tick();                        // M-5 policy + effect boundary
    if (core.slotsIn(S_READY).length && cfg.autoMerge) session.mergeAllReady();
    render();
    if (!running) { clearInterval(timer); process.stdin.setRawMode(false); process.stdout.write(ALT_OFF); process.exit(0); }
  }, 500);
  process.on('exit', () => process.stdout.write(ALT_OFF));
}
