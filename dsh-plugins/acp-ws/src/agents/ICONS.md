# Agent icons

Each agent's `icon.svg` comes from [@lobehub/icons-static-svg](https://www.npmjs.com/package/@lobehub/icons-static-svg)
1.102.0 (MIT, © LobeHub), with its `width`, `height` and `style` attributes removed:

| Agent | File in the package |
|---|---|
| claude | `icons/claudecode-color.svg` |
| codex | `icons/codex-color.svg` (without its white tile, like the others; gradient id renamed `codex-gradient`) |
| dsh | `icons/deepseek-color.svg` |
| opencode | `icons/opencode.svg` (monochrome only: `"mono": true` in its `agent.json`) |

The logos are trademarks of their owners and identify the agents only. An icon must stay a plain SVG, with no
script, event attribute or external reference (`test/agents.test.js` checks this).
