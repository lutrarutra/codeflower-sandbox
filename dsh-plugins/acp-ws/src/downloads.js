// Files the user saves from the sandbox to their computer, from the app's
// page: a file as it is, or a folder as a zip made on the fly. Like uploads,
// they go over the window's own connection in chunks the window asks for one
// after another, so they reach the user's computer the way chats do, a slow
// window slows the reading, and the bridge holds at most a chunk or two.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import yazl from 'yazl';
import { InvalidRequest } from './agents.js';
import { resolvePath } from './files.js';
import { UPLOAD_CHUNK_BYTES } from './uploads.js';

export const DOWNLOAD_CHUNK_BYTES = UPLOAD_CHUNK_BYTES;
const MAX_OPEN_PER_WINDOW = 8;
export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ZIP_SOURCE_BYTES = 10 * 1024 * 1024 * 1024;
// A download nobody continues, e.g. from a window that hung, is dropped.
const IDLE_MS = 10 * 60_000;
// Already compressed: stored as they are, which is as small and much faster.
const COMPRESSED = new Set(
  '.png .jpg .jpeg .gif .webp .avif .heic .zip .gz .tgz .bgz .bz2 .xz .zst .7z .rar .jar .whl .mp4 .mov .mkv .webm .mp3 .m4a .ogg .flac .bam .cram .parquet .pdf .docx .xlsx .pptx'.split(' ')
);

/** A folder's visible files and folders, as zip entries, without following links. */
async function walk(root) {
  const files = [];
  const folders = [];
  let sourceBytes = 0;
  const visit = async (directory, prefix) => {
    const names = (await readdir(directory)).filter((name) => !name.startsWith('.')).sort();
    if (!names.length && prefix) folders.push(prefix);
    for (const name of names) {
      const path = join(directory, name);
      const entry = `${prefix}${name}`;
      const info = await lstat(path).catch(() => undefined);
      if (!info) continue;
      if (info.isDirectory()) {
        await visit(path, `${entry}/`);
      } else if (info.isFile()) {
        files.push({ path, entry, size: info.size, mtime: info.mtime, mode: info.mode });
        sourceBytes += info.size;
      } else {
        continue;
      }
      if (files.length + folders.length > MAX_ZIP_ENTRIES) {
        throw new InvalidRequest(`The folder has more than ${MAX_ZIP_ENTRIES} files; download a smaller one`);
      }
      if (sourceBytes > MAX_ZIP_SOURCE_BYTES) {
        throw new InvalidRequest(`The folder holds more than ${MAX_ZIP_SOURCE_BYTES / 1024 ** 3} GB; download a smaller one`);
      }
    }
  };
  await visit(root, '');
  return { files, folders, sourceBytes };
}

export function createDownloads({ fileOptions, log = () => {} }) {
  const downloads = new Map();

  const drop = async (download) => {
    downloads.delete(download.id);
    clearTimeout(download.timer);
    if (download.handle) await download.handle.close().catch(() => {});
    download.stream?.destroy();
  };

  const touch = (download) => {
    clearTimeout(download.timer);
    download.timer = setTimeout(() => {
      log(`Dropping the download of ${download.name}: nobody asked for more for ${IDLE_MS / 60_000} minutes`);
      void drop(download);
    }, IDLE_MS);
    download.timer.unref?.();
  };

  const owned = (params, owner) => {
    const download = downloads.get(params?.downloadId);
    if (!download || download.owner !== owner) throw new InvalidRequest('Unknown download');
    return download;
  };

  /** A zip of `real`, made as the window reads it. */
  const zipOf = async (real, download) => {
    const { files, folders, sourceBytes } = await walk(real);
    const zip = new yazl.ZipFile();
    const fail = (error) => {
      download.error ??= error.message.includes('unexpected number of bytes')
        ? new InvalidRequest(`${download.current} changed while it was zipped; try again`)
        : error;
      download.wake?.();
    };
    zip.on('error', fail);
    for (const file of files) {
      zip.addReadStreamLazy(
        file.entry,
        { mtime: file.mtime, mode: file.mode, size: file.size, compress: !COMPRESSED.has(extname(file.entry).toLowerCase()) },
        (callback) => {
          download.current = file.entry;
          // Counts what has been read, for the progress bar; yazl pipes it.
          const counter = new Transform({
            transform(chunk, _encoding, done) {
              download.progress += chunk.length;
              done(null, chunk);
            }
          });
          const source = createReadStream(file.path);
          source.on('error', (error) => counter.destroy(error));
          counter.on('error', fail);
          callback(null, source.pipe(counter));
        }
      );
    }
    for (const folder of folders) zip.addEmptyDirectory(folder, {});
    zip.end();
    download.stream = zip.outputStream;
    download.stream.on('end', () => {
      download.ended = true;
      download.wake?.();
    });
    download.stream.on('readable', () => download.wake?.());
    download.stream.on('error', fail);
    return { sourceBytes, files: files.length };
  };

  const start = async ({ path }, owner) => {
    if ([...downloads.values()].filter((download) => download.owner === owner).length >= MAX_OPEN_PER_WINDOW) {
      throw new InvalidRequest('Too many downloads at once; wait for the others to finish');
    }
    const { real, info } = await resolvePath(path, fileOptions);
    if (!info.isFile() && !info.isDirectory()) throw new InvalidRequest(`Not a file or folder: ${path}`);
    const id = randomUUID();
    const download = {
      id,
      owner,
      name: info.isDirectory() ? `${basename(real) || 'folder'}.zip` : basename(real),
      sent: 0,
      progress: 0,
      hash: createHash('sha256'),
      queue: Promise.resolve(),
      timer: undefined
    };
    let described;
    if (info.isDirectory()) {
      described = { kind: 'zip', ...(await zipOf(real, download)) };
    } else {
      download.handle = await open(real, 'r');
      download.size = info.size;
      download.mtimeMs = info.mtimeMs;
      described = { kind: 'file', size: info.size, mtimeMs: info.mtimeMs };
    }
    downloads.set(id, download);
    touch(download);
    log(`Sending ${real} to a window${described.kind === 'zip' ? ` as a zip of ${described.files} files` : ` (${info.size} bytes)`}`);
    return { downloadId: id, name: download.name, chunkBytes: DOWNLOAD_CHUNK_BYTES, ...described };
  };

  /** Up to `size` bytes of the zip, fewer only at its end. */
  const pull = async (download, size) => {
    const parts = [];
    let length = 0;
    while (length < size) {
      if (download.error) throw download.error;
      const part = download.stream.read();
      if (part === null) {
        if (download.ended) break;
        await new Promise((resolve) => (download.wake = resolve));
        download.wake = undefined;
        continue;
      }
      if (length + part.length > size) {
        download.stream.unshift(part.subarray(size - length));
        parts.push(part.subarray(0, size - length));
        length = size;
      } else {
        parts.push(part);
        length += part.length;
      }
    }
    if (download.error) throw download.error;
    return Buffer.concat(parts, length);
  };

  const read = async (download) => {
    if (!download.handle) {
      const data = await pull(download, DOWNLOAD_CHUNK_BYTES);
      return { data, done: download.ended && download.stream.readableLength === 0 };
    }
    const length = Math.min(DOWNLOAD_CHUNK_BYTES, download.size - download.sent);
    const data = Buffer.alloc(length);
    const { bytesRead } = await download.handle.read(data, 0, length, download.sent);
    const done = download.sent + bytesRead >= download.size;
    const now = await download.handle.stat();
    if (bytesRead < length || (done && (now.size !== download.size || now.mtimeMs !== download.mtimeMs))) {
      throw new InvalidRequest(`${download.name} changed while downloading; try again`);
    }
    download.progress = download.sent + bytesRead;
    return { data, done };
  };

  const chunk = async (download, params) => {
    if (!downloads.has(download.id)) throw new InvalidRequest('Unknown download');
    if (params.offset !== download.sent) {
      throw new InvalidRequest(`Expected a request for byte ${download.sent}, not ${params.offset}`);
    }
    let result;
    try {
      result = await read(download);
    } catch (error) {
      await drop(download);
      throw error;
    }
    download.hash.update(result.data);
    download.sent += result.data.length;
    touch(download);
    const answer = { data: result.data.toString('base64'), done: result.done, progress: download.progress };
    if (result.done) {
      await drop(download);
      answer.sha256 = download.hash.digest('hex');
    }
    return answer;
  };

  return {
    capability: { chunkBytes: DOWNLOAD_CHUNK_BYTES, folders: true },
    /** `_codeflower/files/download`: start with {path}, ask for {downloadId, offset} until `done`, or send {downloadId, cancel}. */
    async handle(params, owner) {
      if (params?.cancel) {
        const download = downloads.get(params.downloadId);
        if (download && download.owner === owner) await drop(download);
        return {};
      }
      if (params?.downloadId !== undefined) {
        const download = owned(params, owner);
        // Requests of one download are answered in the order they arrive.
        const answered = download.queue.then(() => chunk(download, params));
        download.queue = answered.catch(() => {});
        return answered;
      }
      return start(params ?? {}, owner);
    },
    /** A window went away: its downloads go with it. */
    async release(owner) {
      await Promise.all([...downloads.values()].filter((download) => download.owner === owner).map(drop));
    },
    async close() {
      await Promise.all([...downloads.values()].map(drop));
    }
  };
}
