const { contextBridge, ipcRenderer } = require('electron');
const requests = ['bootstrap', 'world:create', 'world:select', 'world:update', 'world:delete', 'world:example', 'companion:save', 'window:compact', 'chat:active', 'chat:dismiss', 'record:add', 'record:edit', 'record:delete', 'record:search', 'fleet:calculate', 'chat:local', 'chat:ask', 'chat:cancel', 'capture:sources', 'capture:start', 'capture:stop', 'capture:gap', 'capture:frame', 'video:import', 'models:list', 'settings:save', 'key:delete', 'world:export'];
requests.push('window:input', 'window:action');
requests.push('experience:create', 'experience:update');
requests.push('record:get');
requests.push('window:regions');
const events = ['capture:stop', 'capture:now', 'chat:focus', 'window:changed', 'window:error', 'data:changed', 'answer:ready', 'analysis:error'];
contextBridge.exposeInMainWorld('companion', {
  call: (name, input) => { if (!requests.includes(name)) throw new Error('허용되지 않은 요청'); return ipcRenderer.invoke(name, input); },
  on: (name, callback) => {
    if (!events.includes(name)) throw new Error('허용되지 않은 이벤트');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  }
});
