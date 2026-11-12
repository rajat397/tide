// tide/runner.mjs — the effect boundary: worktrees, agent processes, gates,
// merges. Everything here is real-world effectful; the core never touches it
// directly (and never during replay). All shell-outs are injectable for tests.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class RealRunner {
  constructor({ cfg, core, session }) {
    this.cfg = cfg;                  // {repo, base, agentCommand, gateCommand, concurrency}
    this.core = core;                // OrchestrationCore
    this.session = session;          // wires effects back into requests
    this.procs = new Map();          // slot -> child process
    this.busy = false;
  }

  onError(err, kind) { console.error(`[tide] effect '${kind}' failed: ${err.message ?? err}`); }

  sh(cmd, cwd) {
    return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  }

  async onEffect(kind, p) {
    try {
      if (kind === 'worktree+spawn') await this.worktreeAndSpawn(p);
      else if (kind === 'gate') this.runGate(p);
      else if (kind === 'merge') await this.doMerge(p);
      else if (kind === 'kill') this.kill(p);
      else if (kind === 'cleanup') this.cleanup(p);
    } catch (err) {
      // effect failure -> record as a fact command, never throw into core
      if (kind === 'worktree+spawn') this.session.failDispatch(p.slot, String(err.message ?? err));
      else if (kind === 'merge') this.session.mergeFailed(p.slot, String(err.message ?? err));
    }
  }

  async worktreeAndSpawn({ slot, task, title, body, branch, worktree }) {
    const wt = path.resolve(this.cfg.repo, worktree);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    this.sh(`git worktree add -f "${wt}" -b ${branch} ${this.cfg.base ?? 'main'}`, this.cfg.repo);
    // task text via file (CLIs choke on quoting); template may use {task} too
    const taskFile = path.join(os.tmpdir(), `tide-task-${task}.txt`);   // D1: outside the worktree — never committed
    fs.writeFileSync(taskFile, `# ${title}\n\n${body}\n`);
    const cmd = (this.cfg.agentCommand ?? 'claude -p "{taskFile}"')
      .replaceAll('{taskFile}', taskFile)
      .replaceAll('{task}', `$(cat ${JSON.stringify(taskFile)})`)
      .replaceAll('{title}', title)
      .replaceAll('{slot}', String(slot));
    const child = spawn(cmd, { cwd: wt, shell: true, detached: false });
    this.procs.set(slot, child);
    this.core.slots[slot].pid = child.pid;
    const pushOut = (chunk) => this.session.pushOut(slot, chunk);
    child.stdout.on('data', pushOut);
    child.stderr.on('data', pushOut);
    child.on('exit', (code, signal) => {
      this.procs.delete(slot);
      this.session.agentExited(slot, code ?? 1, signal ? `signal ${signal}` : '');
    });
  }

  runGate({ slot, worktree }) {
    const wt = path.resolve(this.cfg.repo, worktree);
    const cmd = this.cfg.gateCommand ?? 'npm test';
    try {
      const out = this.sh(cmd, wt);
      this.session.gateResult(slot, true, out.split('\n').slice(-6).join('\n'));
    } catch (err) {
      const out = String((err.stdout ?? '') + (err.stderr ?? err.message ?? ''));
      this.session.gateResult(slot, false, out.split('\n').slice(-12).join('\n'));
    }
  }

  async doMerge({ slot, worktree, branch, title, task }) {
    const wt = path.resolve(this.cfg.repo, worktree);
    const sh = (c) => this.sh(c, wt);
    sh('git add -A');
    let commit;
    try {
      commit = sh(`git -c user.name=tide -c user.email=tide@local commit -m ${JSON.stringify(`tide: ${title} (task ${task}, agent slot ${slot})`)}`).match(/[\w]{7,}/)?.[0] ?? 'local';
    } catch {
      commit = sh('git rev-parse --short HEAD'); // empty diff commit?
    }
    // push (skip quietly when no remote — local-only repos still get commits)
    let prUrl = null;
    try { sh(`git push -u origin ${branch}`); } catch { /* no remote */ }
    try {
      prUrl = this.sh(`gh pr create --title ${JSON.stringify(title)} --body ${JSON.stringify(`Task ${task} dispatched by TIDE (slot ${slot}).\nAgent branch: ${branch}\nGate: passed locally.`)}`, this.cfg.repo).match(/https:\/\/\S+/)?.[0] ?? null;
    } catch { /* gh absent or PR exists */ }
    this.session.merged(slot, commit, prUrl);
  }

  kill({ pid }) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }

  cleanup({ worktree, branch }) {   // D8: branches die with their worktree
    if (branch) { try { this.sh(`git branch -D ${branch}`, this.cfg.repo); } catch { /* already gone */ } }
    if (!worktree) return;
    try {
      const wt = path.resolve(this.cfg.repo, worktree);
      this.sh(`git worktree remove --force "${wt}" || rm -rf "${wt}"`, this.cfg.repo);
      this.sh(`git worktree prune`, this.cfg.repo);
    } catch { /* best effort */ }
  }

  diffStat(slot) {
    const s = this.core.slots[slot];
    if (!s?.worktree) return null;
    try {
      const wt = path.resolve(this.cfg.repo, s.worktree);
      return this.sh(`git diff ${this.cfg.base ?? 'main'}...HEAD --stat`, wt).split('\n').slice(-8).join('\n');
    } catch { return null; }
  }
}
