export const STORAGE_KEY = 'multiHeaderConfig';
export const RULE_ID = 1;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const INVALID_VALUE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export function createEnvironment(name = '新环境') {
  return { id: crypto.randomUUID(), name, headers: [] };
}

export function createDefaultConfig() {
  const environment = createEnvironment('开发环境');
  return { version: 1, revision: 0, enabled: true, activeEnvironmentId: environment.id, environments: [environment] };
}

export function validateConfig(input) {
  if (!input || input.version !== 1 || typeof input.enabled !== 'boolean' || !Array.isArray(input.environments) || !input.environments.length) {
    throw new Error('至少需要保留一个环境。');
  }
  if (input.environments.length > 50) throw new Error('最多支持 50 个环境。');
  const ids = new Set();
  const names = new Set();
  const environments = input.environments.map(environment => {
    if (!environment || typeof environment.id !== 'string' || !environment.id || ids.has(environment.id)) throw new Error('环境标识无效，请重新加载。');
    ids.add(environment.id);
    const name = typeof environment.name === 'string' ? environment.name.trim() : '';
    if (!name || name.length > 40) throw new Error('环境名称需为 1–40 个字符。');
    if (names.has(name)) throw new Error(`环境名称「${name}」重复。`);
    names.add(name);
    if (!Array.isArray(environment.headers) || environment.headers.length > 100) throw new Error(`「${name}」最多支持 100 条请求头。`);
    const keys = new Set();
    const rowIds = new Set();
    const headers = environment.headers.map(header => {
      if (!header || typeof header.id !== 'string' || !header.id || rowIds.has(header.id) || typeof header.name !== 'string' || typeof header.value !== 'string' || typeof header.enabled !== 'boolean') {
        throw new Error(`「${name}」的请求头格式无效。`);
      }
      rowIds.add(header.id);
      const key = header.name.trim();
      if (!key && header.value) throw new Error(`「${name}」中填写了 Value 的请求头还需要填写 Key。`);
      if (key && !HEADER_NAME.test(key)) throw new Error(`请求头「${key}」格式无效：Key 只能包含英文字母、数字和 HTTP 允许的符号。`);
      if (INVALID_VALUE.test(header.value)) throw new Error(`请求头「${key}」的 Value 不能包含换行或控制字符。`);
      if (key && keys.has(key.toLowerCase())) throw new Error(`「${name}」存在重复的请求头「${key}」，Key 不区分大小写。`);
      if (key) keys.add(key.toLowerCase());
      return { id: header.id, name: key, value: header.value, enabled: header.enabled };
    });
    return { id: environment.id, name, headers };
  });
  if (!ids.has(input.activeEnvironmentId)) throw new Error('请选择一个有效环境。');
  return {
    version: 1,
    revision: Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
    enabled: input.enabled,
    activeEnvironmentId: input.activeEnvironmentId,
    environments,
  };
}

export function buildRules(config) {
  const validated = validateConfig(config);
  if (!validated.enabled) return [];
  const environment = validated.environments.find(item => item.id === validated.activeEnvironmentId);
  const requestHeaders = environment.headers.filter(header => header.enabled && header.name).map(header => ({
    header: header.name,
    operation: 'set',
    value: header.value,
  }));
  if (!requestHeaders.length) return [];
  return [{
    id: RULE_ID,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders },
    // Chromium omits main_frame navigations unless explicitly included.
    condition: {
      regexFilter: '^https?://',
      resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'],
    },
  }];
}

// The worker serializes callers; update rules before reporting a configuration as saved.
export async function commitConfig(api, input, current) {
  const config = validateConfig(input);
  if (config.revision !== current.revision) throw new Error('配置已在其他窗口更新，请点击「重新加载」后再编辑。');
  config.revision = current.revision + 1;
  const oldRules = await api.declarativeNetRequest.getDynamicRules();
  await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldRules.map(rule => rule.id), addRules: buildRules(config) });
  try {
    await api.storage.local.set({ [STORAGE_KEY]: config });
  } catch (error) {
    const applied = await api.declarativeNetRequest.getDynamicRules();
    await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: applied.map(rule => rule.id), addRules: oldRules });
    throw error;
  }
  return config;
}
