import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseActionTemplate, readActions } from '../src/actions.js';

const templates = fileURLToPath(new URL('../../../templates/actions/', import.meta.url));

test('reads the ordered chat actions from their templates', async () => {
  const actions = await readActions(templates);
  assert.deepEqual(
    actions.map(({ id, mode }) => [id, mode]),
    [
      ['generate-report', 'queue'],
      ['update-report', 'queue'],
      ['answer-report-comments', 'queue'],
      ['methods', 'queue'],
      ['checkpoint', 'queue'],
      ['update-roots', 'queue'],
      ['reproducible-pipeline', 'queue'],
      ['audit-paper', 'queue'],
      ['wrap-up', 'interrupt']
    ]
  );
  for (const action of actions) {
    assert.ok(action.title);
    assert.ok(action.description);
    assert.ok(action.icon);
    assert.ok(action.prompt);
  }
});

test('reads templates in numeric order and rejects duplicate action ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-actions-'));
  try {
    await mkdir(directory, { recursive: true });
    const template = (title) => `---\ntitle: ${title}\ndescription: Test action\nicon: book\nmode: queue\n---\nDo the work.`;
    await writeFile(join(directory, '20-later.md'), template('Later'));
    await writeFile(join(directory, '02-earlier.md'), template('Earlier'));
    assert.deepEqual((await readActions(directory)).map(({ id }) => id), ['earlier', 'later']);

    await writeFile(join(directory, '30-earlier.md'), template('Duplicate'));
    await assert.rejects(readActions(directory), /Duplicate action id: earlier/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects malformed action metadata', () => {
  assert.throws(() => parseActionTemplate('01-test.md', 'No frontmatter'), /expected frontmatter/);
  assert.throws(
    () => parseActionTemplate('01-test.md', '---\ntitle: Test\n---\nPrompt'),
    /missing frontmatter field: description/
  );
  assert.throws(
    () => parseActionTemplate('01-test.md', '---\ntitle: Test\ndescription: Test\nicon: book\nmode: now\n---\nPrompt'),
    /mode must be/
  );
});

test("an action's .orchestrator.md sibling is the prompt it takes in an orchestrator's chat", async (t) => {
  const actions = await readActions(templates);
  assert.match(actions.find((action) => action.id === 'generate-report').orchestratorPrompt, /review it with the executor/i);
  assert.equal(actions.find((action) => action.id === 'methods').orchestratorPrompt, undefined);
  const directory = await mkdtemp(join(tmpdir(), 'cf-actions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, '01-lonely.orchestrator.md'), 'x');
  await assert.rejects(readActions(directory), /no action 01-lonely\.md/);
});
