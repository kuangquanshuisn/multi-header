import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig, STORAGE_KEY } from '../core.js';

test('worker serializes immediate edits, rejects stale windows and recovers after validation errors', async () => {
  let stored = createDefaultConfig();
  let rules = [];
  let listener;
  const extensionId = 'test-extension';
  const onInstalled = [];
  const onStartup = [];
  globalThis.chrome = {
    runtime: {
      id: extensionId,
      onMessage: { addListener(callback) { listener = callback; } },
      onInstalled: { addListener(callback) { onInstalled.push(callback); } },
      onStartup: { addListener(callback) { onStartup.push(callback); } },
    },
    storage: { local: {
      async get() { return { [STORAGE_KEY]: structuredClone(stored) }; },
      async set(data) { stored = structuredClone(data[STORAGE_KEY]); },
    } },
    declarativeNetRequest: {
      async getDynamicRules() { return structuredClone(rules); },
      async updateDynamicRules(update) {
        // Yield to make overlapping message delivery exercise serialization.
        await new Promise(resolve => setTimeout(resolve, 1));
        rules = rules.filter(rule => !update.removeRuleIds.includes(rule.id)).concat(structuredClone(update.addRules));
      },
    },
    action: {
      async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {},
    },
  };
  try {
    await import('../background.js');
    const send = (message, senderId = extensionId) => new Promise(resolve => {
      if (!listener(message, { id: senderId }, resolve)) resolve(null);
    });
    const initial = (await send({ type: 'getConfig' })).config;
    const first = structuredClone(initial);
    first.environments[0].headers.push({ id: 'test', name: 'X-Test', value: 'first', enabled: true });
    const second = structuredClone(first);
    second.environments[0].headers[0].value = 'latest';
    const results = await Promise.all([
      send({ type: 'saveConfig', config: first, editorId: 'popup-a' }),
      send({ type: 'saveConfig', config: second, editorId: 'popup-a' }),
    ]);
    assert.ok(results.every(result => result.ok));
    assert.equal(stored.revision, 2);
    assert.equal(stored.environments[0].headers[0].value, 'latest');
    assert.equal(rules[0].action.requestHeaders[0].value, 'latest');

    const stale = await send({ type: 'saveConfig', config: initial, editorId: 'popup-b' });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /其他窗口/);
    assert.equal(stored.revision, 2);

    const fresh = (await send({ type: 'getConfig' })).config;
    const invalid = structuredClone(fresh);
    invalid.environments[0].headers[0].value = 'bad\r\nInjected: true';
    assert.equal((await send({ type: 'saveConfig', config: invalid, editorId: 'popup-b' })).ok, false);
    fresh.enabled = false;
    assert.equal((await send({ type: 'saveConfig', config: fresh, editorId: 'popup-b' })).ok, true);
    assert.deepEqual(rules, []);
    assert.equal(stored.revision, 3);

    assert.equal(await send({ type: 'saveConfig', config: fresh, editorId: 'popup-c' }, 'untrusted'), null);
    assert.equal(await send({ type: 'unknown' }), null);
    assert.equal((await send({ type: 'saveConfig', config: stored })).ok, false);
    assert.equal(onInstalled.length, 1);
    assert.equal(onStartup.length, 1);
  } finally {
    delete globalThis.chrome;
  }
});
