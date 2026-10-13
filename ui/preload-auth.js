const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sadeAuth', {
  submit: (credentials) => ipcRenderer.send('auth', credentials),
})
