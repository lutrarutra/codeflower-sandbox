import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { categoryOf, createLastChoices, newChatSettings, nextChange, offers, settingsOf } from '../src/chat-settings.js';

const select = (id, category, currentValue, values) => ({
  id,
  name: id,
  category,
  type: 'select',
  currentValue,
  options: values.map((value) => ({ value, name: String(value) }))
});

// As Claude's adapter offers them, effort last.
const claude = (model = 'default', effort = 'default') => ({
  configOptions: [
    select('mode', 'mode', 'default', ['default', 'plan', 'bypassPermissions']),
    select('effort', 'thought_level', effort, ['default', 'low', 'medium', 'high']),
    select('model', 'model', model, ['default', 'sonnet', 'haiku']),
    { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false }
  ]
});

test('a chat is brought to its settings mode first, then model, then effort, then the rest', () => {
  const wanted = { options: { effort: 'high', model: 'sonnet', mode: 'plan', fast: true } };
  const tried = new Set();
  const state = claude();
  const order = [];
  for (let change; (change = nextChange(state, wanted, tried)); ) {
    tried.add(change.configId);
    order.push(change.params);
  }
  assert.deepEqual(order, [
    { configId: 'mode', value: 'plan' },
    { configId: 'model', value: 'sonnet' },
    { configId: 'effort', value: 'high' },
    { configId: 'fast', type: 'boolean', value: true }
  ]);
});

test('what the agent has already, or no longer offers, is left alone', () => {
  const state = claude('sonnet', 'high');
  assert.equal(nextChange(state, { options: { model: 'sonnet', effort: 'high' } }), undefined);
  // A model gone, an effort the model does not take, an option the agent no longer has.
  assert.equal(nextChange(state, { options: { model: 'opus-3', effort: 'max', gone: 'x' } }), undefined);
  assert.equal(nextChange(state, undefined), undefined);
  // The agent reports no settings: nothing to compare with.
  assert.equal(nextChange({}, { options: { model: 'sonnet' } }), undefined);
});

test('grouped choices with list values count as offered (dsh)', () => {
  const dsh = {
    id: 'model',
    category: 'model',
    type: 'select',
    currentValue: ['acme', 'large'],
    options: [{ group: 'acme', name: 'Acme', options: [{ value: ['acme', 'large'] }, { value: ['acme', 'small'] }] }]
  };
  assert.equal(offers(dsh, ['acme', 'small']), true);
  assert.equal(offers(dsh, ['other', 'small']), false);
  assert.deepEqual(nextChange({ configOptions: [dsh] }, { options: { model: ['acme', 'small'] } })?.params, {
    configId: 'model',
    value: ['acme', 'small']
  });
  assert.equal(nextChange({ configOptions: [dsh] }, { options: { model: ['acme', 'large'] } }), undefined);
});

test('an agent with only modes keeps and gets back its mode', () => {
  const state = { modes: { currentModeId: 'ask', availableModes: [{ id: 'ask' }, { id: 'code' }] } };
  assert.deepEqual(settingsOf(state), { mode: 'ask' });
  assert.deepEqual(nextChange(state, { mode: 'code' }), { method: 'session/set_mode', configId: 'mode', params: { modeId: 'code' } });
  assert.equal(nextChange(state, { mode: 'gone' }), undefined);
  assert.deepEqual(newChatSettings(state, { mode: 'code', model: 'x' }), { mode: 'code' });
  assert.equal(categoryOf(state, 'session/set_mode', { modeId: 'code' }), 'mode');
});

test('a new chat takes the last choices by category, except those the agent remembers itself', () => {
  const last = { mode: 'plan', model: 'sonnet', thought_level: 'high' };
  assert.deepEqual(newChatSettings(claude(), last), { options: { mode: 'plan', model: 'sonnet', effort: 'high' } });
  assert.deepEqual(newChatSettings(claude(), last, ['model']), { options: { mode: 'plan', effort: 'high' } });
  assert.equal(categoryOf(claude(), 'session/set_config_option', { configId: 'effort' }), 'thought_level');
  assert.equal(categoryOf(claude(), 'session/set_config_option', { configId: 'fast' }), undefined);
  assert.deepEqual(settingsOf(claude('sonnet')), { options: { mode: 'default', effort: 'default', model: 'sonnet', fast: false } });
});

test('the last choices are kept in a file, for mode, model and effort only', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codeflower-chat-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'chat-settings', 'claude.json');
  const choices = await createLastChoices({ file });
  await choices.remember('model', 'sonnet');
  await choices.remember('thought_level', 'high');
  await choices.remember(undefined, true);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { model: 'sonnet', thought_level: 'high' });
  assert.deepEqual((await createLastChoices({ file })).get(), { model: 'sonnet', thought_level: 'high' });
});
