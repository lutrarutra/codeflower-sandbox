This `codeflower task` run continues the unattended task you worked on earlier in this session.
{{#interrupted}}

The previous run was interrupted before it finished: stopped by the user, by its time limit, or
by the machine. A command or an edit may have been cut off halfway. Check the current state of
the workspace and of `{{output}}` before you go on, redo what is incomplete, then continue the
task.
{{/interrupted}}
{{#error}}

The previous run stopped because of an error: {{message}}
Apart from that, the work is as you left it. Check where it stands, then continue the task.
{{/error}}
{{#unmet}}

The previous run ended before the task was done: {{message}}
This run has a fresh budget. Pick up what was left open and continue the task.
{{/unmet}}
{{#completed}}

You already completed this task. Its results{{#report}} and report{{/report}} are in `{{output}}`.
{{/completed}}
{{#followUp}}

The user has a follow-up request. Build on the earlier work instead of starting over: reuse its
scripts and results, and add to or revise them.{{#report}} Update the existing report (`reports/task`)
with new or revised sections rather than starting a new one, finalize it, and copy it to
`{{output}}/report.html` again.{{/report}}

# Follow-up request from the user

{{followUp}}
{{/followUp}}
{{^followUp}}
{{#completed}}
The user asked to go over it again: check the results{{#report}} and the report{{/report}} against the
task, fix what is wrong, and improve what is weak.
{{/completed}}
{{/followUp}}

# The original task

{{task}}
{{#report}}

Done only when a finalized storyteller report of the work is at {{output}}/report.html and passes
`storyteller check`.
{{/report}}

# Your instructions for this unattended run (repeated)

{{instructions}}
