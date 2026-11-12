# D13: nested headless agent transport is broken in this environment

*Found 2026-11-12, immediately after the operator actually switched modes
(the R&D note's predicted failure point).*

## What happened

Wiring TIDE to real agent dispatch (`agentCommand: 'opencode run ...'` in
the lab repo) hit the transport before any dispatch could complete:

- `opencode run "..."` (1.18.35, headless) fails with
  `UnknownError: Unexpected server error` (refs err_56b740b3, err_d8bada48,
  err_0710e4a1 across attempts).
- Reproduces with an isolated `XDG_DATA_HOME` + copied `auth.json` — not a
  data-dir conflict.
- Likely conflict with the operator's own live interactive opencode
  session (shared server/port), unverified.
- `claude -p` alternative: `Not logged in` — no headless auth configured.

## Consequence

TIDE's runner cannot delegate to a headless agent CLI from inside the
operator's own live opencode session. The first real cognition-dispatch
therefore went through the harness's native subagent tool instead, with
TIDE's discipline (task files, quality gates, findings review) applied
around it — proving the *gate discipline* transfers even when the runner
transport does not.

## Status / next probes

- Reproduce `opencode run` outside a live session (user terminal, CI) to
  separate "nested-mode bug" from "environment restriction".
- Check opencode server logs for the err_ refs.
- Candidate mitigations: a documented `--headless-isolated` mode for
  opencode run; or `claude` auth setup making it a second transport.
- Gate discipline (task file + assertions + findings review) is transport-
  independent and already proven — see lab session addendum 22.
