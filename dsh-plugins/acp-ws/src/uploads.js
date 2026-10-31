// Files the user sends to the sandbox, in VS Code or the app's page: attached
// to a chat message, or dropped on a folder of the page's file tree. They come
// over the window's own connection in chunks, so they reach sandboxes on other
// machines the same way chats do. Attachments land in the workspace's uploads/
// folder, where the agent finds them; files sent to a folder only in the
// workspace or a read-write mount, never in a hidden folder.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, statfs, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { InvalidRequest } from './agents.js';
import { directoryWritable, mimeType, resolvePath } from './files.js';

export const UPLOADS_FOLDER = 'uploads';
export const DEFAULT_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
// Each chunk is answered; the window keeps a few on the way, far below the
// WebSocket's frame limit, and shows progress.
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 4 * UPLOAD_CHUNK_BYTES;
const MAX_OPEN_PER_WINDOW = 8;
const MAX_NAME_LENGTH = 200;
const MAX_PATH_DEPTH = 32;
const MAX_EXISTS_PATHS = 1000;
// An upload nobody continues, e.g. from a window that hung, is dropped.
const IDLE_MS = 10 * 60_000;
const PART = '.part';

/** A name that stays in the uploads folder: the last path segment, without control characters or a leading dot. */
export function uploadName(name) {
  const last = String(name ?? '').split(/[/\\]/).pop() ?? '';
  let clean = last.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/^\.+/, '');
  if (clean.length > MAX_NAME_LENGTH) {
    const extension = extname(clean).slice(0, 20);
    clean = clean.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
  }
  return clean || 'upload';
}

/**
 * The segments of a path relative to the folder a file is sent to, e.g. a
 * dropped folder's `data/run1/a.csv`. Hidden names, `.` and `..` are refused
 * rather than renamed, so nothing lands somewhere the user did not see.
 */
export function relativeSegments(path) {
  if (typeof path !== 'string' || !path) throw new InvalidRequest('The upload needs a file name');
  const segments = path.split(/[/\\]/);
  if (segments.length > MAX_PATH_DEPTH) throw new InvalidRequest(`${path} is nested too deeply`);
  return segments.map((segment) => {
    if (!segment || segment.startsWith('.')) throw new InvalidRequest(`Hidden files and folders cannot be uploaded: ${path}`);
    return uploadName(segment);
  });
}

function numbered(name, number) {
  if (number === 0) return name;
  const extension = extname(name);
  return `${name.slice(0, name.length - extension.length)}-${number}${extension}`;
}

export function createUploads({ workspace, fileOptions = { workspace }, maxBytes = DEFAULT_UPLOAD_MAX_BYTES, log = () => {} }) {
  const folder = join(workspace, UPLOADS_FOLDER);
  const uploads = new Map();

  const drop = async (upload) => {
    uploads.delete(upload.id);
    clearTimeout(upload.timer);
    await upload.handle.close().catch(() => {});
    await unlink(upload.partPath).catch(() => {});
  };

  const touch = (upload) => {
    clearTimeout(upload.timer);
    upload.timer = setTimeout(() => {
      log(`Dropping the upload of ${upload.name}: nothing arrived for ${IDLE_MS / 60_000} minutes`);
      void drop(upload);
    }, IDLE_MS);
    upload.timer.unref?.();
  };

  const owned = (params, owner) => {
    const upload = uploads.get(params?.uploadId);
    if (!upload || upload.owner !== owner) throw new InvalidRequest('Unknown upload');
    return upload;
  };

  /** A writable folder the user chose, as its real path. */
  const writableDirectory = async (dir) => {
    const { real, info } = await resolvePath(dir, fileOptions);
    if (!info.isDirectory()) throw new InvalidRequest(`Not a folder: ${dir}`);
    if (!(await directoryWritable(real, fileOptions))) {
      throw new InvalidRequest(`${dir} is read-only: files can be sent only to the workspace or a read-write folder`);
    }
    return real;
  };

  /**
   * Where a file goes: `dir` and the folders of `relativePath`, created one
   * at a time. Each is checked before going in, so a link planted in the way
   * cannot lead the file, or a new folder, out of the writable folders.
   */
  const target = async ({ name, dir, relativePath }) => {
    if (dir === undefined) {
      await mkdir(folder, { recursive: true });
      return { directory: folder, name: uploadName(name), inUploads: true };
    }
    const segments = relativeSegments(relativePath ?? name);
    let directory = await writableDirectory(dir);
    for (const segment of segments.slice(0, -1)) {
      const next = join(directory, segment);
      await mkdir(next).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      directory = await writableDirectory(await realpath(next));
    }
    return { directory, name: segments.at(-1), inUploads: false };
  };

  const start = async ({ name, size, dir, relativePath, conflict = 'number' }, owner) => {
    if (!Number.isSafeInteger(size) || size < 0) throw new InvalidRequest('The upload needs its size in bytes');
    if (conflict !== 'number' && conflict !== 'replace') throw new InvalidRequest('conflict must be "number" or "replace"');
    const shown = uploadName(relativePath ?? name);
    if (size > maxBytes) {
      throw new InvalidRequest(`${shown} is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB uploads may have`);
    }
    if ([...uploads.values()].filter((upload) => upload.owner === owner).length >= MAX_OPEN_PER_WINDOW) {
      throw new InvalidRequest('Too many uploads at once; wait for the others to finish');
    }
    const place = await target({ name, dir, relativePath });
    const space = await statfs(place.directory).catch(() => undefined);
    if (space && size > space.bavail * space.bsize) {
      throw new InvalidRequest(`There is not enough disk space in the sandbox for ${shown}`);
    }
    const id = randomUUID();
    const partPath = join(place.directory, `.${id}${PART}`);
    const upload = {
      id,
      owner,
      directory: place.directory,
      name: place.name,
      conflict: place.inUploads ? 'number' : conflict,
      size,
      received: 0,
      partPath,
      handle: await open(partPath, 'wx', 0o644),
      hash: createHash('sha256'),
      // Chunks of one upload are written in the order they arrive.
      queue: Promise.resolve(),
      timer: undefined
    };
    uploads.set(id, upload);
    touch(upload);
    return { uploadId: id, chunkBytes: UPLOAD_CHUNK_BYTES };
  };

  const write = async (upload, params) => {
    if (!uploads.has(upload.id)) throw new InvalidRequest('Unknown upload');
    if (params.offset !== upload.received) {
      throw new InvalidRequest(`Expected the chunk at byte ${upload.received}, not ${params.offset}`);
    }
    if (typeof params.data !== 'string') throw new InvalidRequest('A chunk carries its data in base64');
    const data = Buffer.from(params.data, 'base64');
    if (data.length > MAX_CHUNK_BYTES || upload.received + data.length > upload.size) {
      await drop(upload);
      throw new InvalidRequest('The chunk is larger than announced');
    }
    await upload.handle.write(data, 0, data.length, upload.received);
    upload.hash.update(data);
    upload.received += data.length;
    touch(upload);
    return { received: upload.received };
  };

  const chunk = (params, owner) => {
    const upload = owned(params, owner);
    const written = upload.queue.then(() => write(upload, params));
    upload.queue = written.catch(() => {});
    return written;
  };

  /** Moves the finished part to its name: a new one (numbered if taken), or over the file the user chose to replace. */
  const place = async (upload) => {
    if (upload.conflict === 'replace') {
      const path = join(upload.directory, upload.name);
      const existing = await lstat(path).catch(() => undefined);
      if (existing && !existing.isFile()) throw new InvalidRequest(`${path} is not a file and cannot be replaced`);
      await rename(upload.partPath, path);
      return { path, name: upload.name, replaced: !!existing };
    }
    // The name is claimed by creating it exclusively, then the part replaces
    // the empty claim: a file is never overwritten, even by another upload
    // finishing at the same moment, and no hard links are needed.
    for (let number = 0; number < 1000; number++) {
      const name = numbered(upload.name, number);
      const path = join(upload.directory, name);
      try {
        await (await open(path, 'wx', 0o644)).close();
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      await rename(upload.partPath, path);
      return { path, name, replaced: false };
    }
    throw new InvalidRequest(`Too many files called ${upload.name} in ${upload.directory}`);
  };

  const finish = async (params, owner) => {
    const upload = owned(params, owner);
    await upload.queue;
    if (upload.received !== upload.size) {
      throw new InvalidRequest(`The upload has ${upload.received} of ${upload.size} bytes`);
    }
    uploads.delete(upload.id);
    clearTimeout(upload.timer);
    await upload.handle.close();
    const sha256 = upload.hash.digest('hex');
    try {
      if (params.sha256 !== undefined && params.sha256 !== sha256) {
        throw new InvalidRequest(`${upload.name} arrived damaged (its SHA-256 differs); nothing was saved`);
      }
      const placed = await place(upload);
      log(`Received ${placed.path} (${upload.size} bytes)${placed.replaced ? ', replacing the old file' : ''}`);
      return { ...placed, size: upload.size, sha256, mimeType: mimeType(placed.path) };
    } finally {
      await unlink(upload.partPath).catch(() => {});
    }
  };

  /** `_codeflower/files/exists`: which of `paths` (relative to `dir`) are taken, so the window can ask before replacing. */
  const exists = async ({ dir, paths } = {}) => {
    if (!Array.isArray(paths) || paths.length > MAX_EXISTS_PATHS) {
      throw new InvalidRequest(`paths must be a list of at most ${MAX_EXISTS_PATHS} names`);
    }
    const base = await writableDirectory(dir);
    const existing = [];
    for (const path of paths) {
      const found = await lstat(join(base, ...relativeSegments(path))).catch(() => undefined);
      if (found) existing.push({ path, type: found.isFile() ? 'file' : found.isDirectory() ? 'directory' : 'other' });
    }
    return { existing };
  };

  return {
    folder,
    capability: { maxBytes, chunkBytes: UPLOAD_CHUNK_BYTES },
    exists,
    /**
     * `_codeflower/files/upload`: start with {name, size}, or {dir, relativePath, size, conflict} for a
     * folder; send {uploadId, offset, data}; then {uploadId, finish, sha256}.
     */
    async handle(params, owner) {
      if (params?.cancel) {
        const upload = uploads.get(params.uploadId);
        if (upload && upload.owner === owner) await drop(upload);
        return {};
      }
      if (params?.finish) return finish(params, owner);
      if (params?.uploadId !== undefined) return chunk(params, owner);
      return start(params ?? {}, owner);
    },
    /** A window went away: its unfinished uploads go with it. */
    async release(owner) {
      await Promise.all([...uploads.values()].filter((upload) => upload.owner === owner).map(drop));
    },
    /** Parts left behind when an earlier bridge stopped mid-upload. */
    async removeLeftovers() {
      const names = await readdir(folder).catch(() => []);
      await Promise.all(names.filter((name) => name.startsWith('.') && name.endsWith(PART)).map((name) => unlink(join(folder, name)).catch(() => {})));
    },
    async close() {
      await Promise.all([...uploads.values()].map(drop));
    }
  };
}
