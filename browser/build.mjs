#!/usr/bin/env node
// Builds the browser bundle that codeflower-browser installs on first use:
// Chrome's headless shell (the build playwright-core names, from Playwright's
// CDN) and playwright-cli (this folder's package-lock.json), one archive per
// architecture. The archives are reproducible (sorted, fixed times and
// owners), and bundle.json records their hashes; the image carries
// bundle.json, so a sandbox installs exactly the bundle its image was built
// with. The archives are published as the codeflower-sandbox release
// browser-<version>, which bundle.json's URLs name.
//
//   node browser/build.mjs            build into build/browser and write bundle.json
//   node browser/build.mjs --check    build again and fail unless the hashes match bundle.json
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'build', 'browser');
const manifestPath = join(here, 'bundle.json');
const check = process.argv.includes('--check');
const CDN = 'https://cdn.playwright.dev/builds/cft';
// Where the archives are published, one release per bundle version.
const RELEASES = 'https://github.com/lutrarutra/codeflower-sandbox/releases/download';
const ARCHES = { x64: 'linux64', arm64: 'linux-arm64' };

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options });
const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : undefined;

// playwright-cli, as the lockfile pins it; it is plain JavaScript, the same for every architecture.
const work = join(out, 'work');
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'cli'), { recursive: true });
for (const name of ['package.json', 'package-lock.json']) cpSync(join(here, name), join(work, 'cli', name));
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: join(work, 'cli'),
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }
});
const cliVersion = JSON.parse(readFileSync(join(work, 'cli', 'node_modules', '@playwright', 'cli', 'package.json'), 'utf8')).version;
const browsers = JSON.parse(readFileSync(join(work, 'cli', 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')).browsers;
const chromium = browsers.find((browser) => browser.name === 'chromium-headless-shell')?.browserVersion;
if (!chromium) throw new Error('playwright-core names no chromium-headless-shell');
const version = `${cliVersion}-${chromium}`;
console.log(`bundle ${version}: playwright-cli ${cliVersion}, Chrome headless shell ${chromium}`);

const files = {};
const sources = {};
for (const [arch, platform] of Object.entries(ARCHES)) {
  // Chrome's headless shell for the architecture, checked against the hash recorded the first time.
  const url = `${CDN}/${chromium}/${platform}/chrome-headless-shell-${platform}.zip`;
  const zip = join(out, 'downloads', `chrome-headless-shell-${chromium}-${platform}.zip`);
  if (!existsSync(zip)) {
    mkdirSync(dirname(zip), { recursive: true });
    console.log(`downloading ${url}`);
    run('curl', ['-fsSL', '--retry', '3', '-o', `${zip}.part`, url]);
    renameSync(`${zip}.part`, zip);
  }
  const zipHash = await sha256(zip);
  const known = previous?.chromium === chromium ? previous.sources?.[arch]?.sha256 : undefined;
  if (known && known !== zipHash) throw new Error(`${url} changed: ${zipHash}, recorded ${known}`);
  sources[arch] = { url, sha256: zipHash };

  // The bundle: chromium/ (the headless shell), cli/ (playwright-cli), bundle.json.
  const root = join(work, arch);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  run('unzip', ['-q', zip, '-d', join(work, `${arch}-unzip`)]);
  renameSync(join(work, `${arch}-unzip`, `chrome-headless-shell-${platform}`), join(root, 'chromium'));
  rmSync(join(work, `${arch}-unzip`), { recursive: true, force: true });
  cpSync(join(work, 'cli'), join(root, 'cli'), { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(root, 'bundle.json'), `${JSON.stringify({ version, arch, chromium, playwrightCli: cliVersion }, null, 2)}\n`);

  const name = `codeflower-browser-${version}-linux-${arch}.tar.gz`;
  const archive = join(out, name);
  // Reproducible: the same inputs give the same bytes.
  run('sh', [
    '-c',
    'tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=u+rw,go+r,go-w --format=gnu -C "$1" -cf - . | gzip -n -9 > "$2"',
    'pack',
    root,
    archive
  ]);
  files[arch] = { url: `${RELEASES}/browser-${version}/${name}`, sha256: await sha256(archive), size: statSync(archive).size };
  console.log(`${name}: ${(files[arch].size / 2 ** 20).toFixed(1)} MB, sha256 ${files[arch].sha256}`);
}
rmSync(work, { recursive: true, force: true });

const manifest = {
  version,
  chromium,
  playwrightCli: cliVersion,
  // Relative to the bundle's folder.
  binary: 'chromium/chrome-headless-shell',
  cli: 'cli/node_modules/@playwright/cli/playwright-cli.js',
  files,
  sources
};
if (check) {
  const differs = Object.keys(ARCHES).filter((arch) => previous?.files?.[arch]?.sha256 !== files[arch].sha256);
  if (previous?.version !== version || differs.length) {
    console.error(`The build does not match bundle.json (${previous?.version} → ${version}; differs: ${differs.join(', ') || 'version'})`);
    process.exit(1);
  }
  console.log('The build matches bundle.json.');
} else {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${manifestPath}; publish ${Object.values(files).map((file) => file.url.split('/').pop()).join(' and ')} as release browser-${version}`);
}
console.log(`archives in ${out}: ${readdirSync(out).filter((name) => name.endsWith('.tar.gz')).join(', ')}`);
