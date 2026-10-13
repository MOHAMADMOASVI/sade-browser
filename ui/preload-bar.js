const { contextBridge, ipcRenderer } = require('electron')
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action')

// Provides the <browser-action-list> element for extension buttons.
injectBrowserAction()

contextBridge.exposeInMainWorld('sade', {
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, listener) => ipcRenderer.on(channel, (_event, ...args) => listener(...args)),
})
