{{#time}}This run's time is almost up.{{/time}}{{#rounds}}This run is out of rounds.{{/rounds}} Do not start new work: leave the
analysis as it stands and write up what there is, within a few minutes.
{{#report}}

Bring the storyteller report (`reports/task`) up to date, call `finalize()`, run
`storyteller check reports/task.html`, and copy it to `{{output}}/report.html`.
{{/report}}
{{^report}}

Bring `{{output}}/README.md` up to date.
{{/report}}
Make it say what was done, the results so far and how far they can be trusted, the assumptions
you made, and what was planned but not done, and why, so the work can be continued later.
