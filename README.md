# TIDE — an agent-first IDE

**Task Integration & Dispatch Environment.** One human, tens of AI agents,
fast code changes, gated PRs. A cockpit, not a chat window: agents work in
isolated git worktrees, their results hit a local gate (tests), and merges go
out as batched, reviewable pull requests.

Zero runtime dependencies. Node ≥ 18.

```sh
cd your-repo
tide init                    # writes .tide.json (agentCommand, gateCommand, cap)
tide                         # the cockpit
```

## How it works

```
you ──n──▶ task queue ──M-5 policy──▶ agent slots (git worktrees)
              (capped pool)            │  claude/opencode/codex runs here
                                       ▼
                          agent exits → local gate (your tests)
                                       ▼
                        READY ──m/M──▶ merge batch → commit → push → PR
```

- **Dispatch** (M-5 measured slowdown): concurrency cap + staggered dispatch.
  When fan-out is hot, tasks **queue** — the host never melts, the board
  never stalls. `+`/`-` adjust the cap live.
- **Slots** (M-2 fixed pools): 32 agent slots, 4,096 task slots, capped output
  rings per agent. Bounded memory no matter the churn; slots recycle on merge.
- **Isolation** (Duke3D/Build cache discipline): every agent works in its own
  `git worktree` on branch `tide/t{id}`, removed on merge/abort.
- **Gates**: an agent that exits 0 runs your `gateCommand` in its worktree.
  Fail → the change is marked FAILED with the tail of the gate output; the
  operator requeues or aborts. No untested change reaches a PR.
- **Merge** (M-3 deferred application): merge requests batch at the frame
  boundary — commit, push, `gh pr create`, then the slot recycles.
- **Audit + recovery** (M-4 replay determinism): every decision is a logged
  command (allocator choices included). The log replays to a **byte-identical
  board hash** — `tide recover` restores a crashed session, requeues orphaned
  agents, and you lose nothing. Replay fires zero side effects: decisions are
  data.

## Keys (cockpit)

`n` new task · `]`/`[` select slot · `m` merge selected (must be gate-passed)
· `M` merge ALL ready (batch) · `g` re-run gate · `r` requeue · `a` abort ·
`+`/`-` concurrency cap · `q` quit.

## Headless (CI / scripts / other agents)

```sh
tide init && $EDITOR .tide.json
tide add "fix the flaky login test" "repro steps: ..."
tide status                     # recover log + print the board
tide merge-all                  # batch-merge every gate-passed agent
```

`--script` file: `add <title>` / `cap N` / `wait N` / `merge-all` / `report`.

## Config (`.tide.json`)

```json
{
  "repo": "/path/to/repo",
  "base": "main",
  "concurrency": 8,
  "worktreeDir": ".tide",
  "agentCommand": "claude -p \"$(cat {taskFile})\"",
  "gateCommand": "npm test",
  "autoMerge": false
}
```

`agentCommand` runs in the slot's worktree; `{taskFile}` is the task text
(`{task}`, `{title}`, `{slot}` also substituted). Swap in `opencode run`,
`codex`, `aider`, or anything — **TIDE is agent-agnostic by design**.

## Honest limits (v0.1)

- One repo per cockpit; base branch is assumed fetched.
- Gate = a single shell command; exit 0 = pass.
- PR creation needs `gh` + a pushed remote; without them, merges still
  commit locally and the PR step is skipped.
- Board TUI is raw-ANSI, arrow keys not yet bound; core is fully
  headless-tested (26 tests: cap/stagger, lifecycle, gate fail, replay,
  recovery, batched merge, abort, pool bounds).

## Where the mechanisms come from

Every discipline above is one of the mechanisms cataloged with binary-level
evidence and modern transfer tests in
[retro-efficiency-lab](https://github.com/rajat397/retro-efficiency-lab):
slot pools (TH04 1998), index-linked lists (Build 1996 / RCT2 2002), deferred
application (TH04 / Another World 1991), replay determinism (Doom 1993),
measured slowdown (TH04). The IDE is the proof that they compose into a
product for a problem they never faced: orchestrating tens of AI agents.

MIT.
