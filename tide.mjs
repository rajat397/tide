#!/usr/bin/env node
// tide.mjs — TIDE: Task Integration & Dispatch Environment.
//   tide                       cockpit TUI (in a git repo with .tide.json)
//   tide init                  write a .tide.json template
//   tide add "title" [body]    queue a task headlessly
//   tide status                print the board
//   tide merge-all             merge every gate-passed agent (batched)
//   tide recover LOG           replay a crashed session's log
//   tide --script CMDFILE      headless scripted session (CI)

import fs from 'node:fs';
import path from 'node:path';

const cmd = process.argv[2];
const CONFIG = path.resolve(process.cwd(), '.tide.json');

const loadCfg = () => {
  if (!fs.existsSync(CONFIG)) {
    console.error(`no ${CONFIG} — run: tide init`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
};
const sessionWith = (cfg) => import('./session.mjs').then(({ TideSession }) => {
  const s = new TideSession({ cfg });
  return import('./runner.mjs').then(({ RealRunner }) => {
    s.setRunner(new RealRunner({ cfg, core: s.core, session: s }));
    return s;
  });
});

const logPath = (cfg) => path.resolve(cfg.repo ?? process.cwd(), '.tide-log.jsonl');

if (cmd === 'init') {
  if (fs.existsSync(CONFIG)) { console.error('.tide.json exists'); process.exit(1); }
  fs.writeFileSync(CONFIG, JSON.stringify({
    repo: process.cwd(),
    base: 'main',
    concurrency: 8,
    worktreeDir: '.tide',
    agentCommand: 'claude -p "$(cat {taskFile})"',   // or: opencode run "$(cat {taskFile})"
    gateCommand: 'npm test',
    autoMerge: false,
  }, null, 2) + '\n');
  console.log(`wrote ${CONFIG} — edit agentCommand/gateCommand for your stack`);
  process.exit(0);
}

if (cmd === 'add') {
  const cfg = loadCfg();
  const title = process.argv[3];
  if (!title) { console.error('usage: tide add "title" [body]'); process.exit(1); }
  const s = await sessionWith(cfg);
  // continue ids from the existing log; new cmds append synchronously
  if (fs.existsSync(logPath(cfg))) s.core.replay(fs.readFileSync(logPath(cfg), 'utf8').split('\n').filter((l) => l.trim()));
  s.core.logSink = (l) => fs.appendFileSync(logPath(cfg), l + '\n');
  s.addTask(title, process.argv[4] ?? '');
  console.log(`queued task #${s.core.tasks.filter(Boolean).at(-1).id} — the cockpit (tide / tide --script) will dispatch it`);
  process.exit(0);
}

if (cmd === 'status') {
  const cfg = loadCfg();
  const s = await sessionWith(cfg);
  const lines = fs.existsSync(logPath(cfg)) ? fs.readFileSync(logPath(cfg), 'utf8').split('\n') : [];
  s.recover(lines.filter((l) => l.trim()));
  console.log(`cap ${s.core.cap} │ running ${s.core.running} │ queued ${s.core.queued} │ ready ${s.core.slotsIn('READY').length} │ failed ${s.core.slotsIn('FAILED').length}`);
  for (const t of s.core.tasks.filter(Boolean)) {
    const slot = t.slot != null ? s.core.slots[t.slot] : null;
    console.log(`  #${t.id} ${t.state.padEnd(8)} ${t.title.slice(0, 60)}${slot ? ` (slot ${slot.slot}, ${slot.state}${slot.prUrl ? ', ' + slot.prUrl : ''})` : ''}`);
  }
  process.exit(0);
}

if (cmd === 'merge-all') {
  const cfg = loadCfg();
  const s = await sessionWith(cfg);
  const lines = fs.existsSync(logPath(cfg)) ? fs.readFileSync(logPath(cfg), 'utf8').split('\n') : [];
  s.recover(lines.filter((l) => l.trim()));
  // gate-passed agents from the recorded log are READY; merge in one batch
  s.mergeAllReady();
  for (let i = 0; i < 4; i++) s.tick();
  for (const t of s.core.tasks.filter(Boolean)) {
    if (t.state === 'MERGED') console.log(`  merged #${t.id} ${t.title}`);
  }
  const all = fs.readFileSync(logPath(cfg), 'utf8').split('\n').filter((l) => l.trim());
  fs.appendFileSync(logPath(cfg), s.core.log.slice(all.length).map((e) => JSON.stringify(e)).join('\n') + '\n');
  process.exit(0);
}

if (cmd === 'recover') {
  const log = process.argv[3];
  if (!log || !fs.existsSync(log)) { console.error('usage: tide recover <log.jsonl>'); process.exit(1); }
  const cfg = loadCfg();
  const s = await sessionWith(cfg);
  const orphans = s.recover(fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.trim()));
  console.log(`replayed log — ${orphans} orphaned agent(s) requeued; tasks in queue: ${s.core.queued}`);
  process.exit(0);
}

if (cmd === '--script') {
  const file = process.argv[3];
  const cfg = loadCfg();
  const s = await sessionWith(cfg);
  s.core.logSink = (l) => fs.appendFileSync(logPath(cfg), l + '\n');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [op, ...rest] = line.split(' ');
    if (op === 'add') s.addTask(rest.join(' '), '');
    else if (op === 'cap') s.setCap(Number(rest[0]));
    else if (op === 'wait') {
      // D7: children need wall-clock time to boot/exit; tick at ~10Hz
      for (let i = 0; i < Number(rest[0] ?? 10); i++) {
        s.tick();
        await new Promise((r) => setTimeout(r, 100)); // real time, not loop turns
      }
    }
    else if (op === 'merge-all') { s.mergeAllReady(); s.tick(4); }
    else if (op === 'report') {
      const snap = s.core;
      console.log(`hash ${snap.boardHash()} running=${snap.running} queued=${snap.queued}`);
    }
  }
  process.exit(0);
}

// default: cockpit TUI
const cfg = loadCfg();
const { runBoard } = await import('./board.mjs');
await runBoard({ cfg: { ...cfg, _logSink: (l) => fs.appendFileSync(logPath(cfg), l + '\n') } });
