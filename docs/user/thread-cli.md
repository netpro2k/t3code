# Managing threads from scripts

The `t3 thread` command creates and manages ordinary T3 Code threads from scripts. Runs use the
configured provider through the running T3 server, so their messages, checkpoints, approvals, and
status remain visible in the web, desktop, and mobile clients.

The command targets the local T3 environment selected by `--base-dir`. A running server is
required; thread commands never write a turn into an offline database because no provider would be
available to execute it. For unattended use, first configure the [background
service](./background-service.md).

## Start a thread

Pass a short prompt directly:

```sh
t3 thread run "Review the open pull requests and identify anything blocked"
```

For multiline prompts or prompts containing shell-sensitive text, use a file:

```sh
t3 thread run --prompt-file ./nightly-review.md
```

The current directory selects the project by default when it is the registered workspace root. Use
a project ID or its exact workspace path when a scheduled job has a different working directory:

```sh
t3 thread run "Run the nightly repository audit" --project /path/to/project
```

T3 seeds the initial title from the prompt and then applies the same first-turn title generation as
an interactively created thread. `--title` keeps an explicit title instead:

```sh
t3 thread run "Inspect today's dependency changes" --title "Daily dependency audit"
```

Exactly one inline prompt or `--prompt-file` is required. A successful command means the turn was
accepted, not that the agent finished. Use `--json` to receive the project ID, thread ID, committed
sequence, and initial status for another script:

```sh
t3 thread run "Check release readiness" --json
```

If the server cannot confirm creation or first-turn startup, the error includes the candidate or
preserved thread ID. Check that ID with `status` or `list` before retrying so a timeout cannot create
duplicate work.

New scripted threads use the project's default model and the shared project checkout. The default
permission mode matches new interactive threads (`full-access`); select a different mode when the
job should pause or constrain changes:

```sh
t3 thread run "Audit this repository without changing it" --runtime-mode approval-required
```

Avoid overlapping write-capable runs in the same checkout. Isolated worktree creation is not yet
available through this command.

## Inspect threads

List threads that have not been explicitly settled:

```sh
t3 thread list
```

Use `--state settled` or `--state all` to change the filter, and `--project` to restrict the result
to one project. `--json` provides machine-readable output.

The active filter follows the explicit settle lifecycle. T3 clients may additionally hide quiet
threads through local inactivity and pull-request rules, so the command's active list can be broader
than a client's current inbox.

Inspect one thread using the durable ID returned by `run` or `list`:

```sh
t3 thread status THREAD_ID
```

Status distinguishes queued, starting, working, blocked on approval or input, background work,
failure, completion, idle, and settled states. It reports provider and turn state but does not list
terminal subprocesses; per-thread terminal metadata is currently available only through T3's live
client connection.

## Settle and reopen threads

Mark completed work as settled:

```sh
t3 thread settle THREAD_ID
```

T3 rejects settling a thread that is still starting, running, queued, or waiting for user input.
Settling also requests that an idle provider session stop. Reopen a settled thread with the reverse
operation:

```sh
t3 thread unsettle THREAD_ID
```

Both commands support `--json`.
