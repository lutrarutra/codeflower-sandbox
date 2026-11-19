import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSearch, fuzzyScore, pathScore, searchFolders } from '../src/search.js';

const t = '2026-11-18T10:00:00.000Z';
const line = (entry) => `${JSON.stringify({ t, ...entry })}\n`;
const prompt = (text, meta) => line({ kind: 'prompt', prompt: [{ type: 'text', text, ...(meta ? { _meta: meta } : {}) }] });
const chunk = (text, messageId = 'm1') => line({ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId } });
const tool = line({ kind: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read umap secret' } });

async function folder(context) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codeflower-search-')));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('fuzzy matching prefers word starts, runs and the file name', () => {
  assert.equal(fuzzyScore('xyz', 'figures/umap.svg'), null);
  assert.equal(fuzzyScore('pmau', 'umap'), null);
  assert.deepEqual(fuzzyScore('umap', 'figures/umap.svg', { positions: true }).positions, [8, 9, 10, 11]);
  // Word starts beat letters in the middle of words.
  assert.ok(fuzzyScore('fu', 'figures/umap.svg'));
  assert.equal(fuzzyScore('fu', 'refunds.csv'), null);
  assert.ok(pathScore('umap', 'figures/umap.svg') > pathScore('umap', 'unused/maps/a.png'));
  // Letters strewn about the text are no match.
  assert.equal(fuzzyScore('fu', 'xfxu'), null);
  assert.ok(pathScore('qc', 'results/qc.html') > pathScore('qc', 'quick/scripts/check.py'));
  // A capital makes case count.
  assert.equal(fuzzyScore('UMAP', 'umap.svg'), null);
  assert.ok(fuzzyScore('umap', 'UMAP.svg'));
  // Spaces separate nothing: they are left out.
  assert.ok(fuzzyScore('fig umap', 'figures/umap.svg'));
});

test('searches file names fuzzily and contents with ripgrep, in the workspace and mounts', async (context) => {
  const workspace = await folder(context);
  const input = await folder(context);
  await mkdir(join(workspace, 'figures'));
  await writeFile(join(workspace, 'figures', 'umap.svg'), '<svg/>');
  await writeFile(join(workspace, 'analysis.py'), 'import scanpy\n# compute the UMAP embedding\nprint("done")\n');
  await writeFile(join(workspace, '.gitignore'), 'ignored/\n');
  await mkdir(join(workspace, 'ignored'));
  await writeFile(join(workspace, 'ignored', 'umap-old.svg'), 'umap');
  await writeFile(join(input, 'umap_counts.tsv'), 'gene\tumap embedding\n');
  const folders = async () => [
    { path: workspace, label: 'Workspace', contents: true },
    { path: input, label: 'Inputs/study', contents: false }
  ];
  const search = createSearch({ folders, sessions: async () => [] });

  const found = await search.paths({ query: 'umap' });
  assert.equal(found.available, true);
  assert.deepEqual(
    found.files.map((file) => [file.folder, file.relative]),
    // Both names start with it: the shorter path first. The ignored folder is left out.
    [
      ['Inputs/study', 'umap_counts.tsv'],
      ['Workspace', 'figures/umap.svg']
    ]
  );
  assert.equal(found.files[1].path, join(workspace, 'figures', 'umap.svg'));

  // Smart case, fixed strings, the inputs' contents left out.
  const lines = await search.contents({ query: 'umap embedding' });
  assert.deepEqual(
    lines.files.map((file) => [file.relative, file.lines.map((hit) => [hit.line, hit.text.slice(hit.start, hit.start + hit.length)])]),
    [['analysis.py', [[2, 'UMAP embedding']]]]
  );
  assert.deepEqual((await search.contents({ query: 'UMAP embedding' })).files.length, 1);
  assert.deepEqual((await search.contents({ query: 'Umap embedding' })).files, []);
  assert.deepEqual((await search.contents({ query: 'x' })).files, []);
});

test('a missing ripgrep is reported, not thrown blindly', async (context) => {
  const workspace = await folder(context);
  const search = createSearch({ folders: async () => [{ path: workspace, label: 'Workspace' }], sessions: async () => [], rg: join(workspace, 'no-rg') });
  await assert.rejects(search.paths({ query: 'a' }), /needs ripgrep/);
  await assert.rejects(search.contents({ query: 'ab' }), /needs ripgrep/);
});

test('a newer search stops the one before', async (context) => {
  const workspace = await folder(context);
  await writeFile(join(workspace, 'a.txt'), 'needle\n');
  const search = createSearch({ folders: async () => [{ path: workspace, label: 'Workspace' }], sessions: async () => [] });
  const controller = new AbortController();
  controller.abort();
  const result = await search.contents({ query: 'needle' }, { signal: controller.signal });
  assert.equal(result.truncated, false);
});

test('searches what chats said across reply chunks, and what they say next', async (context) => {
  const directory = await folder(context);
  const sessions = [
    { key: 'claude-a', title: 'Clustering', harness: 'claude', updatedAt: '2026-11-18T10:00:00Z' },
    { key: 'codex-b', title: 'Plots', harness: 'codex', updatedAt: '2026-11-18T11:00:00Z' }
  ];
  for (const session of sessions) await mkdir(join(directory, session.key));
  await writeFile(
    join(directory, 'claude-a', 'transcript.jsonl'),
    prompt('cluster the cells') + prompt('ls -la', { 'codeflower/shellContext': true }) + chunk('I ran Lei') + chunk('den clustering at resolution 0.8.') + tool + line({ kind: 'turn_end' })
  );
  await writeFile(join(directory, 'codex-b', 'transcript.jsonl'), prompt('plot the leiden clusters on the UMAP') + '{"t":"torn');
  const search = createSearch({ folders: async () => [], sessionsDirectory: directory, sessions: async () => sessions });

  const found = await search.chats({ query: 'leiden' });
  // The latest chat first; a word split over two chunks is found; snippets mark the match.
  assert.deepEqual(
    found.chats.map((chat) => [chat.key, chat.count, chat.places.map((place) => [place.role, place.text.slice(place.start, place.start + place.length)])]),
    [
      ['codex-b', 1, [['user', 'leiden']]],
      ['claude-a', 1, [['agent', 'Leiden']]]
    ]
  );
  assert.equal(found.chats[1].places[0].entry, 2);
  // Tool calls and the user's shell commands are not what the chat said.
  assert.deepEqual((await search.chats({ query: 'secret' })).chats, []);
  assert.deepEqual((await search.chats({ query: 'ls -la' })).chats, []);

  // Appended lines, and the torn one once whole, are read on the next search.
  await appendFile(join(directory, 'codex-b', 'transcript.jsonl'), '","kind":"turn_end"}\n' + prompt('now a heatmap of marker genes'));
  assert.deepEqual((await search.chats({ query: 'heatmap' })).chats.map((chat) => chat.key), ['codex-b']);
  assert.deepEqual((await search.chats({ query: 'leiden' })).chats.map((chat) => chat.count), [1, 1]);
});

test('the inputs are searched by name only', () => {
  assert.deepEqual(
    searchFolders('/codeflower-state/workspace', [
      { target: '/data/input/study42', readOnly: true },
      { target: '/data/output/results', readOnly: false }
    ]),
    [
      { path: '/codeflower-state/workspace', label: 'Workspace', contents: true },
      { path: '/data/input/study42', label: 'Inputs/study42', contents: false },
      { path: '/data/output/results', label: 'Outputs/results', contents: true }
    ]
  );
});
