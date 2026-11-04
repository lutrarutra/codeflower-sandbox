import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_NAMES, createAgents } from '../src/agents.js';

test('every agent has a logo that windows can show safely', () => {
  const agents = createAgents({ nodePath: process.execPath });
  assert.ok(AGENT_NAMES.length >= 4);
  for (const name of AGENT_NAMES) {
    const { icon, iconMono } = agents[name].presentation;
    assert.match(icon ?? '', /^data:image\/svg\+xml;base64,/, `${name} has an icon`);
    const svg = Buffer.from(icon.slice(icon.indexOf(',') + 1), 'base64').toString('utf8');
    assert.match(svg, /^<svg [^>]*viewBox="0 0 24 24"/, `${name}'s icon is a 24×24 SVG`);
    assert.doesNotMatch(svg, /<script|<foreignObject|\son[a-z]+=|href=|url\((?!#)/i, `${name}'s icon is plain`);
    assert.doesNotMatch(svg, /\s(width|height|style)=/, `${name}'s icon takes its size from the window`);
    // A mono icon draws in currentColor, which windows replace with a mask.
    assert.equal(iconMono === true, /currentColor/.test(svg), `${name}'s mono flag matches its colors`);
  }
});
