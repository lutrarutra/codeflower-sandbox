// Helpers for agents' hooks: reading and writing the files in their homes.
import { access, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export class InvalidRequest extends Error {
  /** `data` goes to the client with the error, e.g. `{ conflict: true }`. */
  constructor(message, data) {
    super(message);
    if (data) this.data = data;
  }
}

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

export async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${path}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected a JSON object in ${path}`);
  }
  return value;
}

export async function writePrivate(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

export function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    throw new InvalidRequest(`${label} is required`);
  }
  return value.trim();
}

// The file under `folder` (and its subfolders, with `deep`) whose name matches
// `pattern` and that changed last, after `since` (ms); undefined if none did.
export async function newestFile(folder, pattern, { since = 0, deep = false } = {}) {
  let entries;
  try {
    entries = await readdir(folder, { recursive: deep, withFileTypes: true });
  } catch {
    return undefined;
  }
  let newest;
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: 0 }));
    if (mtimeMs >= since && (!newest || mtimeMs > newest.mtimeMs)) newest = { path, name: entry.name, mtimeMs };
  }
  return newest;
}
