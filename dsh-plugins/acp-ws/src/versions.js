// The versions of the sandbox's parts, which /status reports for the windows
// to show (a sandbox's home in the app's page): the app that started it and
// the image's release (both from the app's environment), and what the image
// has: the chat page (`--server`), storyteller and the agents.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const STORYTELLER_DIRECTORY = '/opt/codeflower/src/storyteller';

/**
 * Where each agent's own release is, in the runtime's node_modules: a
 * package's version, or another field of it (Claude Code's in the SDK the
 * app binds in). A pattern (`*`) takes the first package that matches.
 */
const AGENT_PACKAGES = {
  claude: { name: '@anthropic-ai/claude-agent-sdk', field: 'claudeCodeVersion' },
  codex: { name: '@openai/codex' },
  dsh: { name: '@deepseek-ai/dsh' },
  opencode: { name: 'opencode-linux-*' }
};

const MAX_FILE = 1 << 20;

async function readSmall(file) {
  const content = await readFile(file, 'utf8');
  return content.length > MAX_FILE ? '' : content;
}

async function packageField(modules, name, field = 'version') {
  let resolved = name;
  if (name.endsWith('*')) {
    const [scope, prefix] = name.includes('/') ? name.slice(0, -1).split('/') : ['', name.slice(0, -1)];
    const entries = (await readdir(join(modules, scope)).catch(() => [])).filter((entry) => entry.startsWith(prefix)).sort();
    if (!entries.length) return undefined;
    resolved = scope ? `${scope}/${entries[0]}` : entries[0];
  }
  try {
    const value = JSON.parse(await readSmall(join(modules, resolved, 'package.json')))?.[field];
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The `version = "…"` of a pyproject.toml's [project] table. */
export function pyprojectVersion(text) {
  let inProject = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) inProject = trimmed === '[project]';
    else if (inProject) {
      const match = /^version\s*=\s*["']([^"']+)["']/.exec(trimmed);
      if (match) return match[1];
    }
  }
  return undefined;
}

/**
 * Reads the versions once: they do not change while the worker runs. Fields
 * nothing tells are left out (an older app, a local build of the image).
 */
export async function readVersions({
  environment = process.env,
  runtimeModules,
  pageDirectory,
  storytellerDirectory = STORYTELLER_DIRECTORY,
  agents = Object.keys(AGENT_PACKAGES)
} = {}) {
  const page = pageDirectory
    ? await readSmall(join(pageDirectory, 'version.json'))
        .then((text) => JSON.parse(text)?.ui)
        .catch(() => undefined)
    : undefined;
  const storyteller = await readSmall(join(storytellerDirectory, 'pyproject.toml'))
    .then(pyprojectVersion)
    .catch(() => undefined);
  const agentVersions = {};
  if (runtimeModules) {
    for (const agent of agents) {
      const where = AGENT_PACKAGES[agent];
      const version = where && (await packageField(runtimeModules, where.name, where.field));
      if (version) agentVersions[agent] = version;
    }
  }
  const versions = {
    app: environment.CODEFLOWER_APP_VERSION || undefined,
    image: environment.CODEFLOWER_IMAGE_VERSION || undefined,
    imageRef: environment.CODEFLOWER_IMAGE_REF || undefined,
    page: typeof page === 'string' && page ? page : undefined,
    storyteller,
    agents: Object.keys(agentVersions).length ? agentVersions : undefined
  };
  return Object.fromEntries(Object.entries(versions).filter(([, value]) => value !== undefined));
}
