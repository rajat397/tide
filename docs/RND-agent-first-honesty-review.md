# R&D: Is TIDE actually useful to the agent that built it?

*2026-11-12 — honesty review after the first dogfood (see `SESSION-LOG.md`)*

## The finding

The dogfood session (11 defects found and fixed, 10 PRs merged) validated
TIDE's **mechanics** — but broke its own promise. Reviewing that session
honestly: **the agents were spectators, not operators.** Every fix was
authored by the session agent in a script (`dogfood-agent.mjs`) *before*
TIDE ever ran; the "agent slots" executed pre-made decisions. TIDE ran the
plumbing (worktrees → gate → merge → PR) while the cognition stayed inline
in one serial session — exactly the work style TIDE exists to change.

The tell: zero concurrency happened that wasn't staged. Ten agent slots
existed; no two tasks ever did independent work.

## Why it happened

Not a missing feature — `agentCommand` always supported real agent CLIs
(`opencode run` 1.18.35 verified on this machine; `claude` also present).
What was missing was the operator *switching their own mode*: the builder
kept doing everything inline instead of dispatching. "Agent-first" was
designed for a human and never re-pointed at the agent.

## Where TIDE genuinely helps an agent (measured against this session's work)

1. **Truly parallel, independently gated analysis.** The lab's transfer-test
   sweep (10 benches) and Target 5's probes are independent tasks with
   decidable gates — serial execution was the *default*, not a choice.
   `agentCommand: 'opencode run "$(cat {taskFile})"'` dispatches each to a
   real agent instance in its own worktree; the gate accepts only
   gate-passing work.
2. **The gate replaces "trust my analysis."** A findings file with
   assertions the gate checks is the lab's evidence-card discipline applied
   to the agent's own output.
3. **Audit.** Every dispatch/accept/reject is a replayable command log
   (M-4) instead of scrollback archaeology.
4. **Token economics.** A dispatched instance's context is the task file,
   not the operator's whole session — cheaper per task for mechanical,
   well-specified work.

## Where it does not help (and shouldn't pretend to)

- **Sequential/creative work.** Choosing the next bench, debugging a novel
  failure mode, designing an API: dispatching needs well-specified tasks
  with decidable gates. An under-specified dispatch spins or ships
  plausible-sounding garbage — the gate is what makes failure *visible*,
  not what prevents it.
- **Cost discipline.** Each dispatch is a full agent session (real model
  spend). It pays only when tasks are independent and would otherwise run
  serially. A single fix is faster inline; five independent probes are not.
- **Context quality is the bottleneck.** The task file IS the dispatched
  agent's world. Task-file authoring is the operator's real job.

## The wiring (verified present on this machine)

```json
{ "agentCommand": "opencode run \"$(cat {taskFile})\"", "gateCommand": "<per-task check>" }
```

First real application: the lab repo's Target 5 (RCT guest-generation law,
peep pathfinding) — two independent probes, dispatched, gated, merged.

## Design lessons recorded

1. **"Agent-first" must mean the agent is the operator, not the spectator.**
   A tool can pass its own dogfood while violating its thesis.
2. **Concurrency that isn't used isn't a feature** — the 32-slot pool is
   worth nothing until someone dispatches two things at once.
3. **The gate is the load-bearing part for agent dispatch** (the same
   lesson as the lab's evidence cards: uncheckable output is noise).
4. **Honesty check for every future dogfood:** count how much of the work
   the dispatched agents *decided* vs executed. If the number is zero,
   the loop is theater.

*Companion analysis lives in retro-efficiency-lab `sessions/` (addendum 21).*
