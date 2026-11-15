// One chat's Chromium: headless, speaking CDP over a pipe only the bridge
// holds (fd 3 in, fd 4 out, one JSON message per NUL). No DevTools port: under
// Apptainer the sandbox shares the node's loopback, where other users could
// reach one and drive the browser with its logins.
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const STDERR_TAIL = 4000;
const STOP_MS = 3000;

/** The flags every chat's Chromium starts with. */
export function chromiumArguments({ profile, proxy, width = 1280, height = 800 }) {
  return [
    '--headless',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    // The sandbox is the isolation: user namespaces, which Chromium's own
    // sandbox needs, are often unavailable inside Apptainer and Docker.
    '--no-sandbox',
    // Containers' /dev/shm is small.
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    // No traffic of Chromium's own (updates, sync, metrics): with an isolated
    // network it would only fill the proxy's refusals.
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--password-store=basic',
    '--mute-audio',
    // Apps served in the sandbox stay off the proxy (`<-loopback>` would do the opposite: send them through it).
    ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=localhost;127.0.0.1;[::1]'] : []),
    'about:blank'
  ];
}

/** The proxy the sandbox's traffic goes through, if any (an isolated network's). */
export function proxyOf(environment) {
  return environment.HTTPS_PROXY || environment.https_proxy || environment.HTTP_PROXY || environment.http_proxy || undefined;
}

/**
 * Starts Chromium on `profile`. Resolves once it runs; `onMessage` gets each
 * CDP message, `onExit` its end (with what it said last on stderr).
 */
export async function launchChromium({ binary, profile, environment = process.env, onMessage, onExit = () => {} }) {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  // A profile last used in another container keeps that host's lock, which
  // makes Chromium refuse it; only this bridge uses the chat's profile.
  await Promise.all(['SingletonLock', 'SingletonSocket', 'SingletonCookie'].map((name) => rm(join(profile, name), { force: true })));
  const child = spawn(binary, chromiumArguments({ profile, proxy: proxyOf(environment) }), {
    env: environment,
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  const toChromium = child.stdio[3];
  const fromChromium = child.stdio[4];
  toChromium.on('error', () => {});
  fromChromium.on('error', () => {});

  let pending = [];
  fromChromium.on('data', (chunk) => {
    let start = 0;
    let end;
    while ((end = chunk.indexOf(0, start)) !== -1) {
      pending.push(chunk.subarray(start, end));
      const text = Buffer.concat(pending).toString('utf8');
      pending = [];
      start = end + 1;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        continue;
      }
      onMessage(message);
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  });

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ error }));
  });
  void exited.then((result) => onExit({ ...result, stderr: stderr.trim() }));

  // Spawning fails at once (no binary); a broken binary exits soon after.
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  return {
    pid: child.pid,
    send(message) {
      if (!toChromium.writable) return false;
      toChromium.write(`${JSON.stringify(message)}\0`);
      return true;
    },
    get running() {
      return child.exitCode === null && child.signalCode === null;
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS);
      await exited;
      clearTimeout(timer);
    }
  };
}
