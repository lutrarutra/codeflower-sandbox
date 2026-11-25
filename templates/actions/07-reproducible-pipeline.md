---
title: Reproducible pipeline
description: Package this work as a pipeline anyone can rerun and verify.
icon: package
mode: queue
---
Turn the work in this chat into a reproducible pipeline archive that someone else can rerun with `codeflower reproduce` and get the same results. Follow the codeflower-reproduce skill.

Before you start, ask me in one message for what you cannot find yourself: a short name for the pipeline, which results (figures, tables) it must reproduce, and for each input either a persistent URL to download it from or whether to bundle it in the archive (no upload needed, but the archive is as large as the data). Skip the question when the chat already settles it.

Include only the steps that lead to those results, not dead ends. Bundle only the data those steps read, in a compact format, and check that the results do not change. Give every random step an explicit seed from the config and document them in the README. Before you hand over, test the packed archive with `codeflower-repro test`. Do not change the analysis: when the clean run differs from the results we already have, tell me what differs and why before you change anything.

Then tell me in a few lines: where the archive is on my computer, what the test showed, the command to reproduce it, how long a run takes, and any warning from the checks.
