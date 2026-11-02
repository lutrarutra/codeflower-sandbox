import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { InvalidRequest } from './agents.js';
import { resolveFile } from './files.js';

// Small WebP versions of the images a chat shows, so it does not fetch whole
// figures to draw them 160 pixels high, and large ones of images a browser
// cannot show (TIFF) or that are too large to send. They are kept in the
// project state (thumbnails/, next to sessions/), keyed by the file's path,
// version and the size asked for: shared by the project's workers, and made
// again when the agent rewrites the file. The folder stays under CACHE_BYTES,
// oldest first.
//
// Microscopy TIFFs (OME-TIFF, BigTIFF, LSM, MetaMorph, Aperio, ...) are read at
// the smallest pyramid level that is large enough, the first plane of a stack,
// the first channel of more than four, and with more than 8 bits contrast
// stretched as viewers' auto contrast does, which would otherwise look black.
const DEFAULT_HEIGHT = 384;
const MIN_HEIGHT = 32;
const MAX_HEIGHT = 4096;
// Wide figures (a row of panels) may be this many times wider than high.
const MAX_ASPECT = 3;
const MAX_INPUT_BYTES = 200 * 1024 * 1024;
// The level read, after choosing one; with the time limit, what one image may cost.
const MAX_INPUT_PIXELS = 1_000_000_000;
const TIMEOUT_SECONDS = 30;
// Pyramid levels and pages looked at for a TIFF's smallest fitting level.
const MAX_LEVELS = 16;
// The share of the darkest and brightest pixels a deep image's contrast stretch leaves out.
const CLIP = 0.005;
const CACHE_BYTES = 64 * 1024 * 1024;
const PRUNE_EVERY = 50;
// One or two at a time, so a chat full of figures does not slow the agent down.
const CONCURRENT = 2;
const IMAGE = /^image\/(png|jpeg|gif|webp|svg\+xml|tiff)$/;
const READ = { failOn: 'none', limitInputPixels: false };

/** Width and height of an image, page or pyramid level; undefined if it cannot be read. */
const probe = (path, options) =>
  sharp(path, { ...READ, ...options })
    .metadata()
    .then((info) => ({ options, info }))
    .catch(() => undefined);

/**
 * Where to read a TIFF from: the smallest of its pyramid levels (SubIFDs, as
 * OME-TIFF stores them, or pages, as Aperio and libvips do) that is still
 * `height` pixels high. Pages of another shape, a slide's label or overview
 * photo, and planes of a stack, all as large as the first, are not levels.
 */
export async function tiffLevel(path, height) {
  const base = await probe(path, {});
  if (!base) throw new Error('not a readable TIFF');
  const ratio = base.info.width / base.info.height;
  const found = await Promise.all([
    ...Array.from({ length: Math.min(base.info.subifds ?? 0, MAX_LEVELS) }, (_, subifd) => probe(path, { subifd })),
    ...Array.from({ length: Math.min((base.info.pages ?? 1) - 1, MAX_LEVELS) }, (_, index) => probe(path, { page: index + 1 }))
  ]);
  const levels = found.filter(
    (level) =>
      level &&
      level.info.width < base.info.width &&
      Math.abs(level.info.width / level.info.height - ratio) / ratio < 0.05
  );
  const needed = Math.min(height, base.info.height);
  return [base, ...levels]
    .filter((level) => level.info.height >= needed)
    .reduce((best, level) => (level.info.width * level.info.height < best.info.width * best.info.height ? level : best));
}

/** An image with more than 8 bits per sample, as 8 bits: its values from the darkest to the brightest, but for outliers. */
function stretch(values) {
  const step = Math.max(1, Math.floor(values.length / 200_000));
  const sample = [];
  for (let index = 0; index < values.length; index += step) {
    if (Number.isFinite(values[index])) sample.push(values[index]);
  }
  sample.sort((a, b) => a - b);
  const low = sample[Math.floor(sample.length * CLIP)] ?? 0;
  const high = Math.max(sample[Math.ceil(sample.length * (1 - CLIP)) - 1] ?? 1, low + Number.EPSILON);
  const scale = 255 / (high - low);
  const out = new Uint8Array(values.length);
  for (let index = 0; index < values.length; index++) {
    const value = (values[index] - low) * scale;
    out[index] = value > 255 ? 255 : value > 0 ? value : 0;
  }
  return out;
}

sharp.concurrency(1);

async function render(file, bound) {
  const level = file.mimeType === 'image/tiff' ? await tiffLevel(file.path, bound) : { options: {} };
  if (level.info && level.info.width * level.info.height > MAX_INPUT_PIXELS) {
    throw new Error(`it has ${Math.round((level.info.width * level.info.height) / 1e6)} megapixels`);
  }
  const deep = !!level.info && !['uchar', 'char'].includes(level.info.depth);
  let image = sharp(file.path, { ...READ, ...level.options, limitInputPixels: MAX_INPUT_PIXELS })
    .timeout({ seconds: TIMEOUT_SECONDS })
    .rotate();
  // Channels of a fluorescence image, not colours: the first of them.
  const channels = level.info?.channels ?? 0;
  if (channels > 4 || (deep && channels === 2)) image = image.extractChannel(0);
  else if (deep) image = image.removeAlpha();
  image = image.resize({ height: bound, width: bound * MAX_ASPECT, fit: 'inside', withoutEnlargement: true });
  if (!deep) return image.webp({ quality: 80, effort: 2 }).toBuffer();
  const { data, info } = await image.raw({ depth: 'float' }).toBuffer({ resolveWithObject: true });
  const values = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  return sharp(stretch(values), { raw: { width: info.width, height: info.height, channels: info.channels } })
    .webp({ quality: 80, effort: 2 })
    .toBuffer();
}

export function createThumbnails({ directory, fileOptions, log = () => {} }) {
  let running = 0;
  const waiting = [];
  let written = 0;

  const slot = async () => {
    if (running >= CONCURRENT) await new Promise((resolve) => waiting.push(resolve));
    running += 1;
  };
  const release = () => {
    running -= 1;
    waiting.shift()?.();
  };

  const prune = async () => {
    const files = [];
    for (const name of await readdir(directory).catch(() => [])) {
      if (!name.endsWith('.webp')) continue;
      const info = await stat(join(directory, name)).catch(() => undefined);
      if (info) files.push({ name, size: info.size, mtimeMs: info.mtimeMs });
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= CACHE_BYTES) break;
      await unlink(join(directory, file.name)).catch(() => {});
      total -= file.size;
    }
  };

  const store = async (file, data) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    if (++written % PRUNE_EVERY === 0) await prune();
  };

  return {
    /** A thumbnail of the image at `path`, at most `height` pixels high, as base64 WebP. */
    async thumbnail(path, height = DEFAULT_HEIGHT) {
      const file = await resolveFile(path, fileOptions);
      if (!IMAGE.test(file.mimeType)) throw new InvalidRequest(`Not an image: ${path}`);
      if (file.size > MAX_INPUT_BYTES) {
        throw new InvalidRequest(`${path} is too large to show (${Math.round(file.size / 1024 / 1024)} MB; at most 200 MB)`);
      }
      const bound = Math.min(Math.max(Number.isSafeInteger(height) ? height : DEFAULT_HEIGHT, MIN_HEIGHT), MAX_HEIGHT);
      const key = createHash('sha256').update(`${file.path}\0${file.mtimeMs}\0${file.size}\0${bound}`).digest('hex');
      const cached = directory && join(directory, `${key}.webp`);
      if (cached) {
        const data = await readFile(cached).catch(() => undefined);
        if (data) {
          // Recently used ones are the last to go.
          const now = new Date();
          await utimes(cached, now, now).catch(() => {});
          return { mimeType: 'image/webp', data: data.toString('base64') };
        }
      }
      await slot();
      let data;
      try {
        data = await render(file, bound);
      } catch (error) {
        throw new InvalidRequest(`Could not make a thumbnail of ${path}: ${error.message}`);
      } finally {
        release();
      }
      if (cached) {
        await store(cached, data).catch((error) => log(`Could not keep a thumbnail of ${path}: ${error.message}`));
      }
      return { mimeType: 'image/webp', data: data.toString('base64') };
    }
  };
}
