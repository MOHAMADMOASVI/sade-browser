const path = require('node:path')
const { BrowserWindow, WebContentsView, Menu, clipboard, nativeTheme, session } = require('electron')
const data = require('./data')
const { t, language } = require('./i18n')

const BAR = 40
const UI = path.join(__dirname, '..', 'ui')
const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
}
const searchUrl = (text) =>
  (SEARCH_ENGINES[data.stores.settings.data.search] || SEARCH_ENGINES.google) + encodeURIComponent(text)
const WEB_STORE = 'https://chromewebstore.google.com/'
const LIBRARY = 'sade://app/library.html'
const ERROR_PAGE = 'sade://app/error.html'
const DASHBOARD = 'sade://app/dashboard.html'

const { isWeb } = data
const bg = (isPrivate) =>
  isPrivate ? '#141416' : nativeTheme.shouldUseDarkColors ? '#1b1b1d' : '#f4f4f2'

function toUrl(input) {
  const text = input.trim()
  if (/^(https?|file|about|chrome-extension|view-source|sade):/i.test(text)) return text
  if (!/\s/.test(text) && (/^localhost(:\d+)?(\/|$)/.test(text) || /^[^\s/]+\.[^\s/.]{2,}(:\d+)?(\/|$)/.test(text))) {
    return (/^localhost|^\d+\.\d+\.\d+\.\d+/.test(text) ? 'http://' : 'https://') + text
  }
  return searchUrl(text)
}

let privateCount = 0

class BrowserWin {
  static all = new Set()
  static current = null
  // Set by main.js: the extensions host, session setup, and search-field commands.
  static extensions = null
  static setupSession = () => {}
  static commands = []
  static offerPasswords = () => {}
  static download = null // the download shown in every bar

  // The extensions library calls back into selectTab while we are telling it about
  // our own tab changes; `notifying` lets main.js ignore those echoes.
  static notifying = false
  static notify(method, ...args) {
    BrowserWin.notifying = true
    try {
      BrowserWin.extensions[method](...args)
    } finally {
      BrowserWin.notifying = false
    }
  }

  static from(wc) {
    for (const w of BrowserWin.all) {
      if (w.win.webContents === wc || w.byWc(wc)) return w
    }
    return null
  }

  static refreshAll() {
    for (const w of BrowserWin.all) w.pushState()
  }

  // Open a URL from outside (another app, the Dock, a second launch).
  static open(url) {
    const target = BrowserWin.current && !BrowserWin.current.isPrivate ? BrowserWin.current : null
    if (target) {
      target.createTab(url)
      target.win.show()
    } else {
      new BrowserWin({ urls: [url] })
    }
  }

  constructor({ isPrivate = false, urls = null, restore = false } = {}) {
    this.isPrivate = isPrivate
    this.tabs = []
    this.activeId = null
    this.nextId = 1
    this.htmlFullscreen = false
    this.closing = false
    this.ready = false // becomes true once the initial tabs exist
    this.closedUrls = []

    if (isPrivate) {
      // No "persist:" prefix, so nothing from this session ever touches the disk.
      this.ses = session.fromPartition(`private-${++privateCount}`)
      BrowserWin.setupSession(this.ses, true)
    } else {
      this.ses = session.defaultSession
    }

    const offset = BrowserWin.all.size * 24
    this.win = new BrowserWindow({
      width: 1280,
      height: 840,
      ...(offset ? { x: 80 + offset, y: 60 + offset } : {}),
      minWidth: 480,
      minHeight: 320,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 12 },
      backgroundColor: bg(isPrivate),
      webPreferences: {
        preload: path.join(UI, 'preload-bar.js'),
        sandbox: false, // the preload requires electron-chrome-extensions
        contextIsolation: true,
      },
    })
    const win = this.win
    win.loadFile(path.join(UI, 'bar.html'))

    BrowserWin.all.add(this)
    BrowserWin.current = this

    win.on('focus', () => {
      BrowserWin.current = this
      this.pushState()
    })
    win.on('blur', () => this.pushState())
    win.on('resize', () => this.layout())
    win.on('enter-full-screen', () => this.pushState())
    win.on('leave-full-screen', () => this.pushState())
    // Three-finger swipe, when that is what System Settings is set to.
    win.on('swipe', (_e, direction) => this.swipe(direction === 'right' ? 'back' : direction === 'left' ? 'forward' : ''))
    win.on('close', () => {
      this.closing = true
      data.flush()
    })
    win.on('closed', () => {
      for (const tab of [...this.tabs]) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
      this.tabs = []
      BrowserWin.all.delete(this)
      if (BrowserWin.current === this) BrowserWin.current = [...BrowserWin.all].at(-1) || null
    })

    win.webContents.once('did-finish-load', () => {
      const saved = restore ? data.stores.session.data : {}
      // Older sessions stored bare URLs.
      const savedTabs = saved.tabs || (saved.urls || []).map((url) => ({ url }))
      if (urls?.length) {
        urls.forEach((url) => this.createTab(url))
      } else if (savedTabs.length) {
        // Restored tabs stay unloaded until they are first shown.
        for (const t of savedTabs) this.createTab(t.url, { background: true, lazy: true, title: t.title, favicon: t.favicon, pinned: t.pinned })
        this.selectTab(this.tabs[saved.active] || this.tabs[0])
      } else {
        this.createTab()
      }
      this.ready = true
      this.saveSession()
    })
  }

  active() {
    return this.tabs.find((t) => t.id === this.activeId)
  }
  byWc(wc) {
    return this.tabs.find((t) => t.view.webContents === wc)
  }
  byId(id) {
    return this.tabs.find((t) => t.id === id)
  }

  // After a language change: the bar re-reads its texts from the next state and the
  // library page re-translates itself in place; only the error page needs a reload.
  reloadUi() {
    this.pushState()
    for (const tab of this.tabs) if (tab.url.startsWith(ERROR_PAGE)) tab.view.webContents.reload()
  }

  // ------------------------------------------------------------------ layout

  layout() {
    if (this.win.isDestroyed()) return
    const [width, height] = this.win.getContentSize()
    const top = this.htmlFullscreen ? 0 : BAR
    // Hidden tabs keep real bounds too, so background pages lay out and load normally.
    for (const tab of this.tabs) tab.view.setBounds({ x: 0, y: top, width, height: height - top })
  }

  pushState() {
    if (this.win.isDestroyed() || this.closing) return
    const tab = this.active()
    const nav = tab?.view.webContents.navigationHistory
    this.win.webContents.send('state', {
      tabs: this.tabs.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.failedUrl || t.url,
        favicon: t.favicon,
        loading: t.loading,
        pinned: t.pinned,
      })),
      activeId: this.activeId,
      activeWcId: tab?.view.webContents.id,
      reloading: tab?.reloading || null,
      canBack: !!nav?.canGoBack(),
      canForward: !!nav?.canGoForward(),
      fullscreen: this.win.isFullScreen(),
      isPrivate: this.isPrivate,
      bookmarked: !!tab && data.isBookmarked(tab.url),
      focused: this.win.isFocused(),
      lang: language(),
      download: BrowserWin.download,
    })
    // The tab's own script draws the swipe hint, so it needs to know what is possible.
    if (tab && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.send('nav:state', { back: !!nav?.canGoBack(), forward: !!nav?.canGoForward() })
    }
    this.saveSession()
  }

  // A short message that appears in the bar and fades away.
  toast(text) {
    if (!this.win.isDestroyed()) this.win.webContents.send('toast', String(text))
  }

  saveSession() {
    if (this.isPrivate || this.closing || !this.ready) return
    const kept = this.tabs.filter((t) => isWeb(t.url))
    data.stores.session.data = {
      tabs: kept.map((t) => ({ url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned })),
      active: Math.max(0, kept.indexOf(this.active())),
    }
    data.stores.session.save()
  }

  // -------------------------------------------------------------------- tabs

  createTab(url, { background = false, view, lazy = false, title = '', favicon = null, pinned = false, prefill = '' } = {}) {
    const adopted = !!view // a popup guest that Chromium is already loading
    // A brand-new tab is the dashboard, whose search field takes the focus.
    if (!url && !adopted) url = DASHBOARD
    view ||= new WebContentsView({
      webPreferences: {
        session: this.ses,
        preload: path.join(UI, 'preload-tab.js'),
        sandbox: true,
        contextIsolation: true,
        plugins: true, // built-in PDF viewer
      },
    })
    const wc = view.webContents
    const tab = {
      id: this.nextId++,
      view,
      title,
      url: url || '',
      favicon,
      loading: false,
      failedUrl: null,
      pinned: false,
      pending: lazy && !!url,
      prefill, // text the dashboard's search field should start with
    }
    this.tabs.push(tab)

    view.setBackgroundColor(bg(this.isPrivate))
    view.setVisible(false)
    this.win.contentView.addChildView(view)
    this.layout()
    if (!this.isPrivate) BrowserWin.notify('addTab', wc, this.win)

    wc.on('page-title-updated', (_e, newTitle) => {
      tab.title = newTitle
      if (!this.isPrivate) data.setTitle(tab.url, newTitle)
      this.pushState()
    })
    const onNavigate = (navUrl) => {
      if (navUrl.startsWith(ERROR_PAGE) && tab.failedUrl) return this.pushState()
      tab.failedUrl = null
      tab.url = navUrl
      if (!this.isPrivate) data.recordVisit(navUrl)
      this.pushState()
    }
    wc.on('did-navigate', (_e, navUrl) => {
      tab.favicon = null
      onNavigate(navUrl)
    })
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => isMainFrame && onNavigate(navUrl))
    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = icons[0] || null
      if (!this.isPrivate && tab.favicon) data.setFavicon(tab.url, tab.favicon)
      this.pushState()
    })
    wc.on('did-start-loading', () => {
      tab.loading = true
      this.pushState()
    })
    wc.on('did-stop-loading', () => {
      tab.loading = false
      tab.reloading = null
      this.stopSpeedMeter(tab)
      this.pushState()
    })
    wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return // -3: aborted by a newer navigation
      tab.failedUrl = failedUrl
      tab.title = t('Can’t open page')
      wc.loadURL(`${ERROR_PAGE}?url=${encodeURIComponent(failedUrl)}&reason=${encodeURIComponent(description)}`)
    })
    wc.on('found-in-page', (_e, result) => {
      if (tab.id === this.activeId) {
        this.win.webContents.send('find:result', {
          current: result.activeMatchOrdinal,
          total: result.matches,
          final: result.finalUpdate,
        })
      }
    })
    wc.on('enter-html-full-screen', () => {
      this.htmlFullscreen = true
      this.layout()
    })
    wc.on('leave-html-full-screen', () => {
      this.htmlFullscreen = false
      this.layout()
    })
    wc.on('context-menu', (_e, params) => this.showContextMenu(tab, params))
    wc.setWindowOpenHandler(({ url: target, disposition }) => {
      if (disposition === 'new-window') {
        // Popups (OAuth and the like) need window.opener, so adopt the guest as a tab.
        return {
          action: 'allow',
          createWindow: (options) => {
            const guest = new WebContentsView({ webContents: options.webContents })
            this.createTab(target, { view: guest })
            return guest.webContents
          },
        }
      }
      this.createTab(target, { background: disposition === 'background-tab' })
      return { action: 'deny' }
    })
    wc.on('destroyed', () => this.tabs.includes(tab) && this.closeTab(tab))

    if (pinned) this.togglePin(tab, true)
    if (url && !adopted && !tab.pending) wc.loadURL(url).catch(() => {})
    if (!background) this.selectTab(tab)
    else this.pushState()
    return tab
  }

  selectTab(tab) {
    if (!tab) return
    if (this.activeId !== tab.id) this.active()?.view.webContents.stopFindInPage('clearSelection')
    this.activeId = tab.id
    if (tab.pending) {
      tab.pending = false
      tab.view.webContents.loadURL(tab.url).catch(() => {})
    }
    for (const t of this.tabs) t.view.setVisible(t === tab)
    this.htmlFullscreen = false
    this.layout()
    if (!this.isPrivate) BrowserWin.notify('selectTab', tab.view.webContents)
    tab.view.webContents.focus()
    this.win.webContents.send('find:hide')
    this.pushState()
  }

  closeTab(tab) {
    const index = this.tabs.indexOf(tab)
    if (index < 0) return
    this.tabs.splice(index, 1)
    this.stopSpeedMeter(tab)
    if (isWeb(tab.url)) this.closedUrls.push(tab.url)
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    if (this.closing) return
    if (!this.tabs.length) return this.win.close()
    if (tab.id === this.activeId) this.selectTab(this.tabs[Math.min(index, this.tabs.length - 1)])
    else this.pushState()
  }

  cycleTab(step) {
    if (this.tabs.length < 2) return
    const index = this.tabs.indexOf(this.active())
    this.selectTab(this.tabs[(index + step + this.tabs.length) % this.tabs.length])
  }

  // Pinned tabs live in their own group at the left; moves stay inside a group.
  moveTab(id, toIndex) {
    const tab = this.byId(id)
    if (!tab) return
    const pinnedCount = this.tabs.filter((t) => t.pinned).length
    const [min, max] = tab.pinned ? [0, pinnedCount - 1] : [pinnedCount, this.tabs.length - 1]
    const index = Math.max(min, Math.min(max, toIndex))
    const from = this.tabs.indexOf(tab)
    if (from === index) return
    this.tabs.splice(from, 1)
    this.tabs.splice(index, 0, tab)
    this.pushState()
  }

  togglePin(tab, quiet = false) {
    this.tabs.splice(this.tabs.indexOf(tab), 1)
    tab.pinned = !tab.pinned
    this.tabs.splice(this.tabs.filter((t) => t.pinned).length, 0, tab)
    if (quiet) return
    this.pushState()
    this.toast(tab.pinned ? t('Tab pinned') : t('Tab unpinned'))
  }

  showTabMenu(id) {
    const tab = this.byId(id)
    if (!tab) return
    Menu.buildFromTemplate([
      { label: tab.pinned ? t('Unpin Tab') : t('Pin Tab'), click: () => this.togglePin(tab) },
      { label: t('Duplicate'), enabled: !!tab.url, click: () => this.createTab(tab.url) },
      {
        label: t('Move to New Window'),
        enabled: !!tab.url && this.tabs.length > 1,
        click: () => {
          new BrowserWin({ isPrivate: this.isPrivate, urls: [tab.url] })
          this.closeTab(tab)
        },
      },
      { type: 'separator' },
      { label: t('Close Tab'), click: () => this.closeTab(tab) },
      {
        label: t('Close Other Tabs'),
        enabled: this.tabs.some((t) => t !== tab && !t.pinned),
        click: () => {
          this.selectTab(tab)
          for (const other of this.tabs.filter((t) => t !== tab && !t.pinned)) this.closeTab(other)
        },
      },
    ]).popup({ window: this.win })
  }

  // -------------------------------------------------------------- navigation

  navigate(input, tab = this.active()) {
    if (!tab) return this.createTab(toUrl(input))
    tab.failedUrl = null
    tab.pending = false
    tab.view.webContents.loadURL(toUrl(input)).catch(() => {})
    tab.view.webContents.focus()
  }

  // A plain reload, or a "hard" one that skips the cache. The bar's reload button
  // shows which is running: blue for plain, yellow for hard.
  reload(hard = false) {
    const tab = this.active()
    if (!tab || tab.pending || !tab.url) return
    tab.reloading = hard ? 'hard' : 'soft'
    this.pushState()
    this.startSpeedMeter(tab)
    if (hard) tab.view.webContents.reloadIgnoringCache()
    else tab.view.webContents.reload()
  }

  // While a reload runs, measure how fast the page's data is really arriving (bytes
  // per second over the last second) so the reload icon can turn at that pace.
  // Uses the tab's debugger channel; if DevTools already holds it, there is simply
  // no reading and the icon turns at its resting speed.
  startSpeedMeter(tab) {
    this.stopSpeedMeter(tab)
    const wc = tab.view.webContents
    const dbg = wc.debugger
    const samples = [] // [time, bytes]
    try {
      dbg.attach('1.3')
    } catch {
      return
    }
    const onMessage = (_event, method, params) => {
      if (method === 'Network.dataReceived') samples.push([Date.now(), params.encodedDataLength || params.dataLength || 0])
    }
    dbg.on('message', onMessage)
    dbg.sendCommand('Network.enable').catch(() => {})
    const timer = setInterval(() => {
      const now = Date.now()
      while (samples.length && now - samples[0][0] > 1000) samples.shift()
      const speed = samples.reduce((sum, sample) => sum + sample[1], 0)
      if (tab.id === this.activeId && !this.win.isDestroyed()) this.win.webContents.send('reload:speed', speed)
    }, 200)
    tab.speedMeter = { dbg, onMessage, timer }
  }

  stopSpeedMeter(tab) {
    const meter = tab.speedMeter
    if (!meter) return
    tab.speedMeter = null
    clearInterval(meter.timer)
    meter.dbg.off('message', meter.onMessage)
    try {
      if (meter.dbg.isAttached()) meter.dbg.detach()
    } catch {}
  }

  swipe(direction) {
    const nav = this.active()?.view.webContents.navigationHistory
    if (direction === 'back' && nav?.canGoBack()) nav.goBack()
    if (direction === 'forward' && nav?.canGoForward()) nav.goForward()
  }

  openLibrary(section) {
    const url = `${LIBRARY}#${section}`
    const existing = this.tabs.find((t) => t.url.startsWith(LIBRARY))
    if (!existing) return this.createTab(url)
    this.selectTab(existing)
    existing.view.webContents.loadURL(url).catch(() => {})
  }

  openDashboard() {
    const existing = this.tabs.find((t) => t.url.startsWith(DASHBOARD))
    if (existing) this.selectTab(existing)
    else this.createTab(DASHBOARD)
  }

  toggleBookmark() {
    const tab = this.active()
    if (!tab || !isWeb(tab.url)) return
    data.toggleBookmark(tab.url, tab.title)
    this.pushState()
    this.toast(data.isBookmarked(tab.url) ? t('Bookmarked') : t('Bookmark removed'))
  }

  // ------------------------------------------------------------------ search
  // Searching happens in the field on the dashboard. On any other page, the
  // active tab itself turns into an editable address.

  focusSearch() {
    const tab = this.active()
    if (!tab) return this.createTab()
    if (tab.url.startsWith(DASHBOARD)) {
      tab.view.webContents.focus()
      return tab.view.webContents.send('dash:focus', '')
    }
    this.win.webContents.focus()
    this.win.webContents.send('address:edit')
  }

  currentAddress() {
    const tab = this.active()
    const url = tab?.failedUrl || tab?.url
    return isWeb(url) ? url : ''
  }

  suggest(query) {
    const q = query.trim().toLowerCase()
    const terms = q.split(/\s+/).filter(Boolean)
    const matches = (text) => terms.every((term) => text.toLowerCase().includes(term))
    const host = (url) => url.replace(/^https?:\/\/(www\.)?/, '')
    const bookmarks = data.stores.bookmarks.data
    const others = this.tabs.filter((t) => t.id !== this.activeId && t.url && !t.url.startsWith(DASHBOARD))
    const tabItem = (t) => ({ kind: 'tab', id: t.id, title: t.title || t.url, url: t.url, icon: t.favicon })

    if (!q) return []

    const scored = []
    const seen = new Set()
    const add = (item, score) => {
      if (seen.has(item.url)) return
      seen.add(item.url)
      scored.push({ item, score: score + (host(item.url).startsWith(q) ? 4 : 0) })
    }
    for (const t of others) if (matches(t.title + ' ' + t.url)) add(tabItem(t), 6)
    for (const b of bookmarks) {
      if (matches(b.title + ' ' + b.url)) add({ kind: 'bookmark', title: b.title, url: b.url }, 4)
    }
    const now = Date.now()
    for (const [url, h] of Object.entries(data.stores.history.data)) {
      if (!matches(h.t + ' ' + url)) continue
      const recency = Math.max(0, 2 - (now - h.l) / (14 * 86400e3))
      add({ kind: 'history', title: h.t || url, url }, Math.min(Math.log2(h.n + 1), 3) + recency)
    }
    // Commands match in the chosen language and in English.
    BrowserWin.commands.forEach((c, index) => {
      const title = t(c.title)
      if (matches(title + ' ' + c.title)) scored.push({ item: { kind: 'command', index, title }, score: 5 })
    })
    scored.sort((a, b) => b.score - a.score)

    const typed = toUrl(query)
    const first = { kind: typed === searchUrl(query.trim()) ? 'search' : 'go', title: query.trim(), url: typed }
    return [first, ...scored.slice(0, 7).map((s) => s.item)]
  }

  pick(item) {
    if (!item) return
    if (item.kind === 'tab') return this.selectTab(this.byId(item.id))
    if (item.kind === 'command') return BrowserWin.commands[item.index]?.run(this)
    if (item.url) this.navigate(item.url)
  }

  // ------------------------------------------------------------ context menu

  showContextMenu(tab, params) {
    const wc = tab.view.webContents
    const nav = wc.navigationHistory
    const items = []
    if (params.linkURL) {
      items.push(
        { label: t('Open Link in New Tab'), click: () => this.createTab(params.linkURL, { background: true }) },
        { label: t('Open Link in New Window'), click: () => new BrowserWin({ isPrivate: this.isPrivate, urls: [params.linkURL] }) },
        { label: t('Open Link in Private Window'), visible: !this.isPrivate, click: () => new BrowserWin({ isPrivate: true, urls: [params.linkURL] }) },
        {
          label: t('Copy Link'),
          click: () => {
            clipboard.writeText(params.linkURL)
            this.toast(t('Link copied'))
          },
        },
        { type: 'separator' },
      )
    }
    if (params.mediaType === 'image') {
      items.push(
        { label: t('Open Image in New Tab'), click: () => this.createTab(params.srcURL) },
        { label: t('Save Image'), click: () => wc.downloadURL(params.srcURL) },
        { label: t('Copy Image'), click: () => wc.copyImageAt(params.x, params.y) },
        { type: 'separator' },
      )
    }
    if (params.isEditable) {
      items.push(
        { role: 'cut', label: t('Cut') },
        { role: 'copy', label: t('Copy') },
        { role: 'paste', label: t('Paste') },
        { role: 'selectAll', label: t('Select All') },
        { type: 'separator' },
        { label: t('Fill Password…'), click: () => BrowserWin.offerPasswords(this, tab) },
        { type: 'separator' },
      )
    } else if (params.selectionText.trim()) {
      const text = params.selectionText.trim()
      items.push(
        { role: 'copy', label: t('Copy') },
        {
          label: t('Search for “{0}”', text.length > 24 ? text.slice(0, 24) + '…' : text),
          click: () => this.createTab(searchUrl(text)),
        },
        { type: 'separator' },
      )
    }
    if (!params.linkURL && !params.isEditable && params.mediaType === 'none') {
      items.push(
        { label: t('Back'), enabled: nav.canGoBack(), click: () => nav.goBack() },
        { label: t('Forward'), enabled: nav.canGoForward(), click: () => nav.goForward() },
        { label: t('Reload'), click: () => this.reload(false) },
        { label: t('Print…'), click: () => wc.print() },
        { type: 'separator' },
      )
    }
    if (!this.isPrivate) {
      const extensionItems = BrowserWin.extensions.getContextMenuItems(wc, params)
      if (extensionItems.length) items.push(...extensionItems, { type: 'separator' })
    }
    items.push({ label: t('Inspect Element'), click: () => wc.inspectElement(params.x, params.y) })
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }
}

nativeTheme.on('updated', () => {
  for (const w of BrowserWin.all) {
    w.win.setBackgroundColor(bg(w.isPrivate))
    for (const tab of w.tabs) tab.view.setBackgroundColor(bg(w.isPrivate))
  }
})

module.exports = { BrowserWin, UI, WEB_STORE, toUrl }
