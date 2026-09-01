---
name: manage-t3-threads
description: Create, inspect, monitor, settle, or reopen separate durable T3 Code threads through the `t3 thread` CLI. Use only when the user explicitly asks to create or operate a T3 Code thread, or names a `t3 thread` command; do not use for ordinary subtasks, generic delegation or parallelization, current-thread work, internal subagents, or non-T3 conversation, GitHub, or OS threads.
---

# Manage T3 Threads

Operate durable work in a running T3 Code environment only when the user explicitly requests a
separate T3 thread or asks about an existing one. A T3 thread is externally persisted work, not an
internal reasoning subtask or disposable subagent.

## Choose an operation

- Use `t3 thread run` to create a separate T3 thread and start its first agent turn.
- Use `t3 thread list` when the user asks which T3 threads are active or settled.
- Use `t3 thread status` to inspect a specific durable thread.
- Use `t3 thread settle` or `unsettle` only when the user explicitly asks to change that lifecycle
  state.
- When the user explicitly asks to wait, monitor with read-only status checks. Waiting never
  authorizes settlement.

Do not create a T3 thread merely because work could be parallelized or is somewhat independent.
Continue ordinary work in the current thread and use normal internal delegation unless the user
specifically asks for T3 Code threads.

## Use the installed CLI

Run `t3 thread <command> --help` when the installed version's flags are uncertain. Do not bypass
the CLI through T3's private HTTP/WebSocket APIs or write its database directly.

For short prompts, pass the prompt as the positional argument:

```sh
t3 thread run "Investigate the failing release checks" --project /path/to/project --json
```

Use `--prompt-file` for multiline or shell-sensitive prompts. Pass `--title` only when the user
wants a fixed title; otherwise let T3 derive and generate the title from the prompt. Prefer an
explicit `--project` for scheduled or background commands whose working directory may be
unreliable. Use `--base-dir` when targeting a non-default T3 environment, retain that environment
alongside the returned thread ID, and ask rather than guessing when the environment is ambiguous.

Use `--json` for automation and retain every returned thread ID. A successful `run` means T3
accepted the new thread and first turn, not that the agent completed the work.

## Inspect and report accurately

`list` and `status` are read-only. Preserve and report the exact lifecycle, session, and turn state
returned by the installed CLI. Do not infer completion merely because output paused or a client
disconnected.

When the user asks to wait, first inspect `t3 thread status --help` for a supported read-only watch
or wait option. If none exists, perform bounded `status --json` checks at a conservative cadence,
respect the user or tool deadline, and preserve the thread ID for a later check. Never substitute
`settle` for waiting.

The current CLI reports provider and turn state but not per-thread terminal subprocesses. If the
user asks for process details that the installed CLI cannot provide, state that limitation instead
of guessing from the environment process tree.

Settling is an explicit lifecycle mutation, not a wait operation. Never use `settle` to mean “wait
until finished,” and do not settle a thread unless the user asked to mark it done. Before `t3
thread settle THREAD_ID` or `t3 thread unsettle THREAD_ID`, run a read-only status check to confirm
the exact target and current state. Do not interrupt work to force settlement. Report the state
before and after the mutation; settlement does not prove the agent's work completed successfully.

## Preserve authority and avoid duplicates

- Create only the number of T3 threads the user requested. Do not recursively fan out from them
  without separate authorization.
- Preserve the requested project, provider defaults, permission mode, and prompt. Do not broaden
  runtime permissions to make an unattended run proceed.
- The current command creates work in the project's shared checkout. If there is evidence of other
  active write-capable work there, warn or ask before launching an overlapping writer; do not
  invent a worktree flag.
- After a timeout, malformed response, or lost connection, inspect `list` or `status` before
  retrying `run`; an uncertain response may already have created the thread.
- Do not delete, interrupt, send follow-ups, change permissions, start or stop T3 services, update
  T3, or install anything unless the user requested that action.
- Never expose bearer tokens, pairing credentials, prompt secrets, or raw authentication output.
- If the server, authentication, project, or installed CLI blocks the operation, report the exact
  blocker and preserve any known thread ID.
