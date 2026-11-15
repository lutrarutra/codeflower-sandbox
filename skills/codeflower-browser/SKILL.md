---
name: codeflower-browser
description: Drive a real browser (headless Chromium in the sandbox) that the user can watch and take over. Use to check or test a web app you serve (Shiny, Dash, Streamlit, Jupyter, a dev server), to use a web page that needs a real browser (JavaScript, forms, a login), or whenever a page needs the user's password, 2FA or a captcha. Not for downloading files or reading documentation, which curl does.
---

# This chat's browser

`codeflower-browser` drives a Chromium that runs in the sandbox, one per chat
with its own profile: cookies and logins stay for the chat, also after the
sandbox restarts. The user can watch it live in a tab next to the chat and
take it over at any time.

## When to use it, and when not

Use it to:

- check a web app you built and serve here: start it on `127.0.0.1` (for
  example `shiny run --port 8050`, `python -m http.server`), then open
  `http://127.0.0.1:PORT`, click through it, and look at the console;
- use a page that only works in a browser (JavaScript, forms, a portal behind a login).

Do not use it to:

- download a file or read documentation: `curl` or your own web fetch is faster
  and costs fewer tokens;
- look at a figure or report you made: `codeflower-show` opens it for the user.

Every snapshot costs tokens. Prefer the text snapshot to screenshots, and close
the browser when you are done.

## Commands

```sh
codeflower-browser open http://127.0.0.1:8050   # start it (and go there); prints a snapshot
codeflower-browser snapshot                     # the page as text, with refs: [ref=e12]
codeflower-browser click e12
codeflower-browser fill e5 "some text"          # replace a field's text
codeflower-browser type "more text"             # type into the focused element
codeflower-browser press Enter
codeflower-browser select e7 "Option"
codeflower-browser goto https://example.org
codeflower-browser go-back / reload
codeflower-browser tab-list / tab-select 1
codeflower-browser console                      # the page's console messages
codeflower-browser requests                     # its network requests
codeflower-browser eval "document.title"
codeflower-browser screenshot --filename=figures/app.png
codeflower-browser status                       # the page, and whether the user has the browser
codeflower-browser close
```

The first command installs the browser for the project (once, about 115 MB:
Chrome's headless shell and playwright-cli, exactly the build the sandbox pins).
If it says it is still installing, run it again a minute later. Where the
sandbox cannot download it (no internet, or an isolated network without
`@github` allowed), ask the user for the archive named in the error and run
`codeflower-browser install --from FILE`.

Every command but `open`, `status`, `handoff`, `close` and `install` is playwright-cli's;
`codeflower-browser --help COMMAND` shows its options. Refs come from the
latest snapshot and change when the page does: take a new snapshot after
navigating or when a ref is not found. Do not pass `-s`/`--session` and do not
run `playwright-cli` yourself: each chat has its own browser.

## When the user has to do something: handoff

Never ask the user for a password, a 2FA code or a captcha in the chat, and
never put credentials in files, commands or notes. Hand the browser over instead:

```sh
codeflower-browser handoff "Log in to the LIMS with your account"
```

Say what the user should do, in one line. Then **end your turn**. The user
takes over in the browser tab, does it, and hands the browser back. You then get
a message, maybe with a note from them; take a snapshot to see where the page
is, and go on. Until then every command but `status` is refused.

The user can also take the browser over without being asked; your commands are
refused while they have it, and you get a message when they hand it back.

## If something fails

- `403`, `ERR_TUNNEL_CONNECTION_FAILED` or a page that does not load in an
  isolated sandbox: the host is not on the allowlist. Follow the
  codeflower-network skill.
- A local app does not load: check that it listens on `127.0.0.1` and on the
  port you opened.
- `This sandbox has no browser`: the image has no Chromium; say so.

## Your own Playwright

For tests or scripts of your own that use Playwright (Python or Node, installed
in the project environment), do not download browsers with `playwright install`:
use this Chromium, at `$CODEFLOWER_BROWSER_BIN` (run `codeflower-browser install`
first if it is not there yet):

```python
browser = p.chromium.launch(executable_path=os.environ["CODEFLOWER_BROWSER_BIN"], args=["--no-sandbox"])
```

```js
const browser = await chromium.launch({ executablePath: process.env.CODEFLOWER_BROWSER_BIN, args: ['--no-sandbox'] });
```

Those browsers are your own: the user does not see them. Use codeflower-browser
when the user should watch or take over.

## Showing results

A screenshot is a file: save it with `--filename` where it belongs (e.g.
`figures/`) and show it with `codeflower-show`, or put it in the report.
Snapshots and unnamed screenshots go to a temporary folder, not the workspace.
