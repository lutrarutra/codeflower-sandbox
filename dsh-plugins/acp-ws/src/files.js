// Files the agent shows the user (`codeflower-show`) and the client reads to
// display them: figures, reports and tables from the workspace or the inputs.
import { createServer } from 'node:net';
import { readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { InvalidRequest } from './agents.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SHOW_REQUEST = 64 * 1024;
const MAX_LIST_ENTRIES = 500;

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
