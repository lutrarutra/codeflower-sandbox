// Files the user attaches to a chat message, in VS Code or the app's page. They
// come over the window's own connection in chunks, so they reach sandboxes on
// other machines the same way chats do, and land only in the workspace's
// uploads/ folder, where the agent finds them.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, statfs, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { InvalidRequest } from './agents.js';
import { mimeType } from './files.js';

export const UPLOADS_FOLDER = 'uploads';
export const DEFAULT_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
// Each chunk is answered before the next is sent: far below the WebSocket's
// frame limit, and the window can show progress.
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 4 * UPLOAD_CHUNK_BYTES;
const MAX_OPEN_PER_WINDOW = 8;
const MAX_NAME_LENGTH = 200;
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

function numbered(name, number) {
  if (number === 0) return name;
  const extension = extname(name);
  return `${name.slice(0, name.length - extension.length)}-${number}${extension}`;
}

export function createUploads({ workspace, maxBytes = DEFAULT_UPLOAD_MAX_BYTES, log = () => {} }) {
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

  const start = async ({ name, size }, owner) => {
    if (!Number.isSafeInteger(size) || size < 0) throw new InvalidRequest('The upload needs its size in bytes');
    if (size > maxBytes) {
      throw new InvalidRequest(`${uploadName(name)} is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB uploads may have`);
    }
    if ([...uploads.values()].filter((upload) => upload.owner === owner).length >= MAX_OPEN_PER_WINDOW) {
      throw new InvalidRequest('Too many uploads at once; wait for the others to finish');
    }
    await mkdir(folder, { recursive: true });
    const space = await statfs(folder).catch(() => undefined);
    if (space && size > space.bavail * space.bsize) {
      throw new InvalidRequest(`There is not enough disk space in the sandbox for ${uploadName(name)}`);
    }
    const id = randomUUID();
    const partPath = join(folder, `.${id}${PART}`);
    const upload = {
      id,
      owner,
      name: uploadName(name),
      size,
      received: 0,
      partPath,
      handle: await open(partPath, 'wx', 0o644),
      hash: createHash('sha256'),
      timer: undefined
    };
    uploads.set(id, upload);
    touch(upload);
    return { uploadId: id, chunkBytes: UPLOAD_CHUNK_BYTES };
  };

  const chunk = async (params, owner) => {
    const upload = owned(params, owner);
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

  const finish = async (params, owner) => {
    const upload = owned(params, owner);
    if (upload.received !== upload.size) {
      throw new InvalidRequest(`The upload has ${upload.received} of ${upload.size} bytes`);
    }
    uploads.delete(upload.id);
    clearTimeout(upload.timer);
    await upload.handle.close();
    const sha256 = upload.hash.digest('hex');
    try {
      // The name is claimed by creating it exclusively, then the part replaces
      // the empty claim: a file is never overwritten, even by another upload
      // finishing at the same moment, and no hard links are needed.
      for (let number = 0; number < 1000; number++) {
        const path = join(folder, numbered(upload.name, number));
        try {
          await (await open(path, 'wx', 0o644)).close();
        } catch (error) {
          if (error.code === 'EEXIST') continue;
          throw error;
        }
        await rename(upload.partPath, path);
        log(`Received ${path} (${upload.size} bytes)`);
        return { path, name: numbered(upload.name, number), size: upload.size, sha256, mimeType: mimeType(path) };
      }
      throw new InvalidRequest(`Too many files called ${upload.name} in ${folder}`);
    } finally {
      await unlink(upload.partPath).catch(() => {});
    }
  };

  return {
    folder,
    capability: { maxBytes, chunkBytes: UPLOAD_CHUNK_BYTES },
    /** `_codeflower/files/upload`: start with {name, size}, send {uploadId, offset, data}, then {uploadId, finish}. */
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
