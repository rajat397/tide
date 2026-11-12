# TIDE dogfood log — 2026-11-12

TIDE was used to improve TIDE: 11 real defects found by working with it,
each fixed through the full loop (task → worktree agent → local gate →
merge → push → PR → operator merge → master gate).

## Defects found and fixed

| ID | Defect | Status |
|---|---|---|
| D1 | task files written inside worktrees get committed into merges/PRs | PR #1 ✓ |
| D2 | board ignores ESC sequences — arrow keys dead | PR #2 ✓ |
| D3 | recovery decisions not persisted across status runs | PR #3 ✓ |
| D4 | permanent dispatch failures requeue forever (infinite loop, seen live) | PR #6 ✓ (bounded retry → fail closed) |
| D5 | `tide init` hardcodes base 'main' (repo was master — found immediately) | PR #7 ✓ |
| D6 | spawn errors unhandled — slot hangs RUNNING forever | PR #8 ✓ |
| D7 | `--script` wait advanced loop turns, not wall clock — children killed before exit events | fixed in harness ✓ |
| D8 | requeue/orphan cleanup leaves the task branch — next dispatch fails | PR #4 ✓ |
| D9 | `gh pr create` failures swallowed silently | PR #5 ✓ (now surfaced) |
| D10 | `--script` starts a fresh session — task IDs restart, branch names collide | PR #9 ✓ |
| D11 | FAILED tasks never clean up worktree+branch | direct patch ✓ (agent edit lost to branch reuse — see wrinkle) |

## Wrinkles found in the harness itself (not TIDE defects)

- agent title prefix dispatch: 'D10'.startsWith('D1') — fixed with exact
  'D<n>:' matching; syntax error in a block move caught by node --check.
- The D11 agent edit was lost when a run reused the previous run's branch
  (task IDs restarting — the very thing D10 fixes). D11 was patched
  directly and noted here.

## Verified outcomes

- 10 PRs opened and merged on github.com/rajat397/tide.
- Master passes all 26 core tests after every merge.
- Full lifecycle logs on every run: add_task → dispatch → complete →
  gate_result → merge_req → merged, with cap-staggered dispatch.
- Live demonstrations of failure modes: the D4 infinite requeue loop, the
  D8 stale-branch cascade, the D9 silent PR failure (before and after).
