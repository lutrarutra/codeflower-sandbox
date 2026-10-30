---
title: Wrap up
description: Stop the current step and preserve progress.
icon: debug-stop
mode: interrupt
---
I stopped your last step: wrap up now. Do not start new work and do not restart long computations. Finish within a few minutes.

1. Save results and intermediate data you would need again to files in the workspace or the output folder.
2. Update `PROGRESS.md` in the workspace with:
   - what was done, and the results so far with how far to trust them
   - the assumptions made
   - what is half-done, including the step I stopped and how to resume it
   - what was planned but not done, and why
3. If there is a report, bring it up to date with the same content (including a section on what was not done), finalize it, run `storyteller check`, and copy it to `/data/output` if an output folder is mounted.

Then tell me in a few lines where things stand.
