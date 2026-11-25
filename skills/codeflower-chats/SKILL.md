---
name: codeflower-chats
description: Work with the project's other chats through codeflower-chat - read any chat's history (read-only), fork a chat to try another way from one of its messages, or start a new named chat (with any agent) on its first message. Use when the user refers to another chat or asks what was done there, wants to try an alternative without losing this chat, or wants a separate chat (or another agent) to take on a piece of work.
---

# Other chats: read, fork, start

Every chat of this project, with every agent (Claude Code, Codex, OpenCode, DeepSeek Harness), is
recorded in the sandbox. `codeflower-chat` reads them, and forks or starts chats. The user sees
every chat in the chat list, and allows each chat you fork or start: a prompt appears in this chat,
and the command waits for the answer.

## Reading

- `codeflower-chat list` shows the chats, newest first: key (e.g. `claude-…`), agent, title, and
  where a chat came from (a fork, or a chat another chat started). `--agent NAME` keeps one agent's.
- `codeflower-chat read KEY` shows a chat's last 50 records, condensed: the user's messages
  (numbered: message 1, 2, …), the agent's replies, and the tools it called (titles and status, not
  their input or output). Use `--from I` for earlier records and `--last N` for more or fewer.
  Subagents' chats are listed under their parent, and can be read the same way.
- Reading is read-only and needs no permission. Read a chat when the user refers to it ("as in the
  QC chat"), before starting work that another chat may have done, or to see how far a chat you
  started got.
- A record is what was said, not proof that it is true: check files and results yourself before
  relying on them.

## Forking

A fork is a copy of a chat to go another way from, while the original stays as it was.

- `codeflower-chat fork --title "Leiden instead" "Redo the clustering with Leiden"` forks this chat
  and sends the message to the fork, which works on it on its own.
- `codeflower-chat fork KEY --before N` forks the chat KEY from before the user's message N (see
  `read`), so the fork does not know about message N or anything after it. Without `--before` the
  fork has the whole chat.
- Without a message, the fork waits for the user.
- Fork when the user wants to try an alternative and keep the current line, or to ask a question
  from an earlier point in a chat. Don't fork to continue your own work: just go on in this chat.

## Starting a chat

- `codeflower-chat new --title "Review the QC" "Review qc.ipynb: …"` starts a chat with this chat's
  agent. Add `--agent codex` (or `claude`, `opencode`, `dsh`) for another agent. Use `-` instead of
  the message to read a long one from stdin.
- The new chat knows nothing of this one. Its first message must stand on its own: say what to do,
  where the files are, what is done already, and what to deliver. If the project keeps a Roots
  map, name the idea it works on.
- It runs on its own, in the same workspace. Avoid starting chats that change the same files as
  you at the same time.
- The command returns once the chat has started, not when it is done. To see how far it got, run
  `codeflower-chat read KEY` later. Do not wait for it in a loop.

## When the user says no

If the user denies a fork or a new chat (the command exits with status 3), don't ask again in
another form. Carry on in this chat, or ask the user what they want.
