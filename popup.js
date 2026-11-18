import { createEnvironment, validateConfig } from './core.js';

const $ = id => document.getElementById(id);
const editorId = crypto.randomUUID();
let config;
let sequence = 0;
let pending = 0;
let dialogMode = 'add';
let dialogEnvironmentId;

function currentEnvironment() {
  return config.environments.find(environment => environment.id === config.activeEnvironmentId);
}

function setStatus(text, kind = 'saved', error = '') {
  $('save-status').textContent = text;
  $('status-dot').className = `status-dot ${kind}`;
  $('feedback').textContent = error;
  $('feedback').hidden = !error;
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '无法连接插件，请到扩展管理页重新加载插件。');
  return response.config;
}

function savedStatus() {
  const count = currentEnvironment().headers.filter(header => header.enabled && header.name.trim()).length;
  setStatus(config.enabled ? `已自动保存 · ${count} 条请求头生效` : '已自动保存 · 请求头修改已暂停');
}

// No debounce: every valid edit reaches the service worker before the popup closes.
async function persist() {
  const edit = ++sequence;
  let snapshot;
  try {
    snapshot = validateConfig(config);
  } catch (error) {
    setStatus('尚未保存 · 请检查配置', 'error', `${error.message} 本次修改尚未生效，浏览器继续使用上次保存的配置。`);
    return false;
  }
  pending += 1;
  setStatus('正在保存并应用…', 'pending');
  try {
    const saved = await request({ type: 'saveConfig', config: snapshot, editorId });
    config.revision = Math.max(config.revision, saved.revision);
    if (edit === sequence) savedStatus();
    return true;
  } catch (error) {
    if (edit === sequence) setStatus('保存失败 · 本次修改未生效', 'error', `${error.message} 可修正后重试，或点击「重新加载」恢复已保存配置。`);
    return false;
  } finally {
    pending -= 1;
  }
}

function makeButton(className, label, title) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  if (title) {
    button.title = title;
    button.setAttribute('aria-label', title);
  }
  return button;
}

function renderEnvironments() {
  $('environment-count').textContent = String(config.environments.length).padStart(2, '0');
  const items = config.environments.map(environment => {
    const active = environment.id === config.activeEnvironmentId;
    const button = makeButton(`environment-item${active ? ' active' : ''}`, '', `切换到${environment.name}`);
    button.setAttribute('aria-current', String(active));
    const dot = document.createElement('span');
    dot.className = 'environment-dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'environment-name';
    name.textContent = environment.name;
    button.append(dot, name);
    if (active) {
      const mark = document.createElement('span');
      mark.className = 'active-mark';
      mark.textContent = '✓';
      button.append(mark);
    }
    button.addEventListener('click', () => {
      if (active) return;
      config.activeEnvironmentId = environment.id;
      render();
      void persist();
    });
    return button;
  });
  $('environment-list').replaceChildren(...items);
}

function updateHeaderCount() {
  $('header-count').textContent = String(currentEnvironment().headers.filter(header => header.name.trim()).length);
}

function renderHeaders() {
  const environment = currentEnvironment();
  $('add-header').disabled = environment.headers.length >= 100;
  updateHeaderCount();
  if (!environment.headers.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.textContent = '{ : }';
    icon.setAttribute('aria-hidden', 'true');
    const heading = document.createElement('strong');
    heading.textContent = '从第一条请求头开始';
    const detail = document.createElement('p');
    detail.textContent = '添加 Key 和 Value，为当前环境配置请求参数';
    empty.append(icon, heading, detail);
    $('header-list').replaceChildren(empty);
    return;
  }
  const rows = environment.headers.map(header => {
    const row = document.createElement('div');
    row.className = `header-row${header.enabled ? '' : ' disabled'}`;
    row.dataset.id = header.id;
    const toggle = makeButton('switch row-switch', '', `启用请求头 ${header.name || '未命名'}`);
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(header.enabled));
    toggle.append(document.createElement('span'));
    toggle.addEventListener('click', () => {
      header.enabled = !header.enabled;
      toggle.setAttribute('aria-checked', String(header.enabled));
      row.classList.toggle('disabled', !header.enabled);
      void persist();
    });
    const key = document.createElement('input');
    key.type = 'text';
    key.placeholder = '例如 X-Environment';
    key.value = header.name;
    key.setAttribute('aria-label', '请求头 Key');
    key.spellcheck = false;
    key.autocomplete = 'off';
    key.addEventListener('input', () => {
      header.name = key.value;
      toggle.setAttribute('aria-label', `启用请求头 ${header.name || '未命名'}`);
      updateHeaderCount();
      void persist();
    });
    const value = document.createElement('input');
    value.type = 'text';
    value.placeholder = '例如 development';
    value.value = header.value;
    value.setAttribute('aria-label', '请求头 Value');
    value.spellcheck = false;
    value.autocomplete = 'off';
    value.addEventListener('input', () => { header.value = value.value; void persist(); });
    const remove = makeButton('delete-header', '×', '删除这条请求头');
    remove.addEventListener('click', () => {
      environment.headers = environment.headers.filter(item => item.id !== header.id);
      renderHeaders();
      void persist();
    });
    row.append(toggle, key, value, remove);
    return row;
  });
  $('header-list').replaceChildren(...rows);
}

function render() {
  document.body.classList.toggle('paused', !config.enabled);
  $('master-toggle').setAttribute('aria-checked', String(config.enabled));
  $('master-label').textContent = config.enabled ? '已启用' : '已暂停';
  $('environment-title').textContent = currentEnvironment().name;
  $('delete-environment').disabled = config.environments.length <= 1;
  $('delete-environment').title = config.environments.length <= 1 ? '至少需要保留一个环境' : '删除环境';
  const atEnvironmentLimit = config.environments.length >= 50;
  $('add-environment').disabled = atEnvironmentLimit;
  $('copy-environment').disabled = atEnvironmentLimit;
  $('copy-environment').title = atEnvironmentLimit ? '最多支持 50 个环境' : '复制环境';
  $('add-header').disabled = currentEnvironment().headers.length >= 100;
  renderEnvironments();
  renderHeaders();
}

function openEnvironmentDialog(mode) {
  const environment = currentEnvironment();
  const dialogs = {
    add: { title: '添加环境', confirm: '添加环境', description: '为这组请求头设置一个好记的名字。' },
    copy: { title: '复制环境', confirm: '确认复制', description: `将「${environment.name}」的全部请求头复制到新环境，请输入新环境名称。` },
    rename: { title: '重命名环境', confirm: '保存名称', description: '为这组请求头设置一个好记的名字。' },
    delete: { title: '删除环境', confirm: '确认删除', description: `确定删除「${environment.name}」及其全部请求头？删除后将切换到另一个环境。` },
  };
  const { title, confirm, description } = dialogs[mode];
  dialogMode = mode;
  dialogEnvironmentId = environment.id;
  const deleting = mode === 'delete';
  $('dialog-title').textContent = title;
  $('dialog-description').textContent = description;
  $('environment-name').hidden = deleting;
  $('environment-name').required = !deleting;
  document.querySelector('label[for="environment-name"]').hidden = deleting;
  $('environment-name').value = mode === 'rename' ? environment.name : '';
  $('dialog-confirm').textContent = confirm;
  $('dialog-confirm').className = `button ${deleting ? 'destructive' : 'primary'}`;
  $('dialog-error').textContent = '';
  $('environment-dialog').showModal();
  if (!deleting) $('environment-name').focus();
}

$('master-toggle').addEventListener('click', () => {
  config.enabled = !config.enabled;
  render();
  void persist();
});
$('add-header').addEventListener('click', () => {
  if (currentEnvironment().headers.length >= 100) return;
  currentEnvironment().headers.push({ id: crypto.randomUUID(), name: '', value: '', enabled: true });
  render();
  $('header-list').lastElementChild.querySelector('input').focus();
  void persist();
});
$('add-environment').addEventListener('click', () => openEnvironmentDialog('add'));
$('copy-environment').addEventListener('click', () => openEnvironmentDialog('copy'));
$('rename-environment').addEventListener('click', () => openEnvironmentDialog('rename'));
$('delete-environment').addEventListener('click', () => openEnvironmentDialog('delete'));
$('dialog-cancel').addEventListener('click', () => $('environment-dialog').close());
$('environment-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('environment-name').value.trim();
  if (dialogMode !== 'delete') {
    if (!name) { $('dialog-error').textContent = '请输入环境名称。'; return; }
    if (config.environments.some(environment => environment.name === name && (dialogMode !== 'rename' || environment.id !== dialogEnvironmentId))) {
      $('dialog-error').textContent = '环境名称已存在，请换一个名称。';
      return;
    }
  }
  if (dialogMode === 'add' || dialogMode === 'copy') {
    if (config.environments.length >= 50) return;
    const environment = createEnvironment(name);
    if (dialogMode === 'copy') {
      const source = config.environments.find(item => item.id === dialogEnvironmentId);
      environment.headers = source.headers.map(header => ({ ...header, id: crypto.randomUUID() }));
    }
    config.environments.push(environment);
    config.activeEnvironmentId = environment.id;
  } else if (dialogMode === 'rename') {
    config.environments.find(environment => environment.id === dialogEnvironmentId).name = name;
  } else {
    if (config.environments.length <= 1) return;
    config.environments = config.environments.filter(environment => environment.id !== dialogEnvironmentId);
    config.activeEnvironmentId = config.environments[0].id;
  }
  $('environment-dialog').close();
  render();
  void persist();
});
$('open-options').addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
$('reload').addEventListener('click', () => { if (!pending) void load(); });

async function load() {
  document.body.classList.add('loading');
  try {
    config = validateConfig(await request({ type: 'getConfig' }));
    sequence += 1;
    for (const id of ['master-toggle', 'add-environment', 'add-header', 'rename-environment', 'delete-environment']) $(id).disabled = false;
    render();
    savedStatus();
  } catch (error) {
    setStatus('加载失败', 'error', error.message);
  } finally {
    document.body.classList.remove('loading');
  }
}

void load();
