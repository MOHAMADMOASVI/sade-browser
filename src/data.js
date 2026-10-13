// Everything Sade remembers: bookmarks, history, downloads, site permissions
// and the last session. Plain JSON files in userData.
const { JsonStore } = require('./store')

const HISTORY_MAX = 20000
const DOWNLOADS_MAX = 200

const SETTING_DEFAULTS = { language: 'en', search: 'google', theme: 'system', restore: true, summon: false }
const SETTING_VALUES = {
  language: ['en', 'fa', 'ru'],
  search: ['google', 'duckduckgo', 'bing'],
  theme: ['system', 'light', 'dark'],
  restore: [true, false],
  summon: [true, false],
}

const stores = {}
const listeners = new Set()
let notifyTimer = null

function init() {
  stores.bookmarks = new JsonStore('bookmarks.json', [])
  stores.history = new JsonStore('history.json', {})
  stores.perms = new JsonStore('permissions.json', {})
  stores.session = new JsonStore('session.json', {})
  stores.downloads = new JsonStore('downloads.json', [])
  stores.settings = new JsonStore('settings.json', {})
  stores.settings.data = { ...SETTING_DEFAULTS, ...stores.settings.data }
  stores.stats = new JsonStore('stats.json', {})
  stores.stats.data = { icons: stores.stats.data.icons || {} }
  // Anything still "in progress" was cut off when the app last quit.
  for (const d of stores.downloads.data) if (d.state === 'progress') d.state = 'failed'
}

// Tell open windows and library pages that something changed (coalesced).
function changed() {
  if (notifyTimer) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    for (const listener of listeners) listener()
  }, 150)
}

const isWeb = (url) => /^https?:\/\//.test(url || '')
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------- history

function recordVisit(url) {
  if (!isWeb(url)) return
  const all = stores.history.data
  const entry = all[url] || (all[url] = { t: '', n: 0, l: 0 })
  entry.n += 1
  entry.l = Date.now()
  const urls = Object.keys(all)
  if (urls.length > HISTORY_MAX) {
    urls
      .sort((a, b) => all[a].l - all[b].l)
      .slice(0, HISTORY_MAX / 10)
      .forEach((u) => delete all[u])
  }
  stores.history.save()
  changed()
}

function setTitle(url, title) {
  const entry = stores.history.data[url]
  if (!entry || entry.t === title) return
  entry.t = title
  stores.history.save()
}

function listHistory(query = '', limit = 300) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const rows = []
  for (const [url, h] of Object.entries(stores.history.data)) {
    const text = (h.t + ' ' + url).toLowerCase()
    if (terms.every((term) => text.includes(term))) rows.push({ url, title: h.t, last: h.l, visits: h.n })
  }
  rows.sort((a, b) => b.last - a.last)
  return { total: rows.length, rows: rows.slice(0, limit) }
}

function removeHistory(url) {
  delete stores.history.data[url]
  stores.history.save()
  changed()
}

function clearHistory() {
  stores.history.data = {}
  stores.history.save()
  changed()
}

// ----------------------------------------------------------------- dashboard

// Remember each site's icon so the dashboard can show it without loading the site.
function setFavicon(url, icon) {
  const host = hostOf(url)
  if (!host || !isWeb(icon) || stores.stats.data.icons[host] === icon) return
  const icons = stores.stats.data.icons
  icons[host] = icon
  const hosts = Object.keys(icons)
  if (hosts.length > 600) hosts.slice(0, 100).forEach((old) => delete icons[old])
  stores.stats.save()
}

// What the dashboard lists: the pages opened last (one per site) and the most
// visited sites that are not already among those, so nothing appears twice.
function dashboard() {
  const { icons } = stores.stats.data
  const sites = new Map()
  const pages = []
  for (const [url, h] of Object.entries(stores.history.data)) {
    const host = hostOf(url)
    if (!host) continue
    const site = sites.get(host) || { host, url: new URL(url).origin, visits: 0 }
    site.visits += h.n
    sites.set(host, site)
    pages.push({ url, title: h.t, last: h.l, host })
  }
  const withIcon = (item) => ({ ...item, icon: icons[item.host] || null })

  const recent = []
  const shown = new Set()
  for (const page of pages.sort((a, b) => b.last - a.last)) {
    if (shown.has(page.host)) continue
    shown.add(page.host)
    recent.push(page)
    if (recent.length === 6) break
  }
  const top = [...sites.values()]
    .filter((site) => !shown.has(site.host))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 8)

  return { recent: recent.map(withIcon), topSites: top.map(withIcon) }
}

// ----------------------------------------------------------------- bookmarks

const isBookmarked = (url) => stores.bookmarks.data.some((b) => b.url === url)

function toggleBookmark(url, title) {
  if (!isWeb(url)) return
  const list = stores.bookmarks.data
  const index = list.findIndex((b) => b.url === url)
  if (index >= 0) list.splice(index, 1)
  else list.unshift({ title: title || url, url, folder: '' })
  stores.bookmarks.save()
  changed()
}

function updateBookmark(url, patch) {
  const bookmark = stores.bookmarks.data.find((b) => b.url === url)
  if (!bookmark) return
  if (typeof patch.title === 'string') bookmark.title = patch.title.trim() || bookmark.url
  if (typeof patch.folder === 'string') bookmark.folder = patch.folder.trim()
  stores.bookmarks.save()
  changed()
}

function removeBookmark(url) {
  stores.bookmarks.data = stores.bookmarks.data.filter((b) => b.url !== url)
  stores.bookmarks.save()
  changed()
}

// Merge what an importer returned; returns how many bookmarks were new.
function mergeImport(result) {
  const byUrl = new Map(stores.bookmarks.data.map((b) => [b.url, b]))
  let added = 0
  for (const b of result.bookmarks) {
    const existing = byUrl.get(b.url)
    if (existing) {
      if (!existing.folder && b.folder) existing.folder = b.folder
      continue
    }
    byUrl.set(b.url, b)
    stores.bookmarks.data.push(b)
    added += 1
  }
  const all = stores.history.data
  for (const h of result.history) {
    const cur = all[h.url]
    all[h.url] = {
      t: h.title || cur?.t || '',
      n: Math.max(h.visits || 1, cur?.n || 0),
      l: Math.max(h.last || 0, cur?.l || 0),
    }
  }
  stores.bookmarks.save()
  stores.history.save()
  changed()
  return added
}

// ----------------------------------------------------------------- downloads

function addDownload(entry) {
  stores.downloads.data.unshift(entry)
  stores.downloads.data.length = Math.min(stores.downloads.data.length, DOWNLOADS_MAX)
  stores.downloads.save()
  changed()
}

function touchDownloads() {
  stores.downloads.save()
  changed()
}

function removeDownload(id) {
  stores.downloads.data = stores.downloads.data.filter((d) => d.id !== id || d.state === 'progress')
  touchDownloads()
}

function clearDownloads() {
  stores.downloads.data = stores.downloads.data.filter((d) => d.state === 'progress')
  touchDownloads()
}

// --------------------------------------------------------------- permissions

function listPermissions() {
  return Object.entries(stores.perms.data).map(([key, allowed]) => {
    const [origin, permission] = key.split('|')
    return { key, origin, permission, allowed }
  })
}

function removePermission(key) {
  delete stores.perms.data[key]
  stores.perms.save()
  changed()
}

// ------------------------------------------------------------------ settings

function setSetting(key, value) {
  if (!SETTING_VALUES[key]?.includes(value)) return false
  stores.settings.data[key] = value
  stores.settings.save()
  changed()
  return true
}

function flush() {
  for (const store of Object.values(stores)) store.flush()
}

module.exports = {
  init,
  stores,
  listeners,
  changed,
  isWeb,
  recordVisit,
  setTitle,
  listHistory,
  removeHistory,
  clearHistory,
  isBookmarked,
  toggleBookmark,
  updateBookmark,
  removeBookmark,
  mergeImport,
  addDownload,
  touchDownloads,
  removeDownload,
  clearDownloads,
  listPermissions,
  removePermission,
  setSetting,
  setFavicon,
  dashboard,
  flush,
}
