Write a report of the work in this chat, as your prompt's "Reports" section says: you write it, the executor builds it, and the two of you review it until you agree.

1. Read `report_guide`. Ask the executor to run `storyteller outline` in `reports/` and tell you which reports exist: if one covers this work, update it instead of starting another, and tell me.
2. Write the draft with `write_draft`, from what exists: the results, figures and tables your steps made and you checked. Do not have long computations rerun. If a number or figure is missing and quick to make, have it made in a step; otherwise say in the report that it is missing. Summary first, then data, methods (tools, versions, parameters, from the idea's `Decision:` comments), results, and limitations and open questions.
3. Have the executor build it in steps, keeping the code that writes each section in a script so it can be rerun, and show it with `codeflower-show` once the outline is up. Read it back with `read_report` and look at its figures with `view_figure`.
4. Review it with the executor, section by section, until it agrees with every claim and is unsure of none; take what two rounds do not settle to me.
5. Record the review on the idea in Roots, then have the executor finalize the report and run `storyteller check`, and, if an output folder is mounted under `/data/output`, copy the HTML there.

Then tell me in a few lines what the report covers, what the review changed, and what it leaves out.
