import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSessionInfo, modelName } from '../src/session-info.js';

const claudeModels = {
  id: 'model',
  category: 'model',
  type: 'select',
  currentValue: 'default',
  options: [
    {
      value: 'default',
      name: 'Default (recommended)',
      description: 'Opus 5.5'
    },
    { value: 'sonnet', name: 'Sonnet 5.5' }
  ]
};

test('the model is named as the agent offers it', () => {
  assert.equal(modelName({ configOptions: [claudeModels] }), 'Opus 5.5');
  assert.equal(modelName({ configOptions: [{ ...claudeModels, currentValue: 'sonnet' }] }), 'Sonnet 5.5');
  // dsh groups models by provider, with [provider, model] values.
  const dsh = {
    category: 'model',
    currentValue: ['deepseek', 'deepseek-v4'],
    options: [
      {
        group: 'deepseek',
        options: [{ value: ['deepseek', 'deepseek-v4'], name: 'DeepSeek V4' }]
      }
    ]
  };
  assert.equal(modelName({ configOptions: [dsh] }), 'DeepSeek V4');
  assert.equal(
    modelName({
      configOptions: [{ category: 'model', currentValue: ['x', 'y'], options: [] }]
    }),
    'y'
  );
  assert.equal(
    modelName({
      models: {
        currentModelId: 'gpt-6',
        availableModels: [{ modelId: 'gpt-6', name: 'GPT-6' }]
      }
    }),
    'GPT-6'
  );
  assert.equal(modelName({ configOptions: [] }), undefined);
});

test('each session has a file with its agent, model and whether a turn runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-info-'));
  const info = createSessionInfo({ directory, agent: 'Claude Code' });
  info.reported({ title: 'Claude Agent' });
  info.settings('s1', { configOptions: [claudeModels] });
  info.turn('s1', true);
  info.settings('../escape', { configOptions: [claudeModels] });
  await info.flush();
  assert.deepEqual(await readdir(directory), ['s1.json']);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 's1.json'), 'utf8')), {
    agent: 'Claude Code',
    model: 'Opus 5.5',
    turn: true
  });
  info.turn('s1', false);
  await info.flush();
  assert.equal(JSON.parse(await readFile(join(directory, 's1.json'), 'utf8')).turn, false);
});

test('the agent falls back to the name it reports, and no directory writes nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-info-'));
  const info = createSessionInfo({ directory });
  info.reported({ name: 'dsh' });
  info.turn('s', true);
  await info.flush();
  assert.equal(JSON.parse(await readFile(join(directory, 's.json'), 'utf8')).agent, 'dsh');
  const none = createSessionInfo({});
  none.turn('s', true);
  await none.flush();
});
