import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createThumbnails, tiffLevel } from '../src/thumbnails.js';

async function setup(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-thumbnails-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const cache = join(root, 'state', 'thumbnails');
  await mkdir(workspace, { recursive: true });
  const fileOptions = { workspace, privateDirectory: join(root, 'private'), writableFolders: [] };
  return { workspace, cache, thumbnails: createThumbnails({ directory: cache, fileOptions }) };
}

/** An uncompressed 16-bit grey TIFF, which sharp cannot write. */
function tiff16(width, height, value) {
  const tags = [[256, 4, width], [257, 4, height], [258, 3, 16], [259, 3, 1], [262, 3, 1], [273, 4, 0], [277, 3, 1], [278, 4, height], [279, 4, width * height * 2]];
  const ifd = 8;
  const dataAt = ifd + 2 + tags.length * 12 + 4;
  const buffer = Buffer.alloc(dataAt + width * height * 2);
  buffer.write('II', 0);
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(ifd, 4);
  buffer.writeUInt16LE(tags.length, ifd);
  tags.forEach(([tag, type, entry], index) => {
    const at = ifd + 2 + index * 12;
    buffer.writeUInt16LE(tag, at);
    buffer.writeUInt16LE(type, at + 2);
    buffer.writeUInt32LE(1, at + 4);
    if (type === 3) buffer.writeUInt16LE(entry, at + 8);
    else buffer.writeUInt32LE(tag === 273 ? dataAt : entry, at + 8);
  });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) buffer.writeUInt16LE(value(x, y), dataAt + (y * width + x) * 2);
  }
  return buffer;
}

const brightness = async (thumbnail) => {
  const [grey] = (await sharp(Buffer.from(thumbnail.data, 'base64')).stats()).channels;
  return { min: grey.min, max: grey.max, mean: Math.round(grey.mean) };
};

const size = async (thumbnail) => {
  const { format, width, height } = await sharp(Buffer.from(thumbnail.data, 'base64')).metadata();
  return { format, width, height };
};

test('makes a small WebP of a figure, kept for the next time', async (context) => {
  const { workspace, cache, thumbnails } = await setup(context);
  const figure = join(workspace, 'umap.png');
  await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#5b6cff' } }).png().toFile(figure);

  const thumbnail = await thumbnails.thumbnail(figure, 200);
  assert.equal(thumbnail.mimeType, 'image/webp');
  assert.deepEqual(await size(thumbnail), { format: 'webp', width: 400, height: 200 });
  assert.equal((await readdir(cache)).length, 1);
  assert.deepEqual(await thumbnails.thumbnail('umap.png', 200), thumbnail);

  // A rewritten figure gets a new one.
  await sharp({ create: { width: 100, height: 400, channels: 3, background: '#ff6b9d' } }).png().toFile(figure);
  assert.deepEqual(await size(await thumbnails.thumbnail(figure, 200)), { format: 'webp', width: 50, height: 200 });
  assert.equal((await readdir(cache)).length, 2);
});

test('keeps small images small, caps wide ones, and draws SVGs', async (context) => {
  const { workspace, thumbnails } = await setup(context);
  await sharp({ create: { width: 60, height: 40, channels: 4, background: '#0000' } }).png().toFile(join(workspace, 'icon.png'));
  assert.deepEqual(await size(await thumbnails.thumbnail('icon.png', 384)), { format: 'webp', width: 60, height: 40 });
  await sharp({ create: { width: 8000, height: 1000, channels: 3, background: '#fff' } }).png().toFile(join(workspace, 'panels.png'));
  assert.deepEqual(await size(await thumbnails.thumbnail('panels.png', 200)), { format: 'webp', width: 600, height: 75 });
  await writeFile(join(workspace, 'plot.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#5b6cff"/></svg>');
  assert.deepEqual(await size(await thumbnails.thumbnail('plot.svg', 100)), { format: 'webp', width: 200, height: 100 });
});

test('refuses files that are not images, and files outside the sandbox', async (context) => {
  const { workspace, thumbnails } = await setup(context);
  await writeFile(join(workspace, 'notes.txt'), 'hello');
  await assert.rejects(thumbnails.thumbnail('notes.txt'), /Not an image/);
  await writeFile(join(workspace, 'broken.png'), 'not a png');
  await assert.rejects(thumbnails.thumbnail('broken.png'), /Could not make a thumbnail/);
  await assert.rejects(thumbnails.thumbnail('/etc/hosts'));
});

test('reads microscopy TIFFs: stretches 16 bits, takes a small pyramid level and a stack\'s first plane', async (context) => {
  const { workspace, thumbnails } = await setup(context);
  // 16-bit values from 1000 to 3000 of 65535: black, but for the stretch.
  await writeFile(join(workspace, 'cells.tif'), tiff16(400, 200, (x) => 1000 + Math.round((x / 399) * 2000)));
  const deep = await thumbnails.thumbnail('cells.tif', 100);
  assert.deepEqual(await size(deep), { format: 'webp', width: 200, height: 100 });
  const { min, max, mean } = await brightness(deep);
  assert.ok(min <= 5 && max >= 250 && mean > 100 && mean < 155, `${min} ${max} ${mean}`);

  const pyramid = join(workspace, 'slide.ome.tif');
  await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#5b6cff' } })
    .tiff({ tile: true, pyramid: true, compression: 'jpeg' })
    .toFile(pyramid);
  const level = await tiffLevel(pyramid, 384);
  assert.deepEqual([level.options, level.info.width, level.info.height], [{ page: 3 }, 1000, 750]);
  assert.deepEqual(await size(await thumbnails.thumbnail(pyramid, 384)), { format: 'webp', width: 512, height: 384 });

  const plane = (value) =>
    sharp({ create: { width: 500, height: 400, channels: 3, background: { r: value, g: value, b: value } } }).png().toBuffer();
  await sharp([await plane(30), await plane(120), await plane(220)], { join: { animated: true } }).tiff().toFile(join(workspace, 'stack.tif'));
  assert.deepEqual((await tiffLevel(join(workspace, 'stack.tif'), 100)).options, {});
  assert.equal((await brightness(await thumbnails.thumbnail('stack.tif', 100))).mean, 30);
});

test('makes none of images over 200 MB', async (context) => {
  const { workspace, thumbnails } = await setup(context);
  const huge = join(workspace, 'huge.tif');
  await writeFile(huge, '');
  await truncate(huge, 201 * 1024 * 1024);
  await assert.rejects(thumbnails.thumbnail('huge.tif'), /too large to show/);
});
