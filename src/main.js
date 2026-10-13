const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, Menu, ipcMain, nativeTheme, session, shell, dialog, net, protocol } = require('electron')
const { ElectronChromeExtensions } = require('electron-chrome-extensions')
const { installChromeWebStore, uninstallExtension } = require('electron-chrome-web-store')

if (process.env.SADE_PROFILE) {
  // A throwaway profile also gets its own Keychain item, apart from the real one.
  app.setName('Sade Dev')
  app.setPath('userData', process.env.SADE_PROFILE)
}

const data = require('./data')
const importers = require('./importers')
const { t, LANGUAGES } = require('./i18n')
const passwords = require('./passwords')
const weather = require('./weather')
const { BrowserWin, UI, WEB_STORE } = require('./window')

// sade:// serves the built-in pages (library, error page).
protocol.registerSchemesAsPrivileged([{ scheme: 'sade', privileges: { standard: true, secure: true } }])

const cur = () => BrowserWin.current
const wc = () => cur()?.active()?.view.webContents

// URLs handed to us by macOS before the app is ready (default-browser clicks).
const pendingUrls = []
function openExternal(url) {
  if (!/^(https?|file):/i.test(url)) return
  if (app.isReady() && BrowserWin.extensions) BrowserWin.open(url)
  else pendingUrls.push(url)
}
app.on('open-url', (event, url) => {
  event.preventDefault()
  openExternal(url)
})
app.on('open-file', (event, file) => {
  event.preventDefault()
  openExternal(pathToFileURL(file).toString())
})

const isFirstInstance = app.requestSingleInstanceLock()
if (!isFirstInstance) app.quit()
app.on('second-instance', (_e, argv) => {
  const urls = argv.slice(1).filter((arg) => /^https?:\/\//i.test(arg))
  if (urls.length) urls.forEach(openExternal)
  else if (cur()) cur().win.show()
  else new BrowserWin({ restore: true })
})

// ----------------------------------------------------------- session set-up

// Permissions worth asking about, with the "{site} wants to use {this}" sentence for each.
const ASK = {
  media: () => t('{0} wants to use your camera or microphone'),
  geolocation: () => t('{0} wants to use your location'),
  notifications: () => t('{0} wants to send you notifications'),
  'clipboard-read': () => t('{0} wants to read your clipboard'),
  midi: () => t('{0} wants to use MIDI devices'),
  midiSysex: () => t('{0} wants to use MIDI devices'),
}
const QUIET = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'window-management'])

function setupSession(ses, isPrivate) {
  ses.protocol.handle('sade', (request) => {
    const file = path.normalize(path.join(UI, decodeURIComponent(new URL(request.url).pathname)))
    if (!file.startsWith(UI + path.sep)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })

  ses.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads')
    const { name: stem, ext } = path.parse(item.getFilename())
    let target = path.join(dir, stem + ext)
    for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${stem} ${i}${ext}`)
    item.setSavePath(target)

    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: path.basename(target),
      path: target,
      url: item.getURL(),
      total: item.getTotalBytes(),
      received: 0,
      state: 'progress',
      time: Date.now(),
    }
    // Private downloads show in the bar but are left out of the downloads list.
    if (!isPrivate) data.addDownload(entry)
    const update = () => {
      entry.total = item.getTotalBytes()
      entry.received = item.getReceivedBytes()
      BrowserWin.download = {
        name: entry.name,
        path: entry.path,
        done: entry.state === 'done',
        progress: entry.total ? entry.received / entry.total : 0,
      }
      if (!isPrivate) data.touchDownloads()
      BrowserWin.refreshAll()
    }
    update()
    item.on('updated', update)
    item.once('done', (_e2, state) => {
      entry.state = state === 'completed' ? 'done' : 'failed'
      update()
      if (entry.state === 'done') app.dock?.downloadFinished(target)
      else {
        BrowserWin.download = null
        BrowserWin.refreshAll()
      }
    })
  })

  const remembered = isPrivate ? {} : null // private answers last only as long as the window
  ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const owner = BrowserWin.from(contents)
    if (!owner?.byWc(contents)) return callback(true) // Sade's own UI and extension pages
    if (QUIET.has(permission)) return callback(true)
    if (!ASK[permission]) return callback(false)
    let origin
    try {
      origin = new URL(details.requestingUrl || contents.getURL()).origin
    } catch {
      return callback(false)
    }
    const answers = remembered || data.stores.perms.data
    const key = `${origin}|${permission}`
    if (key in answers) return callback(answers[key])
    const { response } = await dialog.showMessageBox(owner.win, {
      message: ASK[permission]().replace('{0}', new URL(origin).host),
      buttons: [t('Allow'), t('Don’t Allow')],
      cancelId: 1,
    })
    answers[key] = response === 0
    if (!remembered) {
      data.stores.perms.save()
      data.changed()
    }
    callback(response === 0)
  })
}

// --------------------------------------------------------------------- auth

// Sites that use the browser's own sign-in prompt (HTTP Basic/Digest, proxies).
app.on('login', (event, contents, _details, authInfo, callback) => {
  const owner = contents && BrowserWin.from(contents)
  if (!owner) return
  event.preventDefault()
  const prompt = new BrowserWindow({
    parent: owner.win,
    modal: true,
    width: 380,
    height: 232,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: { preload: path.join(UI, 'preload-auth.js'), sandbox: true, contextIsolation: true },
  })
  let answered = false
  prompt.webContents.ipc.once('auth', (_e, credentials) => {
    answered = true
    if (credentials) callback(String(credentials.username), String(credentials.password))
    else callback()
    prompt.close()
  })
  prompt.on('closed', () => !answered && callback())
  prompt.once('ready-to-show', () => prompt.show())
  prompt.loadFile(path.join(UI, 'auth.html'), {
    query: {
      host: authInfo.host,
      realm: authInfo.realm || '',
      proxy: authInfo.isProxy ? '1' : '',
      lang: data.stores.settings.data.language,
    },
  })
})

// ------------------------------------------------------------------ actions

async function importFrom(key, label) {
  const parent = cur()?.win
  try {
    const result = await importers[key]()
    const added = data.mergeImport(result)
    dialog.showMessageBox(parent, {
      message: t('Imported from {0}', label),
      detail:
        t('{0} new bookmarks and {1} history entries.', added, result.history.length) +
        '\n\n' +
        t('To bring your passwords too, use Import on the Passwords page.'),
    })
  } catch (err) {
    const denied = err.code === 'EPERM' || err.code === 'EACCES' || /authorization denied|not permitted/i.test(err.message)
    if (denied) {
      const { response } = await dialog.showMessageBox(parent, {
        type: 'warning',
        message: t('Sade can’t read {0}’s data', label),
        detail: t('macOS protects this folder. Give Sade “Full Disk Access” in System Settings, then quit, reopen and try again.'),
        buttons: [t('Open System Settings'), t('Cancel')],
      })
      if (response === 0) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
    } else {
      dialog.showMessageBox(parent, {
        type: 'warning',
        message: t('Couldn’t import from {0}', label),
        detail: err.code === 'ENOENT' ? t('{0} data was not found on this Mac.', label) : err.message,
      })
    }
  }
}

async function clearHistory() {
  const { response } = await dialog.showMessageBox(cur()?.win, {
    type: 'warning',
    message: t('Clear all history?'),
    buttons: [t('Clear'), t('Cancel')],
  })
  if (response === 0) data.clearHistory()
}

function makeDefaultBrowser() {
  if (!app.isPackaged) {
    return dialog.showMessageBox(cur()?.win, {
      message: t('Only the built app can be the default browser'),
      detail: t('Build Sade.app (see build.command), open that copy, and choose this menu item again.'),
    })
  }
  // macOS shows its own confirmation for http; https follows it.
  app.setAsDefaultProtocolClient('http')
  app.setAsDefaultProtocolClient('https')
}

const newTab = (url) => (cur() ? cur().createTab(url) : new BrowserWin(url ? { urls: [url] } : { restore: true }))
const library = (section) => () => {
  if (!cur()) new BrowserWin({ urls: [`sade://app/library.html#${section}`] })
  else cur().openLibrary(section)
}

BrowserWin.commands = [
  { title: 'Dashboard', run: (w) => w.openDashboard() },
  { title: 'Settings', run: library('settings') },
  { title: 'Passwords', run: library('passwords') },
  { title: 'Bookmarks', run: library('bookmarks') },
  { title: 'History', run: library('history') },
  { title: 'Downloads', run: library('downloads') },
  { title: 'Site permissions', run: library('permissions') },
  { title: 'New Private Window', run: () => new BrowserWin({ isPrivate: true }) },
  { title: 'Bookmark this page / remove bookmark', run: (w) => w.toggleBookmark() },
  { title: 'Pin or unpin this tab', run: (w) => w.active() && w.togglePin(w.active()) },
  { title: 'Print this page', run: (w) => w.active()?.view.webContents.print() },
  { title: 'Import from Chrome', run: () => importFrom('chrome', 'Chrome') },
  { title: 'Import from Safari', run: () => importFrom('safari', 'Safari') },
  { title: 'Chrome Web Store — install extensions', run: () => newTab(WEB_STORE) },
  { title: 'Set Sade as default browser', run: makeDefaultBrowser },
  { title: 'Clear history', run: clearHistory },
]

// --------------------------------------------------------------------- menu

function buildMenu() {
  const zoom = (delta) => () => {
    if (!wc()) return
    wc().setZoomLevel(delta === 0 ? 0 : wc().getZoomLevel() + delta)
    cur().toast(`${Math.round(1.2 ** wc().getZoomLevel() * 100)}%`)
  }
  const installed = session.defaultSession.extensions.getAllExtensions()

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about', label: t('About Sade') },
          { type: 'separator' },
          { label: t('Settings…'), accelerator: 'Cmd+,', click: library('settings') },
          { label: t('Set as Default Browser…'), click: makeDefaultBrowser },
          { type: 'separator' },
          { role: 'services', label: t('Services') },
          { type: 'separator' },
          { role: 'hide', label: t('Hide Sade') },
          { role: 'hideOthers', label: t('Hide Others') },
          { role: 'unhide', label: t('Show All') },
          { type: 'separator' },
          { role: 'quit', label: t('Quit Sade') },
        ],
      },
      {
        label: t('File'),
        submenu: [
          { label: t('New Tab'), accelerator: 'Cmd+T', click: () => newTab() },
          { label: t('New Window'), accelerator: 'Cmd+N', click: () => new BrowserWin() },
          { label: t('New Private Window'), accelerator: 'Shift+Cmd+N', click: () => new BrowserWin({ isPrivate: true }) },
          { label: t('Open Location…'), accelerator: 'Cmd+L', click: () => cur()?.focusSearch() },
          {
            label: t('Reopen Closed Tab'),
            accelerator: 'Shift+Cmd+T',
            click: () => cur()?.closedUrls.length && cur().createTab(cur().closedUrls.pop()),
          },
          { type: 'separator' },
          { label: t('Import from Chrome…'), click: () => importFrom('chrome', 'Chrome') },
          { label: t('Import from Safari…'), click: () => importFrom('safari', 'Safari') },
          { type: 'separator' },
          { label: t('Print…'), accelerator: 'Cmd+P', click: () => wc()?.print() },
          { type: 'separator' },
          {
            label: t('Close Tab'),
            accelerator: 'Cmd+W',
            click: () => {
              const w = cur()
              const focused = BrowserWindow.getFocusedWindow()
              if (focused && focused !== w?.win) return focused.close() // e.g. a sign-in prompt
              if (!w) return
              if (w.active()) w.closeTab(w.active())
            },
          },
          { label: t('Close Window'), accelerator: 'Shift+Cmd+W', click: () => cur()?.win.close() },
        ],
      },
      {
        label: t('Edit'),
        submenu: [
          { role: 'undo', label: t('Undo') },
          { role: 'redo', label: t('Redo') },
          { type: 'separator' },
          { role: 'cut', label: t('Cut') },
          { role: 'copy', label: t('Copy') },
          { role: 'paste', label: t('Paste') },
          { role: 'pasteAndMatchStyle', label: t('Paste and Match Style') },
          { role: 'selectAll', label: t('Select All') },
          { type: 'separator' },
          {
            label: t('Find…'),
            accelerator: 'Cmd+F',
            click: () => {
              if (!wc()) return
              cur().win.webContents.focus()
              cur().win.webContents.send('find:show')
            },
          },
        ],
      },
      {
        label: t('View'),
        submenu: [
          { label: t('Reload'), accelerator: 'Cmd+R', click: () => cur()?.reload(false) },
          { label: t('Force Reload'), accelerator: 'Shift+Cmd+R', click: () => cur()?.reload(true) },
          { type: 'separator' },
          { label: t('Actual Size'), accelerator: 'Cmd+0', click: zoom(0) },
          { label: t('Zoom In'), accelerator: 'Cmd+Plus', click: zoom(0.5) },
          { label: t('Zoom Out'), accelerator: 'Cmd+-', click: zoom(-0.5) },
          { type: 'separator' },
          { role: 'togglefullscreen', label: t('Toggle Full Screen') },
          { label: t('Developer Tools'), accelerator: 'Alt+Cmd+I', click: () => wc()?.toggleDevTools() },
        ],
      },
      {
        label: t('History'),
        submenu: [
          { label: t('Back'), accelerator: 'Cmd+[', click: () => cur()?.swipe('back') },
          { label: t('Forward'), accelerator: 'Cmd+]', click: () => cur()?.swipe('forward') },
          { type: 'separator' },
          { label: t('Show History'), accelerator: 'Cmd+Y', click: library('history') },
          { label: t('Clear History…'), click: clearHistory },
        ],
      },
      {
        label: t('Bookmarks'),
        submenu: [
          { label: t('Bookmark This Page'), accelerator: 'Cmd+D', click: () => cur()?.toggleBookmark() },
          { label: t('Show Bookmarks'), accelerator: 'Alt+Cmd+B', click: library('bookmarks') },
        ],
      },
      {
        label: t('Extensions'),
        submenu: [
          { label: t('Chrome Web Store'), click: () => newTab(WEB_STORE) },
          { type: 'separator' },
          ...(installed.length
            ? installed.map((ext) => ({
                label: ext.name,
                submenu: [
                  {
                    label: t('Remove'),
                    click: () =>
                      uninstallExtension(ext.id).catch((err) => dialog.showErrorBox(t('Couldn’t remove extension'), err.message)),
                  },
                ],
              }))
            : [{ label: t('No extensions installed'), enabled: false }]),
        ],
      },
      {
        label: t('Window'),
        role: 'window',
        submenu: [
          { role: 'minimize', label: t('Minimize') },
          { role: 'zoom', label: t('Zoom') },
          { type: 'separator' },
          {
            label: t('Dashboard'),
            accelerator: 'Shift+Cmd+H',
            click: () => (cur() ? cur().openDashboard() : new BrowserWin({ urls: ['sade://app/dashboard.html'] })),
          },
          { label: t('Downloads'), accelerator: 'Alt+Cmd+L', click: library('downloads') },
          { label: t('Passwords'), click: library('passwords') },
          { label: t('Site Permissions'), click: library('permissions') },
          { type: 'separator' },
          { label: t('Pin Tab'), click: () => cur()?.active() && cur().togglePin(cur().active()) },
          { label: t('Next Tab'), accelerator: 'Ctrl+Tab', click: () => cur()?.cycleTab(1) },
          { label: t('Previous Tab'), accelerator: 'Ctrl+Shift+Tab', click: () => cur()?.cycleTab(-1) },
          ...Array.from({ length: 9 }, (_v, i) => ({
            label: `Tab ${i + 1}`,
            accelerator: `Cmd+${i + 1}`,
            visible: false,
            click: () => cur()?.selectTab(i === 8 ? cur().tabs.at(-1) : cur().tabs[i]),
          })),
          { type: 'separator' },
          { role: 'front', label: t('Bring All to Front') },
        ],
      },
    ]),
  )
}

// ---------------------------------------------------------------------- ipc

function registerIpc() {
  const passwordManager = passwords.register(BrowserWin, data.changed)
  BrowserWin.offerPasswords = passwordManager.offerFromContextMenu
  // Messages from a window's own bar.
  const fromUi = (handler) => (event, ...args) => {
    const owner = BrowserWin.from(event.sender)
    if (owner && !owner.byWc(event.sender)) return handler(owner, ...args)
  }
  ipcMain.on('tab:new', fromUi((w) => w.createTab()))
  ipcMain.on('tab:select', fromUi((w, id) => w.selectTab(w.byId(id))))
  ipcMain.on('tab:close', fromUi((w, id) => w.byId(id) && w.closeTab(w.byId(id))))
  ipcMain.on('tab:move', fromUi((w, id, index) => w.moveTab(id, Number(index))))
  ipcMain.on('tab:menu', fromUi((w, id) => w.showTabMenu(id)))
  ipcMain.on('nav:back', fromUi((w) => w.swipe('back')))
  ipcMain.on('nav:forward', fromUi((w) => w.swipe('forward')))
  ipcMain.on('nav:reload', fromUi((w, hard) => w.reload(!!hard)))
  ipcMain.on('settings:open', fromUi((w) => w.openLibrary('settings')))
  ipcMain.on('bookmark:toggle', fromUi((w) => w.toggleBookmark()))
  ipcMain.on('search:focus', fromUi((w) => w.focusSearch()))
  // The address typed into the active tab: go there, in that same tab.
  ipcMain.on('address:go', fromUi((w, text) => String(text || '').trim() && w.navigate(String(text))))
  ipcMain.on('address:cancel', fromUi((w) => w.active()?.view.webContents.focus()))
  ipcMain.on('find:query', fromUi((w, text, forward = true, next = false) => {
    const contents = w.active()?.view.webContents
    if (!contents) return
    // Electron's findNext means "start a new search", the opposite of our `next`.
    if (text) contents.findInPage(text, { forward, findNext: !next })
    else contents.stopFindInPage('clearSelection')
  }))
  ipcMain.on('find:stop', fromUi((w) => {
    w.active()?.view.webContents.stopFindInPage('keepSelection')
    w.active()?.view.webContents.focus()
  }))
  ipcMain.on('download:reveal', fromUi(() => {
    const download = BrowserWin.download
    if (!download) return
    shell.showItemInFolder(download.path)
    if (download.done) BrowserWin.download = null
    BrowserWin.refreshAll()
  }))

  // Two-finger swipe, detected by the tab preload.
  ipcMain.on('nav:swipe', (event, direction) => {
    const owner = BrowserWin.from(event.sender)
    if (owner?.active()?.view.webContents === event.sender) owner.swipe(direction)
  })

  // The library page (sade://app/library.html). Only that page may call these.
  const downloadById = (id) => data.stores.downloads.data.find((d) => d.id === id)
  const lib = {
    'bookmarks.list': () => data.stores.bookmarks.data,
    'bookmarks.update': (url, patch) => data.updateBookmark(String(url), patch || {}),
    'bookmarks.remove': (url) => data.removeBookmark(String(url)),
    'history.list': (query, limit) => data.listHistory(String(query || ''), Math.min(Number(limit) || 300, 5000)),
    'history.remove': (url) => data.removeHistory(String(url)),
    'history.clear': () => data.clearHistory(),
    'downloads.list': () => data.stores.downloads.data,
    'downloads.reveal': (id) => downloadById(id) && shell.showItemInFolder(downloadById(id).path),
    'downloads.open': (id) => downloadById(id)?.state === 'done' && shell.openPath(downloadById(id).path),
    'downloads.remove': (id) => data.removeDownload(id),
    'downloads.clear': () => data.clearDownloads(),
    'permissions.list': () => data.listPermissions(),
    'permissions.remove': (key) => data.removePermission(String(key)),
    lang: () => data.stores.settings.data.language,
    // A private window's dashboard shows no browsing history.
    'dashboard.get': (_arg, owner) => (owner?.isPrivate ? { recent: [], topSites: [] } : data.dashboard()),
    // Text the search field should start with (the address ⌘L was pressed on); read once.
    'dashboard.prefill': (_arg, owner, sender) => {
      const tab = owner?.byWc(sender)
      const text = tab?.prefill || ''
      if (tab) tab.prefill = ''
      return text
    },
    'dashboard.suggest': (query, owner) => owner?.suggest(String(query || '')) || [],
    'dashboard.pick': (item, owner) => owner?.pick(item),
    'dashboard.weather': () => weather.get(),
    'dashboard.city': (query) => weather.setCity(query),
    'settings.get': () => ({
      settings: data.stores.settings.data,
      languages: LANGUAGES,
      isDefault: app.isDefaultProtocolClient('http'),
      extensions: session.defaultSession.extensions
        .getAllExtensions()
        .map((ext) => ({ id: ext.id, name: ext.name, version: ext.version })),
    }),
    'settings.set': (key, value) => {
      if (!data.setSetting(String(key), value)) return
      if (key === 'theme') nativeTheme.themeSource = value
      if (key === 'language') {
        buildMenu()
        for (const w of BrowserWin.all) w.reloadUi()
      }
    },
    'settings.run': (action, arg) => settingsActions[action]?.(arg),
    ...passwordManager.lib,
  }
  const settingsActions = {
    'default-browser': makeDefaultBrowser,
    'import-chrome': () => importFrom('chrome', 'Chrome'),
    'import-safari': () => importFrom('safari', 'Safari'),
    'clear-history': clearHistory,
    'web-store': () => newTab(WEB_STORE),
    'remove-extension': (id) =>
      uninstallExtension(String(id)).catch((err) => dialog.showErrorBox(t('Couldn’t remove extension'), err.message)),
  }
  ipcMain.handle('lib', async (event, op, ...args) => {
    const frame = event.senderFrame
    if (!frame || frame.parent || !frame.url.startsWith('sade://app/')) return null
    // Each built-in page may only call what it needs: the error page just the
    // language, the dashboard its own read-only summary, the library everything else.
    const page = frame.url.slice('sade://app/'.length).split(/[?#]/)[0]
    const allowed =
      op === 'lang' || (page === 'dashboard.html' && op.startsWith('dashboard.')) || (page === 'library.html' && !op.startsWith('dashboard.'))
    if (!allowed) return null
    const wantsOwner = op.startsWith('passwords.') || op.startsWith('dashboard.')
    return (await lib[op]?.(args[0], wantsOwner ? BrowserWin.from(event.sender) : args[1], event.sender)) ?? null
  })
}

// ---------------------------------------------------------------------- app

app.whenReady().then(async () => {
  if (!isFirstInstance) return
  data.init()
  passwords.init()
  nativeTheme.themeSource = data.stores.settings.data.theme
  data.listeners.add(() => {
    BrowserWin.refreshAll() // e.g. the bookmark star, when a bookmark is removed in the library
    for (const w of BrowserWin.all) {
      for (const tab of w.tabs) {
        if (tab.url.startsWith('sade://app/')) tab.view.webContents.send('lib:changed')
      }
    }
  })

  // Sites sniff for "Electron" and refuse to work; present as plain Chrome.
  app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|Sade)\/\S+/gi, '')

  const ses = session.defaultSession
  BrowserWin.setupSession = setupSession
  setupSession(ses, false)

  const targetWindow = () => (cur() && !cur().isPrivate ? cur() : [...BrowserWin.all].find((w) => !w.isPrivate))
  BrowserWin.extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: ses,
    createTab: async (details) => {
      const w = targetWindow() || new BrowserWin()
      const tab = w.createTab(details.url || '', { background: details.active === false })
      return [tab.view.webContents, w.win]
    },
    selectTab: (contents) => {
      if (BrowserWin.notifying) return
      const w = BrowserWin.from(contents)
      w?.selectTab(w.byWc(contents))
    },
    removeTab: (contents) => {
      const w = BrowserWin.from(contents)
      if (w?.byWc(contents)) w.closeTab(w.byWc(contents))
    },
    createWindow: async (details) => new BrowserWin({ urls: [].concat(details.url || []) }).win,
  })
  ElectronChromeExtensions.handleCRXProtocol(ses)
  for (const event of ['extension-loaded', 'extension-unloaded']) {
    ses.extensions.on(event, () => {
      buildMenu()
      data.changed() // refresh the extensions list in Settings
    })
  }
  await installChromeWebStore({ session: ses }).catch((err) => console.error('web store:', err.message))

  registerIpc()
  buildMenu()
  new BrowserWin({ restore: data.stores.settings.data.restore })
  pendingUrls.splice(0).forEach((url) => BrowserWin.open(url))

  if (process.env.SADE_DEV) require('./dev')({ BrowserWin, importers, data, passwords })

  app.on('activate', () => !BrowserWin.all.size && new BrowserWin({ restore: true }))
})

app.on('before-quit', () => {
  data.flush()
  passwords.flush()
})
app.on('window-all-closed', () => {})
