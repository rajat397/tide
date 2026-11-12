// dogfood-agent.mjs — the agent under test: reads its task file and applies
// one scripted-but-real defect fix in its worktree. Each fix is a genuine
// code change; the gate (node test.mjs) validates it. Deletes the task file
// after reading so it never leaks into a merge.
import fs from 'node:fs';

const taskFile = process.argv[2];
const task = fs.readFileSync(taskFile, 'utf8');
fs.unlinkSync(taskFile);                       // never commit the task file

const title = task.split('\n')[0];
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
} else {
  console.error(`[dogfood-agent] unknown task: ${title}`);
  process.exit(1);
}
process.exit(0);
