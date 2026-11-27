// An executor's folder (docs/architecture.md, "Orchestrators"): the working
// folder of a chat made as an orchestrator's executor, outside the workspace,
// so that every agent reads the executor's short instructions (AGENTS.md, and
// CLAUDE.md for Claude Code) instead of the workspace's. They come from
// templates/EXECUTOR.md, which takes the environment parts of the workspace's
// AGENTS.md word for word: `<!-- include AGENTS.md#where -->` stands for what
// AGENTS.md has between `<!-- part:where -->` and `<!-- /part -->`.
//
// As entrypoint.sh does for the workspace's, a new image's version replaces a
// folder's copy only while the user has not edited it: a pristine copy of what
// was installed, in `run/templates/`, tells the two apart.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PART = /<!-- part:([\w-]+) -->\n([\s\S]*?)\n?<!-- \/part -->/g;
const INCLUDE = /^<!-- include ([\w.-]+)#([\w-]+) -->$/gm;
// Claude Code reads CLAUDE.md, the others AGENTS.md.
const CLAUDE = '@AGENTS.md\n';

/** The marked parts of a file, by name. */
export function parts(text) {
  return new Map([...text.matchAll(PART)].map((match) => [match[1], match[2].trim()]));
}

/** The template with each include replaced by its part; `files` by name. An unknown part fails. */
export function resolveIncludes(template, files) {
  const parsed = new Map(Object.entries(files).map(([name, text]) => [name, parts(text)]));
  return template.replace(INCLUDE, (line, file, name) => {
    const part = parsed.get(file)?.get(name);
    if (part === undefined) throw new Error(`${line}: ${file} has no part ${name}`);
    return part;
  });
}

const readText = (path) => readFile(path, 'utf8').catch((error) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));

/**
 * The executors' folders under `directory` (one per link), with their
 * instructions; `installed` is the pristine copy of the last version
 * installed. `text` is the resolved template, or undefined without one.
 */
export function createExecutorFolders({ directory, installed, text }) {
  const folder = (link) => join(directory, link);

  /** Writes a new executor's folder. */
  const create = async (link) => {
    const path = folder(link);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (text !== undefined) {
      await writeFile(join(path, 'AGENTS.md'), text);
      await writeFile(join(path, 'CLAUDE.md'), CLAUDE);
    }
    return path;
  };

  /** Brings the folders' unedited instructions to this version; once, at start. */
  const update = async () => {
    if (text === undefined) return;
    const before = await readText(installed);
    if (before !== text) {
      const links = await readdir(directory).catch(() => []);
      for (const link of links) {
        const file = join(folder(link), 'AGENTS.md');
        const current = await readText(file);
        if (current !== undefined && current === before) await writeFile(file, text);
      }
    }
    await mkdir(join(installed, '..'), { recursive: true });
    await writeFile(installed, text);
  };

  return { folder, create, update };
}
