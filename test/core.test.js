import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRules, commitConfig, createDefaultConfig, createEnvironment, STORAGE_KEY } from '../core.js';

function fixture() {
  const config = createDefaultConfig();
  config.environments[0].headers = [
    { id: 'tenant', name: 'X-Tenant-Id', value: '10001', enabled: true },
    { id: 'auth', name: 'Authorization', value: 'Bearer test-token', enabled: true },
    { id: 'ignored', name: 'X-Ignored', value: 'hidden', enabled: false },
    { id: 'blank', name: '', value: '', enabled: true },
  ];
  return config;
}

test('default configuration has exactly one active environment and no modifying rules', () => {
  const config = createDefaultConfig();
  assert.equal(config.environments.length, 1);
  assert.equal(config.activeEnvironmentId, config.environments[0].id);
  assert.deepEqual(buildRules(config), []);
});

test('set operations add or overwrite multiple headers for all HTTP and HTTPS resource types', () => {
  const [rule] = buildRules(fixture());
  assert.equal(rule.action.type, 'modifyHeaders');
  assert.deepEqual(rule.action.requestHeaders, [
    { header: 'X-Tenant-Id', operation: 'set', value: '10001' },
    { header: 'Authorization', operation: 'set', value: 'Bearer test-token' },
  ]);
  assert.equal(rule.condition.regexFilter, '^https?://');
  for (const type of ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'xmlhttprequest', 'media', 'other']) assert.ok(rule.condition.resourceTypes.includes(type));
  const pattern = new RegExp(rule.condition.regexFilter);
  for (const url of ['http://localhost:3000/api', 'https://example.com/', 'https://cdn.example.com/app.js']) assert.ok(pattern.test(url));
  for (const url of ['chrome://extensions/', 'file:///tmp/a', 'wss://example.com', 'httpsx://example.com']) assert.equal(pattern.test(url), false);
});

test('switching environments replaces the entire set; disabling generates no rules', () => {
  const config = fixture();
  const production = createEnvironment('生产环境');
  production.headers.push({ id: 'prod', name: 'X-Environment', value: 'production', enabled: true });
  config.environments.push(production);
  config.activeEnvironmentId = production.id;
  assert.deepEqual(buildRules(config)[0].action.requestHeaders, [{ header: 'X-Environment', value: 'production', operation: 'set' }]);
  config.enabled = false;
  assert.deepEqual(buildRules(config), []);
});

test('header names are trimmed, case-insensitive duplicates are rejected, and values may be empty', () => {
  const config = fixture();
  config.environments[0].headers[0].name = ' X-Tenant-Id ';
  config.environments[0].headers[0].value = '';
  assert.deepEqual(buildRules(config)[0].action.requestHeaders[0], { header: 'X-Tenant-Id', operation: 'set', value: '' });
  config.environments[0].headers.push({ id: 'duplicate', name: 'x-tenant-ID', value: '2', enabled: true });
  assert.throws(() => buildRules(config), /重复/);
});

test('invalid names and CRLF/control character injection are rejected before applying', () => {
  for (const name of ['Bad Header', ':authority', 'X-A\nX-B', '中文']) {
    const config = fixture();
    config.environments[0].headers[0].name = name;
    assert.throws(() => buildRules(config), /格式无效/);
  }
  for (const value of ['value\r\nX-Injected: yes', '\0', '\x1f', '\x7f']) {
    const config = fixture();
    config.environments[0].headers[0].value = value;
    assert.throws(() => buildRules(config), /控制字符/);
  }
  const config = fixture();
  config.environments[0].headers[0].name = '';
  assert.throws(() => buildRules(config), /填写 Key/);
});

test('invalid selections, duplicate environment names and deleting the final environment are rejected', () => {
  const config = fixture();
  config.activeEnvironmentId = 'missing';
  assert.throws(() => buildRules(config), /有效环境/);
  config.activeEnvironmentId = config.environments[0].id;
  config.environments.push(createEnvironment(config.environments[0].name));
  assert.throws(() => buildRules(config), /名称.*重复/);
  config.environments = [];
  assert.throws(() => buildRules(config), /至少/);
});

function mockApi(initialRules, { rulesFail = false, storageFail = false } = {}) {
  let rules = structuredClone(initialRules);
  let stored;
  const calls = [];
  return {
    get rules() { return rules; },
    get stored() { return stored; },
    calls,
    declarativeNetRequest: {
      async getDynamicRules() { return structuredClone(rules); },
      async updateDynamicRules(update) {
        calls.push(update);
        if (rulesFail) throw new Error('Chrome rejected header');
        rules = rules.filter(rule => !update.removeRuleIds.includes(rule.id)).concat(update.addRules);
      },
    },
    storage: { local: { async set(data) {
      if (storageFail) throw new Error('Storage failed');
      stored = structuredClone(data);
    } } },
  };
}

test('saving atomically replaces rules, advances revision and persists config', async () => {
  const config = fixture();
  const api = mockApi([{ id: 99 }]);
  const saved = await commitConfig(api, config, config);
  assert.equal(saved.revision, 1);
  assert.equal(config.revision, 0);
  assert.deepEqual(api.rules, buildRules(saved));
  assert.deepEqual(api.stored, { [STORAGE_KEY]: saved });
  assert.deepEqual(api.calls[0].removeRuleIds, [99]);
  const paused = { ...saved, enabled: false };
  await commitConfig(api, paused, saved);
  assert.deepEqual(api.rules, []);
});

test('stale editor revisions never overwrite newer config', async () => {
  const config = fixture();
  const api = mockApi([]);
  await assert.rejects(commitConfig(api, config, { ...config, revision: 1 }), /其他窗口/);
  assert.deepEqual(api.calls, []);
});

test('Chrome rule failures leave stored config and previous rules untouched', async () => {
  const config = fixture();
  const previous = buildRules(config);
  const api = mockApi(previous, { rulesFail: true });
  await assert.rejects(commitConfig(api, { ...config, enabled: false }, config), /Chrome rejected/);
  assert.deepEqual(api.rules, previous);
  assert.equal(api.stored, undefined);
});

test('storage failure restores the previously active rules', async () => {
  const config = fixture();
  const previous = buildRules(config);
  const api = mockApi(previous, { storageFail: true });
  await assert.rejects(commitConfig(api, { ...config, enabled: false }, config), /Storage failed/);
  assert.equal(api.calls.length, 2);
  assert.deepEqual(api.rules, previous);
  assert.equal(api.stored, undefined);
});
