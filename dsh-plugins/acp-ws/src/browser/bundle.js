// The browser bundle (sandbox/browser/build.mjs): Chrome's headless shell and
// playwright-cli, which the image does not carry. The image's bundle.json pins
// it (version, and each architecture's archive with its sha256); the first
// codeflower-browser command installs exactly that into the project state,
// once per project: downloaded from its release, or from a file the user put
// in the sandbox (`codeflower-browser install --from FILE`), checked against
// the pinned hash, unpacked and renamed into place. Nothing of the agent's
// runs in it, and no installer of anyone else's.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, constants, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MANIFEST = '/opt/codeflower/browser/bundle.json';
// Another worker of the project installing the same bundle holds the lock; one older than this is left over.
const STALE_LOCK_MS = 20 * 60_000;
const LOCK_POLL_MS = 1000;

export class BundleError extends Error {}

/** The image's bundle.json, or undefined for an image without a browser bundle. */
export async function readManifest(path = MANIFEST) {
  try {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    return typeof manifest?.version === 'string' && manifest.files ? manifest : undefined;
  } catch {
    return undefined;
  }
}

const exists = (path, mode = constants.F_OK) =>
  access(path, mode).then(
    () => true,
    () => false
  );

const megabytes = (bytes) => `${Math.round(bytes / 2 ** 20)} MB`;

/**
 * The bundle of `manifest` for this machine's architecture, installed under
 * `directory` (`<version>-linux-<arch>/`).
 */
export function createBundle({ manifest, directory, arch = process.arch, log = () => {}, fetchImpl = globalThis.fetch }) {
  const file = manifest.files?.[arch];
  const folder = join(directory, `${manifest.version}-linux-${arch}`);
  const binary = join(folder, manifest.binary);
  const cli = join(folder, manifest.cli);
  // The install running here: { promise, received, total }.
  let installing;
  let lastError;

  const installed = async () => (await exists(binary, constants.X_OK)) && (await exists(cli));

  // Copies `source` (a stream) to `target`, hashing and counting what passes.
  const receive = async (source, target, progress) => {
    const hash = createHash('sha256');
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        progress.received += chunk.length;
        callback(null, chunk);
      }
    });
    await pipeline(source, counter, createWriteStream(target, { mode: 0o600 }));
    return hash.digest('hex');
  };

  const unpack = (archive, into) =>
    new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', archive, '-C', into, '--no-same-owner', '--no-same-permissions'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      tar.stderr.on('data', (chunk) => (stderr += chunk));
      tar.once('error', reject);
      tar.once('close', (code) => (code === 0 ? resolve() : reject(new BundleError(`Could not unpack the browser bundle: ${stderr.trim() || `tar ended with ${code}`}`))));
    });

  // One worker of the project at a time; the others wait for its bundle.
  const lock = async () => {
    const path = `${folder}.lock`;
    for (;;) {
      try {
        const handle = await open(path, 'wx');
        await handle.writeFile(`${process.pid}\n`);
        await handle.close();
        return () => rm(path, { force: true });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const held = await stat(path).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) await rm(path, { force: true });
      else if (await installed()) return undefined;
      else await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  };

  const install = async (from, progress) => {
    if (!file) throw new BundleError(`The browser bundle has no build for ${arch}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const unlock = await lock();
    if (!unlock) return;
    const archive = `${folder}.download-${process.pid}`;
    const staging = `${folder}.unpack-${process.pid}`;
    try {
      if (await installed()) return;
      progress.total = file.size;
      let digest;
      if (from) {
        log(`Installing the browser bundle ${manifest.version} from ${from}`);
        digest = await receive(createReadStream(from), archive, progress);
      } else {
        log(`Downloading the browser bundle ${manifest.version} from ${file.url}`);
        let response;
        try {
          response = await fetchImpl(file.url, { redirect: 'follow' });
        } catch (error) {
          throw new BundleError(`Could not download the browser bundle from ${file.url}: ${error.cause?.message ?? error.message}`);
        }
        if (!response.ok || !response.body) {
          throw new BundleError(
            `Could not download the browser bundle from ${file.url}: HTTP ${response.status}` +
              (response.status === 403 ? ' (with an isolated network, allow @github in the allowlist)' : '')
          );
        }
        digest = await receive(Readable.fromWeb(response.body), archive, progress);
      }
      if (digest !== file.sha256) {
        throw new BundleError(`The browser bundle does not match the image's (sha256 ${digest}, expected ${file.sha256}); nothing was installed`);
      }
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await unpack(archive, staging);
      if (!(await exists(join(staging, manifest.binary), constants.X_OK)) || !(await exists(join(staging, manifest.cli)))) {
        throw new BundleError('The browser bundle lacks Chromium or playwright-cli');
      }
      await rm(folder, { recursive: true, force: true });
      await rename(staging, folder);
      log(`Installed the browser bundle ${manifest.version} in ${folder}`);
    } finally {
      await rm(archive, { force: true });
      await rm(staging, { recursive: true, force: true });
      await unlock();
    }
  };

  return {
    version: manifest.version,
    binary,
    cli,
    folder,

    /** Whether this machine's architecture has a build. */
    supported: Boolean(file),

    installed,

    /** What windows and the agent hear of it. */
    async status() {
      if (!file) return { state: 'unsupported' };
      if (installing) return { state: 'installing', received: installing.progress.received, total: installing.progress.total };
      if (await installed()) return { state: 'installed' };
      return { state: 'missing', ...(lastError ? { error: lastError } : {}) };
    },

    /**
     * Installs it if it is not: resolves once it is, or after `waitMs` with
     * `{ installing: true, received, total }` while it goes on in the background.
     * `from`: an archive in the sandbox instead of the download.
     */
    async ensure({ from, waitMs = Infinity } = {}) {
      if (!from && (await installed())) return { installed: true };
      if (from && !(await exists(from))) throw new BundleError(`No such file: ${from}`);
      if (!installing) {
        const progress = { received: 0, total: file?.size ?? 0 };
        const promise = install(from, progress)
          .then(
            () => {
              lastError = undefined;
            },
            (error) => {
              lastError = error.message;
              throw error;
            }
          )
          .finally(() => {
            installing = undefined;
          });
        installing = { promise, progress };
      }
      const { promise, progress } = installing;
      let timer;
      const waited = await Promise.race([
        promise.then(() => 'done'),
        new Promise((resolve) => {
          if (Number.isFinite(waitMs)) timer = setTimeout(() => resolve('waiting'), waitMs);
        })
      ]).finally(() => clearTimeout(timer));
      if (waited === 'done') return { installed: true };
      return { installing: true, received: progress.received, total: progress.total };
    },

    /** How the install goes, for a message: "40 of 114 MB". */
    describeProgress({ received, total }) {
      return total ? `${megabytes(received)} of ${megabytes(total)}` : megabytes(received);
    }
  };
}
