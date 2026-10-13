const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const bplist = require('bplist-parser')

const home = os.homedir()
const HISTORY_LIMIT = 10000

// Browsers keep their databases locked while running, so query a copy.
async function sqlite(db, sql) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sade-import-'))
  try {
    const copy = path.join(tmp, 'db')
    await fs.promises.copyFile(db, copy)
    for (const ext of ['-wal', '-shm']) {
      await fs.promises.copyFile(db + ext, copy + ext).catch(() => {})
    }
    const out = await new Promise((resolve, reject) => {
      execFile(
        '/usr/bin/sqlite3',
        ['-readonly', '-json', copy, sql],
        { maxBuffer: 256 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      )
    })
    return out.trim() ? JSON.parse(out) : []
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true })
  }
}

const isWeb = (url) => /^https?:\/\//.test(url || '')
const join = (folder, name) => (folder ? `${folder} / ${name}` : name)

async function chrome() {
  const root = path.join(home, 'Library/Application Support/Google/Chrome')
  let profile = 'Default'
  try {
    const state = JSON.parse(await fs.promises.readFile(path.join(root, 'Local State'), 'utf8'))
    profile = state.profile?.last_used || profile
  } catch {}
  const dir = path.join(root, profile)
  await fs.promises.access(dir)

  const bookmarks = []
  const walk = (node, folder) => {
    if (node.type === 'url' && isWeb(node.url)) bookmarks.push({ title: node.name, url: node.url, folder })
    for (const child of node.children || []) walk(child, node.type === 'folder' && folder !== null ? join(folder, node.name) : '')
  }
  try {
    const tree = JSON.parse(await fs.promises.readFile(path.join(dir, 'Bookmarks'), 'utf8'))
    // The three roots ("Bookmarks Bar", …) are containers, not folders worth keeping.
    Object.values(tree.roots || {}).forEach((root) => root && typeof root === 'object' && walk(root, null))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  let history = []
  try {
    const rows = await sqlite(
      path.join(dir, 'History'),
      `SELECT url, title, visit_count AS visits, last_visit_time AS t FROM urls
       WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ${HISTORY_LIMIT}`,
    )
    // Chrome timestamps are microseconds since 1601-01-01.
    history = rows
      .filter((r) => isWeb(r.url))
      .map((r) => ({ url: r.url, title: r.title, visits: r.visits, last: r.t / 1000 - 11644473600000 }))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  return { bookmarks, history }
}

async function safari() {
  const dir = path.join(home, 'Library/Safari')

  const bookmarks = []
  const containers = new Set(['BookmarksBar', 'BookmarksMenu'])
  const walk = (node, folder) => {
    if (node.Title === 'com.apple.ReadingList') return
    if (node.WebBookmarkType === 'WebBookmarkTypeLeaf' && isWeb(node.URLString)) {
      bookmarks.push({ title: node.URIDictionary?.title || node.URLString, url: node.URLString, folder })
    }
    const inner = node.Title && !containers.has(node.Title) ? join(folder, node.Title) : folder
    for (const child of node.Children || []) walk(child, inner)
  }
  const [tree] = bplist.parseBuffer(await fs.promises.readFile(path.join(dir, 'Bookmarks.plist')))
  walk(tree, '')

  const rows = await sqlite(
    path.join(dir, 'History.db'),
    `SELECT i.url, i.visit_count AS visits, MAX(v.visit_time) AS t,
            (SELECT title FROM history_visits WHERE history_item = i.id ORDER BY visit_time DESC LIMIT 1) AS title
     FROM history_items i JOIN history_visits v ON v.history_item = i.id
     GROUP BY i.id ORDER BY t DESC LIMIT ${HISTORY_LIMIT}`,
  )
  // Safari timestamps are seconds since 2001-01-01.
  const history = rows
    .filter((r) => isWeb(r.url))
    .map((r) => ({ url: r.url, title: r.title || '', visits: r.visits, last: (r.t + 978307200) * 1000 }))

  return { bookmarks, history }
}

module.exports = { chrome, safari, sqlite }
