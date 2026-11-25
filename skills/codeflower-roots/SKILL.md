---
name: codeflower-roots
description: Keep the project's map of analysis ideas with codeflower-roots - what each line of work builds on, its todos, what it needs, the files it produced and its conclusion - which the user watches next to the chat. Use at the start of every analysis (even a first and only one), when trying an alternative or a follow-up, when handing work to a subagent or another chat, when a line of work ends, and when the user comments on an idea.
---

# Roots: the map of ideas

Analyses branch: one result suggests two follow-ups, a method is tried against another, a subagent
or another chat explores a side question. Roots keeps all of that as one map for the project, so
the user, you and every other chat in this sandbox can see what was tried, what is going on, and
what came of it. The user watches it next to the chat, comments on ideas, and starts new chats from
them.

Each idea is a file in the workspace's `roots/` folder. Change them only with `codeflower-roots`,
which checks them and records your chat on the idea; never edit the files by hand.

## When

- **Before any analysis**, run `codeflower-roots tree`. Then pick the idea your task belongs to, or
  start one: `codeflower-roots new "Explore and QC the counts" --todo "…" --todo "…"`. Do this even
  for a first and only analysis: they usually grow.
- **A follow-up or an alternative** is a new idea that builds on the one it came from:
  `codeflower-roots new "Batch-correct with scVI" --from 4`. Something unrelated to every idea
  starts from the data (no `--from`). Several `--from` ids mean it combines them.
- **Refining the same line of work** (another parameter, a fixed bug, a better figure) stays in its
  idea: add or check todos, don't start a new one.
- **An idea for later** (one you or the user think worth trying, but not now): `--status idea`.
- **Work you hand to a subagent or another chat**: make or pick its idea first, and name it in the
  task ("Work on idea 6; keep it current with codeflower-roots").

## What is left to do

`codeflower-roots todos` is the project's todo list: for every idea still in play (active, then
blocked, then not started), its open todos, the needs it still waits for and the user's comments
you have not answered, numbered for `todo check ID N` and `need check ID N`. `--mine` keeps the
ideas this chat worked on; `todos ID` one idea.

- Run `codeflower-roots todos --mine` when you start or resume work in a chat, and `todos` when
  you look for what to do next or the user asks what is open.
- Keep the steps there rather than only in your own todo or plan tool: those last for one chat,
  the map's todos for the project, and the user and other chats see them. Your own tool can
  mirror the idea's todos for the current turn; when you check one off there, check it here too.
- An active idea with no open todos is either done (conclude it) or missing its next steps (add them).

## Showing the map

`codeflower-roots open [ID]` opens the map in a tab next to the chat, on idea ID if given. When the
user asks to see the map, the ideas or where things stand, open it: don't paste the `tree` output,
which is for you. Open it once after starting the first idea of a project too, so the user knows it
is there. The tab updates by itself; don't open it again after each change.

## Keeping an idea current

- Todos: `todo add ID TEXT...` when you plan steps, `todo check ID N...` as each is done (numbers
  as `show` lists them). Keep them a few concrete steps, not a log.
- Needs: what must happen first. Another idea (`need add 7 5`, met once idea 5 is done) or a
  condition the user or the world must satisfy (`need add 8 "Sample sheet with the treatment
  column"`, checked with `need check 8 2`). Set the status to `blocked` while one stops the work.
- Files: `link ID PATH...` for what the idea produced that matters: key figures, the scripts that
  made them, reports, result tables. Not every intermediate file.
- Status: `active` while worked on, `blocked`, `done`, or `dropped` for a line given up (say why in
  its conclusion, and which idea replaces it).

## Conclusions

When a line of work ends (done or dropped), write its conclusion:
`codeflower-roots conclude ID - --done` with the text on standard input, or `--file`.

- What it found, with the numbers that matter, and how sure you are.
- What it means for the ideas that follow, or why it was dropped.
- Markdown, a short paragraph or a few bullets; the details belong in the report and the files.

A conclusion can be revised while the idea is open; each `conclude` replaces the earlier one.

## The user's comments

The user comments on ideas from the map. `tree` names the ideas with comments you have not answered,
and the chat working on an idea is told when one arrives. Read them with `show ID`, act on them, and
answer briefly with `codeflower-roots comment ID "…"` (what you did, or why not), so the user sees
the answer on the map.
