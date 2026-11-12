// dogfood-agent.mjs — the agent under test: reads its task file and applies
// one scripted-but-real defect fix in its worktree. Each fix is a genuine
// code change; the gate (node test.mjs) validates it. Deletes the task file
// after reading so it never leaks into a merge.
import fs from 'node:fs';

const taskFile = process.argv[2];
const task = fs.readFileSync(taskFile, 'utf8');
fs.unlinkSync(taskFile);                       // never commit the task file

const title = task.split('\n')[0].replace(/^#\s+/, '');
const edit = (file, from, to) => {
  let src = fs.readFileSync(file, 'utf8');
  if (!src.includes(from)) throw new Error(`patch target missing in ${file}: ${from.slice(0, 60)}`);
  fs.writeFileSync(file, src.replace(from, to));
  console.log(`[dogfood-agent] applied fix to ${file}`);
};

if (title.startsWith('D1')) {
  // D1: task files written INSIDE the worktree get committed into merges/PRs
  edit('runner.mjs',
    "import fs from 'node:fs';\nimport path from 'node:path';",
    "import fs from 'node:fs';\nimport os from 'node:os';\nimport path from 'node:path';");
  edit('runner.mjs',
    "const taskFile = path.join(wt, '.tide-task.txt');",
    "const taskFile = path.join(os.tmpdir(), `tide-task-${task}.txt`);   // D1: outside the worktree — never committed");
} else if (title.startsWith('D2')) {
  // D2: board ignores ESC sequences — arrow keys dead for slot selection
  edit('board.mjs',
    "process.stdin.on('data', (d) => {\n    const s = d.toString('utf8');\n    for (const ch of s) {\n      if (ch === ESC) continue;            // arrows ignored in v0.1 board\n      key(ch);\n    }\n  });",
    "process.stdin.on('data', (d) => {\n    const s = d.toString('utf8')\n      .replace(/\\x1b\\[A/g, '!up!').replace(/\\x1b\\[B/g, '!dn!')   // D2: arrows usable\n      .replace(/\\x1b\\[C/g, '!rt!').replace(/\\x1b\\[D/g, '!lf!');\n    for (const ch of s) {\n      if (ch === ESC) continue;\n      key(ch);\n    }\n  });");
  edit('board.mjs',
    "if (ch === '[') { sel = Math.max(0, sel - 1); lastDetailSlot = -1; return; }",
    "if (ch === '!up!') { sel = Math.max(0, sel - 1); lastDetailSlot = -1; return; }   // D2\n    if (ch === '!dn!') { sel = Math.min(Math.max(0, live.length - 1), sel + 1); lastDetailSlot = -1; return; } // D2\n    if (ch === '[') { sel = Math.max(0, sel - 1); lastDetailSlot = -1; return; }");
} else if (title.startsWith('D3')) {
  // D3: orphan/requeue decisions during recovery are not persisted —
  // every `tide status` re-orphans the same slots
  edit('tide.mjs',
    "if (cmd === 'recover') {\n  const log = process.argv[3];",
    "if (cmd === 'recover') {\n  const log = process.argv[3];");
  edit('tide.mjs',
    "  const s = await sessionWith(cfg);\n  const orphans = s.recover(fs.readFileSync(log, 'utf8').split('\\n').filter((l) => l.trim()));",
    "  const s = await sessionWith(cfg);\n  s.core.logSink = (l) => fs.appendFileSync(log, l + '\\n');   // D3: persist recovery decisions\n  const orphans = s.recover(fs.readFileSync(log, 'utf8').split('\\n').filter((l) => l.trim()));");
} else if (title.startsWith('D4')) {
  // D4: permanent dispatch failures requeue forever — need a bounded retry
  // budget that fails the task CLOSED (M-5's own lesson, applied to TIDE)
  edit('core.mjs',
    "      case 'orphan':       return this.doOrphan(cmd);       // recovery fact",
    "      case 'orphan':       return this.doOrphan(cmd);       // recovery fact\n      case 'dispatch_fail': return this.doDispatchFail(cmd); // D4: bounded retry");
  edit('core.mjs',
    "    t.state = T_ASSIGNED; t.slot = slot; t.branch = branch;",
    "    t.state = T_ASSIGNED; t.slot = slot; t.branch = branch;\n    t.failCount = 0;");
  edit('core.mjs',
    "  doAbortTask({ task }) {",
    "  doDispatchFail({ task, reason }) {   // D4: bounded retry, then fail closed\n    const t = this.tasks[task];\n    if (!t) return;\n    t.failCount = (t.failCount ?? 0) + 1;\n    const s = t.slot != null ? this.slots[t.slot] : null;\n    if (s) { s.state = S_FREE; s.taskId = null; s.worktree = s.branch = null; }\n    this.effect('cleanup', { worktree: s?.worktree, branch: t.branch });\n    t.branch = null;\n    if (t.failCount >= 3) { t.state = T_FAILED; t.slot = null; t.note = `dispatch failed x3: ${reason}`; }\n    else { t.state = T_QUEUED; t.slot = null; }\n  }\n  doAbortTask({ task }) {");
  edit('core.mjs',
    "    t.state = T_QUEUED; t.slot = null;\n    this.effect('cleanup', { worktree: s?.worktree });",
    "    t.state = T_QUEUED; t.slot = null; t.failCount = 0;   // manual requeue resets the budget\n    this.effect('cleanup', { worktree: s?.worktree, branch: t.branch });   // D8: also drop the branch");
  edit('session.mjs',
    "  failDispatch(slot, reason) {\n    const s = this.core.slots[slot];\n    if (s.taskId != null) this.core.apply({ op: 'requeue', task: s.taskId }, true);\n  }",
    "  failDispatch(slot, reason) {\n    const s = this.core.slots[slot];\n    if (s.taskId != null) this.core.apply({ op: 'dispatch_fail', task: s.taskId, reason }, true);   // D4\n  }");
} else if (title.startsWith('D5')) {
  // D5: tide init hardcodes base 'main' — detect the repo's actual default
  edit('tide.mjs',
    "import fs from 'node:fs';\nimport path from 'node:path';",
    "import fs from 'node:fs';\nimport os from 'node:os';\nimport path from 'node:path';\nimport { execSync } from 'node:child_process';");
  edit('tide.mjs',
    "if (cmd === 'init') {\n  if (fs.existsSync(CONFIG)) { console.error('.tide.json exists'); process.exit(1); }",
    "if (cmd === 'init') {\n  if (fs.existsSync(CONFIG)) { console.error('.tide.json exists'); process.exit(1); }\n  let base = 'main';\n  try { base = execSync('git symbolic-ref --short HEAD', { cwd: process.cwd() }).toString().trim() || 'main'; } catch { /* D5: fall back */ }");
  edit('tide.mjs',
    "    base: 'main',\n    concurrency: 8,",
    "    base,   // D5: detected from the repo\n    concurrency: 8,");
} else if (title.startsWith('D6')) {
  // D6: spawn errors are unhandled — slot hangs in RUNNING forever
  edit('runner.mjs',
    "    child.on('exit', (code, signal) => {\n      this.procs.delete(slot);\n      this.session.agentExited(slot, code ?? 1, signal ? `signal ${signal}` : '');\n    });",
    "    child.on('exit', (code, signal) => {\n      this.procs.delete(slot);\n      this.session.agentExited(slot, code ?? 1, signal ? `signal ${signal}` : '');\n    });\n    child.on('error', (err) => {   // D6: spawn failures must not hang the slot\n      this.procs.delete(slot);\n      this.session.agentExited(slot, 1, `spawn error: ${err.message}`);\n    });");
} else if (title.startsWith('D8')) {
  // D8: requeue/orphan cleanup leaves the task branch behind — next dispatch
  // of the same task fails to create it. (Also extends cleanup() to take it.)
  edit('runner.mjs',
    "  cleanup({ worktree }) {\n    if (!worktree) return;",
    "  cleanup({ worktree, branch }) {   // D8: branches die with their worktree\n    if (branch) { try { this.sh(`git branch -D ${branch}`, this.cfg.repo); } catch { /* already gone */ } }\n    if (!worktree) return;");
} else if (title.startsWith('D9')) {
  // D9: gh pr create failures vanish silently — the operator never learns
  edit('runner.mjs',
    "    } catch { /* gh absent or PR exists */ }",
    "    } catch (err) {   // D9: surface the PR failure to the operator\n      console.error('[tide] gh pr create failed (branch pushed — create the PR manually):', String(err.message ?? err).slice(0, 140));\n    }");
} else {
  console.error(`[dogfood-agent] unknown task: ${title}`);
  process.exit(1);
}
process.exit(0);
