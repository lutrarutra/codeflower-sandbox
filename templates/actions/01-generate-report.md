---
title: Generate report
description: Write a report from this chat's existing results.
icon: book
mode: queue
---
Write a report of the work in this chat, using the storyteller skill.

First look in `reports/` (`storyteller outline`) for a report that already covers this work. If there is one, update it instead of starting another, and tell me.

Build the report from what exists: the results, figures and tables already made. Do not rerun long computations. If a number or figure is missing and quick to make, make it; otherwise say in the report that it is missing. Open with the summary, then cover data, methods (tools, versions, parameters), results, and limitations and open questions. Keep the code that writes each section in a script, so it can be rerun.

Show the report with `codeflower-show` once the outline is up. When it is complete, finalize it, run `storyteller check`, and if an output folder is mounted under `/data/output`, copy the HTML there. Then tell me in a few lines what the report covers and what it leaves out.
