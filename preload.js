const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cy', {
  init: () => ipcRenderer.invoke('init'),
  addTodo: (t) => ipcRenderer.invoke('todo:add', t),
  patchTodo: (id, changes) => ipcRenderer.invoke('todo:patch', id, changes),
  removeTodo: (id) => ipcRenderer.invoke('todo:remove', id),
  moveTodo: (id, index) => ipcRenderer.invoke('todo:move', id, index),
  refresh: () => ipcRenderer.invoke('refresh'),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
  openSession: (id) => ipcRenderer.invoke('open:session', id),
  openFolder: (dir) => ipcRenderer.invoke('open:folder', dir),
  openClaude: (dir) => ipcRenderer.invoke('open:claude', dir),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  openAgent: (a) => ipcRenderer.invoke('open:agent', a),
  focusStart: (f) => ipcRenderer.invoke('focus:start', f),
  focusStop: () => ipcRenderer.invoke('focus:stop'),
  buildBrief: (alerts) => ipcRenderer.invoke('brief:build', alerts),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getLogin: () => ipcRenderer.invoke('login:get'),
  setLogin: (on) => ipcRenderer.invoke('login:set', on),
  saveConfig: (c) => ipcRenderer.invoke('config:save', c),
  testServer: (s) => ipcRenderer.invoke('config:test-server', s),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  pickKey: () => ipcRenderer.invoke('dialog:key'),
  notify: (n) => ipcRenderer.invoke('notify', n),
  on: (channel, fn) => {
    if (['status', 'todos', 'config', 'theme', 'cursor', 'covered', 'audio', 'sing', 'agents', 'vitals', 'focus'].includes(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  }
});
