import { STORAGE_KEY, buildRules, commitConfig, createDefaultConfig, validateConfig } from './core.js';

let queue = Promise.resolve();
let lastEditorId = null;
function enqueue(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

async function readConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (stored[STORAGE_KEY]) return validateConfig(stored[STORAGE_KEY]);
  const config = createDefaultConfig();
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
  return config;
}

async function updateBadge(config) {
  const rules = buildRules(config);
  const count = rules[0]?.action.requestHeaders.length ?? 0;
  const environment = config.environments.find(item => item.id === config.activeEnvironmentId);
  await Promise.all([
    chrome.action.setBadgeText({ text: config.enabled ? (count ? String(count) : '') : 'OFF' }),
    chrome.action.setBadgeBackgroundColor({ color: config.enabled ? '#6655e8' : '#89909e' }),
    chrome.action.setTitle({ title: config.enabled ? `Multi Header · ${environment.name} · ${count} 条请求头` : 'Multi Header · 已暂停' }),
  ]);
}

async function initialize() {
  const config = await readConfig();
  const previous = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: previous.map(rule => rule.id), addRules: buildRules(config) });
  await updateBadge(config);
}

chrome.runtime.onInstalled.addListener(() => { enqueue(initialize).catch(console.error); });
chrome.runtime.onStartup.addListener(() => { enqueue(initialize).catch(console.error); });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !['getConfig', 'saveConfig'].includes(message?.type)) return false;
  enqueue(async () => {
    const current = await readConfig();
    if (message.type === 'getConfig') return current;
    if (typeof message.editorId !== 'string' || !message.editorId || message.editorId.length > 100) throw new Error('编辑会话无效，请重新加载。');
    // Each keystroke is sent immediately, so closing the popup cannot discard a
    // pending debounce. Queued snapshots from the same editor share a revision.
    const input = message.editorId === lastEditorId ? { ...message.config, revision: current.revision } : message.config;
    const config = await commitConfig(chrome, input, current);
    lastEditorId = message.editorId;
    // A cosmetic badge failure must not misreport a successful storage/rules commit.
    await updateBadge(config).catch(console.error);
    return config;
  }).then(config => respond({ ok: true, config }), error => respond({ ok: false, error: error.message || String(error) }));
  return true;
});
