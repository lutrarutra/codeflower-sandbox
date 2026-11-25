---
name: codeflower-watch
description: Wait for something without holding your turn - codeflower-watch runs a command every so often until a condition holds (exit status, output pattern, or a change) and then sends you a message with its output, also while no one is connected. Use instead of sleep loops or polling by hand, e.g. for a pull request to be merged or closed, CI to finish, a file or result to appear, a server to answer, or a log to reach a line.
---

# Waiting with codeflower-watch

The code flower worker runs the command for you and tells this chat when it is done, with the last
run's output. Meanwhile your turn is free: end it, and the user sees the watch in the chat's footer
(they can open its output and stop it). It keeps running while no window is connected.

## Starting one

```sh
codeflower-watch start [--every TIME] [--until COND] [--timeout TIME] [--name NAME] -- COMMAND
```

- `COMMAND` runs with `sh -c` in the folder you are in, with your environment. Quote it as one
  argument when it has pipes or `;`, or put options after `--`.
- `--every` (default 1m, at least 10s): pick what fits how fast the thing changes. A PR review or CI:
  2-5m. A local server starting: 10-30s. An hours-long result: 10-30m.
- `--until`:
  - `exit` (default): the command exits 0 when done and 1 when not yet. Any other exit status
    is an error. Write the command to answer that way: `test -f out/done`, `curl -sf URL`,
    `grep -q 'Finished' logs/run.log`.
  - `match:REGEX`: done when its output matches (a JavaScript regular expression; ^ and $ match at each line). The command must
    exit 0.
  - `change`: done when its output differs from the first run's.
- `--timeout` (default 24h, at most 7d): when it gives up and tells you so. Choose it by how
  clear the end is:
  - **A clear, cheap condition** (a PR merged or closed, CI finished, a file written): one watch
    with a long timeout (the default). Waiting costs nothing; every message to you costs a turn.
  - **Something you should look at now and then** (a slow job whose log may stall, a service that
    may never come up, a result you are not sure will come): a short timeout, 1-2h. When it times
    out, read its output (`codeflower-watch logs ID --tail 50`), then `codeflower-watch rearm ID`
    if it is still worth waiting for, or stop and tell the user what you found.
  Don't re-arm out of habit: each one is a turn, and the chat's context is read again in full.
- `--name`: a short name for the footer and the message.

The first run happens at once and is printed. Check that it reads as you meant (`not yet`). A
first run that is an error does not start the watch, so a typo shows straight away.

The watch ends, and you get one message, when:
- the condition holds (`met`);
- it times out (`timeout`);
- three runs in a row are errors, or take longer than 5 minutes (`failing`): read the output and
  fix the command;
- the user stops it (`stopped`).

You get no message for watches you stop yourself. Watches stop with the sandbox. When wrapping up,
note the ones still running, so a later session can start them again.

## Examples

```sh
# A pull request merged or closed
codeflower-watch start --every 3m --name 'PR 12' --until 'match:"state": *"(MERGED|CLOSED)"' \
  -- gh pr view 12 --json state

# CI on the branch done (any conclusion)
codeflower-watch start --every 2m --name CI --until 'match:^(success|failure|cancelled)' \
  -- 'gh run list --branch feature --limit 1 --json conclusion --jq ".[0].conclusion"'

# A result file written
codeflower-watch start --every 1m -- test -s results/summary.tsv

# A local server answering
codeflower-watch start --every 10s --timeout 10m -- curl -sf http://127.0.0.1:8000/health

# A log reaching its last step, or failing
codeflower-watch start --every 1m --until 'match:(Finished|Error|Traceback)' -- tail -n 50 logs/pipeline.log
```

## For an idea in Roots

When an idea in the map waits for the thing you watch, start the watch with `--idea ID` (or link a
running one: `codeflower-watch link WATCH IDEA`). The watch becomes one of the idea's needs, which
the user sees on the map, and an active idea is set to blocked. When the condition holds, the need
is met and the idea is active again once nothing else blocks it; your message says so. If the watch
ends otherwise (failing, timed out, stopped, or the sandbox stopped), the need stays open, marked
with how it ended, so you or a later session can start another watch for it.

## Following and stopping

- `codeflower-watch list` shows this chat's watches (`--all`: every chat's), with their runs and
  when the next one is.
- `codeflower-watch show ID` shows a watch's last runs (exit status, verdict) and the last output.
  `logs ID` prints all runs' output (`--run N` for one, `--tail N` for the end). Use these when a
  watch seems stuck or reads wrongly, then `stop` it and start a corrected one.
- `codeflower-watch stop ID` (or `--all`) stops a watch.
- `codeflower-watch check ID` runs its command now instead of at the next run: when you have a
  reason to think the condition holds (the user says the PR is merged, you just pushed the fix),
  rather than waiting out the interval. It prints the output; if the condition holds, the watch
  ends right there and you get no message for it. The user can do the same from the chat's
  footer, and then you are told if it is met.
- `codeflower-watch rearm ID [--timeout TIME] [--every TIME] [--until COND] [--reset]` starts one
  that timed out, failed (fix the cause first) or was stopped again as it was: same id, log and
  Roots need. On a running watch it counts the timeout from now. `--every` and `--until` change
  how it runs; `--reset` (implied by a new `--until`) forgets its errors so far, and for `change`
  compares with the next run instead of the first. Prefer it to a new watch for the same thing;
  to watch a different command, stop it and start a new one.

## Waiting in the foreground

`--wait [TIME]` on `start` (or `codeflower-watch wait ID [TIME]`) keeps the command until the watch
ends, for at most TIME (default 85s). Use it only for short waits that your next step needs right
away. If the time runs out, or your shell tool stops the command, the watch keeps running and you
get the message later. Exit status: 0 met, 1 ended otherwise, 4 still watching.

## What not to use it for

- Batch jobs (`codeflower-job`) and the other chats you start already tell you when they end.
- Work you start yourself: run it in the background with output to `logs/`. Then, if you need to
  know when it finishes, watch for its result or log line.
- Commands that change things: a watch should only look. Re-running a change every minute is a
  loop, not a watch.
