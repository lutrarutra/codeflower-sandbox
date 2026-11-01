#!/usr/bin/env node
// Claude Code's plugin commands as the Claude adapter's fetch uses them, on
// files only: marketplaces come from FAKE_CLAUDE_MARKETPLACES (a folder with
// one marketplace folder per GitHub repository, `owner--repo`), and every run
// is logged to FAKE_CLAUDE_LOG.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const cache = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
const config = process.env.CLAUDE_CONFIG_DIR;
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, config, cache })}\n`);

const read = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const knownFile = join(cache ?? config, 'known_marketplaces.json');
const installedFile = join(cache ?? config, 'installed_plugins.json');
const known = read(knownFile, {});
const installed = read(installedFile, { version: 2, plugins: {} });
const save = () => {
  mkdirSync(cache ?? config, { recursive: true });
  writeFileSync(knownFile, JSON.stringify(known));
  writeFileSync(installedFile, JSON.stringify(installed));
};
const fail = (message) => {
  console.log(JSON.stringify({ outcome: 'failed', message }));
  process.exit(1);
};

const command = args.slice(0, 3).join(' ');
if (command === 'plugin marketplace list') {
  console.log(JSON.stringify(Object.entries(known).map(([name, entry]) => ({ name, ...entry.source, installLocation: entry.installLocation }))));
} else if (command === 'plugin marketplace add') {
  const source = args[3];
  const location = (name) => join(cache, 'marketplaces', name);
  let from;
  let entry;
  if (source.startsWith('/')) {
    from = source;
    entry = { source: 'directory', path: source };
  } else {
    from = join(process.env.FAKE_CLAUDE_MARKETPLACES ?? '/nonexistent', source.replace('/', '--'));
    entry = { source: 'github', repo: source };
  }
  if (!existsSync(join(from, '.claude-plugin', 'marketplace.json'))) fail(`No marketplace at ${source}`);
  const { name } = read(join(from, '.claude-plugin', 'marketplace.json'));
  if (from !== location(name)) cpSync(from, location(name), { recursive: true });
  known[name] = { source: entry, installLocation: location(name) };
  save();
  console.log(JSON.stringify({ outcome: 'ok', name }));
} else if (command === 'plugin marketplace update') {
  if (!known[args[3]]) fail(`No marketplace ${args[3]}`);
} else if (args[0] === 'plugin' && args[1] === 'install') {
  const [name, catalog] = args[2].split('@');
  if (!known[catalog]) fail(`Marketplace "${catalog}" not found`);
  const manifest = read(join(known[catalog].installLocation, '.claude-plugin', 'marketplace.json'));
  const plugin = manifest.plugins.find((candidate) => candidate.name === name);
  if (!plugin) fail(`Plugin "${name}" not found in marketplace "${catalog}"`);
  installed.plugins[args[2]] = [{ scope: 'user', version: plugin.version ?? '1.0.0' }];
  save();
  console.log(JSON.stringify({ command: 'install', outcome: 'ok', pluginId: args[2] }));
} else if (command === 'plugin list --json') {
  console.log(
    JSON.stringify(Object.entries(installed.plugins).map(([id, [first]]) => ({ id, version: first.version, enabled: true })))
  );
} else {
  console.error(`fake claude: unknown command ${args.join(' ')}`);
  process.exit(2);
}
