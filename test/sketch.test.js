import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const sketch = fileURLToPath(new URL('../bin/codeflower-sketch', import.meta.url));

// A 2x1 PNG and a small SVG icon with an id of its own.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP8z8Dwn4EBCAAZ9AL/mSGvVQAAAABJRU5ErkJggg==', 'base64');
const otherPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/0Ft7ugAAAABJRU5ErkJggg==', 'base64');
const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><defs><linearGradient id="g"/></defs><rect id="body" width="20" height="10" fill="url(#g)"/></svg>';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'codeflower-sketch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const icons = join(dir, 'icons');
  const workspace = join(dir, 'workspace');
  mkdirSync(icons);
  mkdirSync(join(workspace, 'figures'), { recursive: true });
  const env = { ...process.env, CODEFLOWER_ICONS: icons, CODEFLOWER_WORKSPACE: workspace };
  delete env.CODEFLOWER_IMAGE_PROVIDER;
  delete env.CODEFLOWER_IMAGE_KEY_FILE;
  const run = (...args) => spawnSync('python3', ['-I', sketch, ...args], { env, encoding: 'utf8', cwd: workspace });
  return { dir, icons, workspace, env, run };
}

// A slide kit: two pictures named by the text boxes next to them, one by its alt text, and the
// first picture again on a second slide.
function writeKit(path) {
  const script = String.raw`
import sys, zipfile
NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
def pic(rid, x, name, descr=""):
    return f'<p:pic><p:nvPicPr><p:cNvPr id="1" name="{name}" descr="{descr}"/></p:nvPicPr><p:blipFill><a:blip r:embed="{rid}"/></p:blipFill><p:spPr><a:xfrm><a:off x="{x}" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr></p:pic>'
def text(x, words):
    return f'<p:sp><p:spPr><a:xfrm><a:off x="{x}" y="150"/><a:ext cx="100" cy="20"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>{words}</a:t></a:r></a:p></p:txBody></p:sp>'
def rels(*targets):
    return '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join(f'<Relationship Id="rId{i}" Target="../media/{t}"/>' for i, t in enumerate(targets, 1)) + '</Relationships>'
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('ppt/slides/slide1.xml', f'<p:sld {NS}><p:cSld><p:spTree>{pic("rId1", 0, "Picture 1")}{text(0, "Heart")}{pic("rId2", 1000, "Picture 2")}{text(1000, "Lung")}</p:spTree></p:cSld></p:sld>')
    z.writestr('ppt/slides/_rels/slide1.xml.rels', rels('image1.png', 'image2.svg'))
    z.writestr('ppt/slides/slide2.xml', f'<p:sld {NS}><p:cSld><p:spTree>{pic("rId1", 0, "Picture 3")}{pic("rId2", 500, "Picture 4", "Red blood cell")}</p:spTree></p:cSld></p:sld>')
    z.writestr('ppt/slides/_rels/slide2.xml.rels', rels('image1.png', 'image3.png'))
    z.writestr('ppt/media/image1.png', open(sys.argv[2], 'rb').read())
    z.writestr('ppt/media/image2.svg', sys.argv[3])
    z.writestr('ppt/media/image3.png', open(sys.argv[4], 'rb').read())
`;
  const dir = join(path, '..');
  writeFileSync(join(dir, 'a.png'), png);
  writeFileSync(join(dir, 'b.png'), otherPng);
  execFileSync('python3', ['-I', '-c', script, path, join(dir, 'a.png'), svg, join(dir, 'b.png')]);
}

const metaOf = (icons, ref) => JSON.parse(readFileSync(join(icons, ref, 'meta.json'), 'utf8'));

test('imports a Servier slide kit with names from the slides, once per image', (t) => {
  const { dir, icons, run } = setup(t);
  const kit = join(dir, 'SMART-Cardiovascular-system.pptx');
  writeKit(kit);
  const first = run('import', kit, '--source', 'servier');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /3 icon\(s\) added/);
  assert.deepEqual(readdirSync(join(icons, 'servier')).sort(), ['heart', 'lung', 'red-blood-cell']);
  const heart = metaOf(icons, 'servier/heart');
  assert.equal(heart.license, 'CC BY 4.0');
  assert.equal(heart.category, 'Cardiovascular system');
  assert.equal(heart.filename, 'icon.png');
  assert.equal(metaOf(icons, 'servier/lung').filename, 'icon.svg');
  const again = run('import', kit, '--source', 'servier');
  assert.match(again.stdout, /0 icon\(s\) added/);
  assert.match(again.stdout, /already in the gallery/);
});

test('a SciDraw drawing needs its credit and an open license', (t) => {
  const { dir, icons, run } = setup(t);
  const file = join(dir, 'mouse.svg');
  writeFileSync(file, svg);
  const missing = run('import', file, '--source', 'scidraw');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--authors, --license, --url or --doi/);
  const closed = run('import', file, '--source', 'scidraw', '--authors', 'A', '--license', 'CC BY-NC 4.0', '--doi', '10.5281/zenodo.1');
  assert.equal(closed.status, 1);
  assert.match(closed.stderr, /not CC BY or CC0/);
  const ok = run('import', file, '--source', 'scidraw', '--authors', 'Tyler, Ethan; Kravitz, Lex', '--license', 'cc-by-4.0',
    '--doi', '10.5281/zenodo.3925901', '--tag', 'rodent');
  assert.equal(ok.status, 0, ok.stderr);
  const meta = metaOf(icons, 'scidraw/mouse');
  assert.equal(meta.license, 'CC BY 4.0');
  assert.equal(meta.url, 'https://doi.org/10.5281/zenodo.3925901');
  const found = run('find', 'rodent');
  assert.match(found.stdout, /scidraw\/mouse: mouse \[SVG, CC BY 4\.0\]/);
});

test('imports running at the same time keep every icon', async (t) => {
  const { dir, icons, env } = setup(t);
  const files = [png, otherPng].map((data, index) => {
    const file = join(dir, `same-name-${index}.png`);
    writeFileSync(file, data);
    return file;
  });
  const run = promisify(execFile);
  await Promise.all(files.map((file) => run('python3', ['-I', sketch, 'import', file, '--source', 'own', '--title', 'Cell'], { env })));
  assert.deepEqual(readdirSync(join(icons, 'own')).sort(), ['cell', 'cell-2']);
});

test('find prints the catalogs to search when nothing fits', (t) => {
  const { run } = setup(t);
  const result = run('find', 'zebra', 'fish');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No icon in the gallery matches 'zebra fish'/);
  assert.match(result.stdout, /https:\/\/smart\.servier\.com\/\?s=zebra\+fish/);
  assert.match(result.stdout, /zenodo\.org\/search\?q=/);
  assert.match(result.stdout, /attach it in the chat/);
});

test('place inlines icons, and credits and check read them back from the figure', (t) => {
  const { dir, icons, workspace, run } = setup(t);
  const kit = join(dir, 'SMART-Cardiovascular-system.pptx');
  writeKit(kit);
  run('import', kit, '--source', 'servier');
  const drawing = join(dir, 'mouse.svg');
  writeFileSync(drawing, svg.replace('fill=', 'stroke="black" fill='));
  run('import', drawing, '--source', 'scidraw', '--authors', 'Tyler, Ethan', '--license', 'CC BY 4.0', '--doi', '10.5281/zenodo.3925901');

  const placedSvg = run('place', 'scidraw/mouse', '--x', '10', '--y', '5', '--width', '40');
  assert.equal(placedSvg.status, 0, placedSvg.stderr);
  assert.match(placedSvg.stdout, /<g id="mouse" data-label="mouse" data-cf-icon="scidraw\/mouse" transform="translate\(10 5\)">/);
  assert.match(placedSvg.stdout, /width="40" height="20" viewBox="0 0 20 10"/);
  assert.match(placedSvg.stdout, /id="mouse-g".*fill="url\(#mouse-g\)"/s);
  assert.doesNotMatch(placedSvg.stdout, /<\?xml/);
  const placedPng = run('place', 'servier/heart', '--width', '30');
  assert.match(placedPng.stdout, /<image width="30" height="15" href="data:image\/png;base64,/);

  const figure = join(workspace, 'figures', 'overview.svg');
  const placedHeart = placedPng.stdout.replace('data-cf-icon=', 'data-cf-adapted="true" data-cf-icon=');
  writeFileSync(figure, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">${placedSvg.stdout}${placedHeart}<text>Unnamed</text></svg>`);
  const credits = run('credits', figure);
  assert.equal(credits.status, 0, credits.stderr);
  assert.match(credits.stdout, /Images adapted from Servier Medical Art \(https:\/\/smart\.servier\.com\), licensed under CC BY 4\.0/);
  assert.match(credits.stdout, /"mouse" by Tyler, Ethan, SciDraw, doi:10\.5281\/zenodo\.3925901, CC BY 4\.0/);
  assert.match(readFileSync(join(workspace, 'figures', 'overview.credits.md'), 'utf8'), /`servier\/heart`: Heart \(adapted\)/);

  const check = run('check', figure);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /a top-level <text> has no id/);
  rmSync(join(icons, 'scidraw', 'mouse'), { recursive: true });
  assert.match(run('check', figure).stdout, /the icon scidraw\/mouse is not in the gallery/);

  const gallery = run('gallery', 'heart');
  assert.equal(gallery.status, 0, gallery.stderr);
  assert.match(readFileSync(join(workspace, 'figures', 'icons', 'gallery.html'), 'utf8'), /1 icon\(s\) matching heart/);
});

test('generate explains how to configure a provider, and stores what the provider returns', async (t) => {
  const { dir, icons, env, run } = setup(t);
  const unconfigured = run('generate', 'a zebrafish larva', '--name', 'Zebrafish larva');
  assert.equal(unconfigured.status, 3);
  assert.match(unconfigured.stderr, /No image provider is configured/);

  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const keyFile = join(dir, 'image-key');
  writeFileSync(keyFile, 'sk-test\n', { mode: 0o600 });
  const result = await promisify(execFile)('python3', ['-I', sketch, 'generate', 'a zebrafish larva', '--name', 'Zebrafish larva'], {
    env: {
      ...env,
      CODEFLOWER_IMAGE_PROVIDER: 'openai',
      CODEFLOWER_IMAGE_KEY_FILE: keyFile,
      CODEFLOWER_IMAGE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      NO_PROXY: '127.0.0.1'
    }
  });
  assert.match(result.stdout, /added generated\/zebrafish-larva/);
  assert.equal(requests[0].url, '/v1/images/generations');
  assert.equal(requests[0].authorization, 'Bearer sk-test');
  assert.equal(requests[0].body.model, 'gpt-image-1');
  assert.match(requests[0].body.prompt, /^a zebrafish larva\. A single scientific illustration icon/);
  const meta = metaOf(icons, 'generated/zebrafish-larva');
  assert.equal(meta.prompt, 'a zebrafish larva');
  assert.equal(meta.provider, 'openai');
  assert.ok(existsSync(join(icons, 'generated', 'zebrafish-larva', 'icon.png')));
});

test('sources prints the licensing notes, and a missing gallery is explained', (t) => {
  const { run, env, workspace } = setup(t);
  assert.match(run('sources').stdout, /# Icon sources, licenses and credits/);
  const missing = spawnSync('python3', ['-I', sketch, 'find', 'heart'], {
    env: { ...env, CODEFLOWER_ICONS: join(workspace, 'nowhere') }, encoding: 'utf8'
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /icon gallery is not mounted/);
});
