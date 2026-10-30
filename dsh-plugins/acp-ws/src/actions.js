import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

const ACTION_FILE = /^(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const FIELDS = new Set(['title', 'description', 'icon', 'mode']);

export function parseActionTemplate(fileName, text) {
  const name = basename(fileName);
  const match = ACTION_FILE.exec(name);
  if (!match) throw new Error(`Invalid action template filename: ${name}`);

  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error(`${name}: expected frontmatter`);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error(`${name}: unterminated frontmatter`);

  const metadata = new Map();
  for (const line of lines.slice(1, end)) {
    const field = /^([a-z]+):[ \t]*(.+?)[ \t]*$/.exec(line);
    if (!field || !FIELDS.has(field[1])) throw new Error(`${name}: invalid frontmatter line: ${line}`);
    if (metadata.has(field[1])) throw new Error(`${name}: duplicate frontmatter field: ${field[1]}`);
    metadata.set(field[1], field[2]);
  }
  for (const field of FIELDS) {
    if (!metadata.has(field)) throw new Error(`${name}: missing frontmatter field: ${field}`);
  }

  const { title, description, icon, mode } = Object.fromEntries(metadata);
  if (mode !== 'queue' && mode !== 'interrupt') throw new Error(`${name}: mode must be "queue" or "interrupt"`);
  if (!/^[a-z0-9-]+$/.test(icon)) throw new Error(`${name}: invalid codicon name: ${icon}`);
  const prompt = lines.slice(end + 1).join('\n').trim();
  if (!prompt) throw new Error(`${name}: prompt is empty`);

  return { id: match[2], title, description, icon, mode, prompt, order: Number(match[1]) };
}

export async function readActions(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md'));
  const actions = await Promise.all(
    files.map(async (file) =>
      parseActionTemplate(file.name, await readFile(join(directory, file.name), 'utf8'))
    )
  );
  actions.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const ids = new Set();
  for (const action of actions) {
    if (ids.has(action.id)) throw new Error(`Duplicate action id: ${action.id}`);
    ids.add(action.id);
    delete action.order;
  }
  return actions;
}
