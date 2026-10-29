// Files the agent shows the user (`codeflower-show`) and the client reads to
// display them: figures, reports and tables from the workspace or the inputs.
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { InvalidRequest } from './agents.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SHOW_REQUEST = 64 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_COMMENTS_BYTES = 2 * 1024 * 1024;
const COMMENT_SAVE_ATTEMPTS = 3;
const COMMENTS_SLOT = /(<script type="application\/json" id="cf-comments">)[\s\S]*?(<\/script>)/;

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.py': 'text/x-python',
  '.r': 'text/x-r',
  '.sh': 'text/x-shellscript',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.toml': 'text/plain'
};

export function mimeType(path) {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

const inside = (path, directory) => {
  const rest = relative(directory, path);
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
};

/**
 * Resolves a path the user may see: a regular file, not in the system's
 * virtual filesystems and, inside the project state, only in the workspace
 * (logins and session records stay private).
 */
async function resolvePath(path, { workspace, privateDirectory, cwd = workspace }) {
  if (typeof path !== 'string' || !path || path.length > 4096) throw new InvalidRequest('Invalid path');
  let real;
  try {
    real = await realpath(resolve(cwd, path));
  } catch {
    throw new InvalidRequest(`No such file: ${path}`);
  }
  const denied =
    ['/proc', '/sys', '/dev'].some((directory) => inside(real, directory)) ||
    (privateDirectory && inside(real, privateDirectory) && !(workspace && inside(real, workspace)));
  if (denied) throw new InvalidRequest(`This file cannot be shown: ${path}`);
  return { real, info: await stat(real) };
}

export async function resolveFile(path, options) {
  const { real, info } = await resolvePath(path, options);
  if (!info.isFile()) throw new InvalidRequest(`Not a file: ${path}`);
  return { path: real, size: info.size, mtimeMs: info.mtimeMs, mimeType: mimeType(real) };
}

/** A directory's visible entries, folders first; for browsing the workspace and inputs. */
export async function listDirectory(path, options) {
  const { real, info } = await resolvePath(path, options);
  if (!info.isDirectory()) throw new InvalidRequest(`Not a directory: ${path}`);
  const names = (await readdir(real)).filter((name) => !name.startsWith('.'));
  const entries = [];
  for (const name of names) {
    const entryPath = join(real, name);
    const entryInfo = await stat(entryPath).catch(() => undefined);
    if (!entryInfo || !(entryInfo.isFile() || entryInfo.isDirectory())) continue;
    entries.push({
      name,
      path: entryPath,
      type: entryInfo.isDirectory() ? 'directory' : 'file',
      size: entryInfo.size,
      mtimeMs: entryInfo.mtimeMs,
      ...(entryInfo.isFile() ? { mimeType: mimeType(entryPath) } : {})
    });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  return { path: real, entries: entries.slice(0, MAX_LIST_ENTRIES), truncated: entries.length > MAX_LIST_ENTRIES };
}

export async function readClientFile(path, options) {
  const file = await resolveFile(path, options);
  if (file.size > MAX_FILE_BYTES) {
    throw new InvalidRequest(`${path} is too large to show (${Math.round(file.size / 1024 / 1024)} MB)`);
  }
  return { ...file, data: (await readFile(file.path)).toString('base64') };
}

async function writeAtomic(path, text) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, text, { mode: 0o644 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function writeCommentsSlot(path, slot, initialStat, initialHtml, fileOps = {}) {
  const statFile = fileOps.stat ?? stat;
  const readFileAt = fileOps.readFile ?? readFile;
  const writeFileAtomically = fileOps.writeAtomic ?? writeAtomic;
  let read = initialStat;
  let html = initialHtml;
  for (let attempt = 0; attempt < COMMENT_SAVE_ATTEMPTS; attempt++) {
    if (!COMMENTS_SLOT.test(html)) throw new InvalidRequest('This page does not take comments (made before storyteller 0.2?)');
    const updated = html.replace(COMMENTS_SLOT, (_, open, close) => open + slot + close);
    const now = await statFile(path);
    if (now.mtimeMs === read.mtimeMs && now.size === read.size) {
      await writeFileAtomically(path, updated);
      return;
    }
    if (attempt + 1 < COMMENT_SAVE_ATTEMPTS) {
      read = now;
      html = await readFileAt(path, 'utf8');
    }
  }
  throw new InvalidRequest('The report kept changing while comments were saved; try again');
}

/**
 * Saves the comments the user left on a storyteller report in VS Code (an array
 * as JSON): into the report's store, `<name>.report/comments.json`, when it has
 * one, and into the page's comment slot, so the file the user shares has them
 * too. Only HTML reports in the workspace, and only those two files.
 */
export async function saveReportComments(path, json, options) {
  if (!options.workspace) throw new InvalidRequest('There is no workspace to save comments in');
  if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_COMMENTS_BYTES) {
    throw new InvalidRequest('Comments must be JSON text of at most 2 MB');
  }
  let comments;
  try {
    comments = JSON.parse(json);
  } catch {
    throw new InvalidRequest('Comments must be JSON');
  }
  if (!Array.isArray(comments)) throw new InvalidRequest('Comments must be a list');
  const workspace = await realpath(options.workspace);
  const file = await resolveFile(path, options);
  if (!inside(file.path, workspace) || file.mimeType !== 'text/html') {
    throw new InvalidRequest('Comments can only be saved on HTML reports in the workspace');
  }
  // In a script element: no "<" can end it early.
  const slot = JSON.stringify(comments).replace(/</g, '\\u003c');
  const store = await realpath(file.path.replace(/\.html?$/i, '.report')).catch(() => null);
  const stored = store && inside(store, workspace) && (await stat(join(store, 'report.json')).catch(() => null))?.isFile();
  // Checked before anything is written: a page without the slot does not take comments.
  const read = await stat(file.path);
  const html = await readFile(file.path, 'utf8');
  if (!COMMENTS_SLOT.test(html)) throw new InvalidRequest('This page does not take comments (made before storyteller 0.2?)');
  if (stored) await writeAtomic(join(store, 'comments.json'), `${JSON.stringify(comments, null, 1)}\n`);
  // A script may have rebuilt the page since it was read (with the comments from the store):
  // then put them into that version instead.
  await writeCommentsSlot(file.path, slot, read, html);
  return { path: file.path, stored: !!stored };
}

/**
 * A local socket for `codeflower-show` inside the sandbox. Each connection
 * sends one JSON line `{ paths, cwd, title?, message? }` and gets one back.
 */
export async function startShowServer(socketPath, onShow) {
  await unlink(socketPath).catch(() => {});
  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', async (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_SHOW_REQUEST) {
        socket.end(`${JSON.stringify({ error: 'Request too large' })}\n`);
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let reply;
      try {
        reply = await onShow(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reply = { error: error.message };
      }
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  return {
    async close() {
      await new Promise((resolveClose) => server.close(resolveClose));
      await unlink(socketPath).catch(() => {});
    }
  };
}
