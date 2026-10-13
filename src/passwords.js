// Built-in password manager.
//
// Passwords are encrypted with Electron's safeStorage, whose key lives in the macOS
// Keychain ("Sade Safe Storage"); passwords.json only ever holds ciphertext. A page
// never receives a password it did not ask the user for: the tab preload reports
// sign-in forms, and a password is sent back only to the main frame of the origin it
// was saved for, after the user picks the account from a native menu.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { ipcMain, safeStorage, systemPreferences, dialog, clipboard, shell, Menu } = require('electron')
const { JsonStore } = require('./store')
const { sqlite } = require('./importers')
const { t } = require('./i18n')

const UNLOCK_MS = 5 * 60 * 1000
const BAR = 56 // height of the window's bar, above the page

let store = null
let unlockedUntil = 0

function init() {
  store = new JsonStore('passwords.json', { entries: [], never: [] })
  store.data.entries ||= []
  store.data.never ||= []
}

const available = () => safeStorage.isEncryptionAvailable()
const encrypt = (text) => safeStorage.encryptString(text).toString('base64')
const decrypt = (entry) => safeStorage.decryptString(Buffer.from(entry.secret, 'base64'))
const host = (origin) => origin.replace(/^https?:\/\/(www\.)?/, '')

const forOrigin = (origin) => store.data.entries.filter((e) => e.origin === origin)
const byId = (id) => store.data.entries.find((e) => e.id === id)

function save(origin, username, password) {
  const existing = store.data.entries.find((e) => e.origin === origin && e.username === username)
  if (existing) {
    existing.secret = encrypt(password)
    existing.updated = Date.now()
  } else {
    store.data.entries.push({
      id: crypto.randomUUID(),
      origin,
      username,
      secret: encrypt(password),
      created: Date.now(),
      updated: Date.now(),
    })
  }
  store.save()
}

function remove(id) {
  store.data.entries = store.data.entries.filter((e) => e.id !== id)
  store.save()
}

// Revealing or copying a password asks for Touch ID (or the Mac's password, where
// macOS offers it), then stays unlocked for a few minutes.
async function unlock() {
  if (Date.now() < unlockedUntil) return true
  if (systemPreferences.canPromptTouchID()) {
    try {
      await systemPreferences.promptTouchID(t('show a saved password'))
    } catch {
      return false
    }
  }
  unlockedUntil = Date.now() + UNLOCK_MS
  return true
}

function strongPassword() {
  // No look-alike characters; dashes keep it readable and satisfy "symbol" rules.
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const group = () => Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('')
  return `${group()}-${group()}-${group()}`
}

// ------------------------------------------------------------------- import

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') (row.push(cell), (cell = ''))
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) (row.push(cell), rows.push(row))
  return rows
}

// Accepts the CSV exported by Chrome (name,url,username,password) and by Apple's
// Passwords app (Title,URL,Username,Password,…). Returns how many were imported.
function importCsv(text) {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''))
  const columns = (header || []).map((name) => name.trim().toLowerCase())
  const column = (...names) => columns.findIndex((name) => names.includes(name))
  const url = column('url', 'website', 'login_uri')
  const user = column('username', 'login_username', 'user')
  const pass = column('password', 'login_password')
  if (url < 0 || pass < 0) return 0
  let count = 0
  for (const row of rows) {
    const password = row[pass]
    if (!password) continue
    let origin
    try {
      const parsed = new URL(/^[a-z]+:\/\//i.test(row[url]) ? row[url] : 'https://' + row[url])
      if (!/^https?:$/.test(parsed.protocol)) continue
      origin = parsed.origin
    } catch {
      continue
    }
    save(origin, user >= 0 ? row[user] || '' : '', password)
    count += 1
  }
  store.flush()
  return count
}

async function importFromFile(parent) {
  if (!available()) return keychainMissing(parent)
  const { filePaths } = await dialog.showOpenDialog(parent, {
    message: t('Choose a passwords CSV file exported from Chrome or the Passwords app'),
    properties: ['openFile'],
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  })
  const file = filePaths?.[0]
  if (!file) return
  let count = 0
  try {
    count = importCsv(await fs.promises.readFile(file, 'utf8'))
  } catch (err) {
    return dialog.showMessageBox(parent, { type: 'warning', message: t('Couldn’t read that file'), detail: err.message })
  }
  if (!count) return dialog.showMessageBox(parent, { message: t('No passwords were found in that file.') })
  // An exported CSV is every password in plain text; offer to get rid of it.
  const { response } = await dialog.showMessageBox(parent, {
    message: t('Imported {0} passwords', count),
    detail: t('The exported file still contains your passwords in plain text.'),
    buttons: [t('Move File to Trash'), t('Keep File')],
    cancelId: 1,
  })
  if (response === 0) await shell.trashItem(file).catch(() => {})
}

// Safari keeps passwords in iCloud Keychain, which macOS does not let other apps
// read. The only way in is the export the Passwords app offers, so walk through it.
async function importFromSafari(parent) {
  if (!available()) return keychainMissing(parent)
  const { response } = await dialog.showMessageBox(parent, {
    message: t('Import passwords from Safari'),
    detail: t(
      'macOS does not let other apps read Safari’s passwords directly, so they come through a file:\n\n1. Open the Passwords app.\n2. Choose File → Export All Passwords to File…\n3. Come back here and choose that file.\n\nSade can move the file to the Trash afterwards.',
    ),
    buttons: [t('Open Passwords App'), t('Choose File…'), t('Cancel')],
    cancelId: 2,
  })
  if (response === 2) return
  if (response === 0) {
    execFile('/usr/bin/open', ['-b', 'com.apple.Passwords'], () => {})
    const next = await dialog.showMessageBox(parent, {
      message: t('Choose the exported file when it is ready'),
      buttons: [t('Choose File…'), t('Cancel')],
      cancelId: 1,
    })
    if (next.response === 1) return
  }
  await importFromFile(parent)
}

// ------------------------------------------------------------------ Chrome
// Chrome encrypts each saved password with AES-128-CBC. The key is derived from a
// secret it keeps in the login Keychain ("Chrome Safe Storage"); macOS asks the
// user before handing that secret to anyone else.

const chromeKey = (secret) => crypto.pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1')

function decryptChrome(hex, key) {
  const blob = Buffer.from(hex || '', 'hex')
  if (blob.length < 4 || blob.subarray(0, 3).toString() !== 'v10') return null
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

// Every saved login in one Chrome profile folder → { imported, skipped }.
async function importChromeProfile(dir, key) {
  let imported = 0
  let skipped = 0
  for (const name of ['Login Data', 'Login Data For Account']) {
    const db = path.join(dir, name)
    if (!fs.existsSync(db)) continue
    const rows = await sqlite(
      db,
      'SELECT origin_url AS url, username_value AS username, hex(password_value) AS secret FROM logins WHERE blacklisted_by_user = 0',
    )
    for (const row of rows) {
      let origin
      try {
        const url = new URL(row.url)
        if (!/^https?:$/.test(url.protocol)) continue
        origin = url.origin
      } catch {
        continue
      }
      const password = decryptChrome(row.secret, key)
      if (!password) {
        skipped += 1
        continue
      }
      save(origin, row.username || '', password)
      imported += 1
    }
  }
  return { imported, skipped }
}

async function importFromChrome(parent) {
  if (!available()) return keychainMissing(parent)
  const root = path.join(os.homedir(), 'Library/Application Support/Google/Chrome')
  const profiles = fs.existsSync(root)
    ? fs.readdirSync(root).filter((name) => fs.existsSync(path.join(root, name, 'Login Data')))
    : []
  if (!profiles.length) {
    return dialog.showMessageBox(parent, { type: 'warning', message: t('{0} data was not found on this Mac.', 'Chrome') })
  }
  const { response } = await dialog.showMessageBox(parent, {
    message: t('Import passwords from Chrome?'),
    detail: t(
      'macOS will now ask for your Mac password, on behalf of “security”, so Sade can read the key that protects Chrome’s saved passwords. Choose “Allow” to permit it this once.',
    ),
    buttons: [t('Continue'), t('Cancel')],
    cancelId: 1,
  })
  if (response !== 0) return

  const secret = await new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], (err, stdout) =>
      resolve(err ? null : stdout.trim()),
    )
  })
  if (!secret) {
    return dialog.showMessageBox(parent, {
      type: 'warning',
      message: t('Chrome’s passwords stayed locked'),
      detail: t('Sade was not allowed to read Chrome’s key in the Keychain.'),
    })
  }

  const key = chromeKey(secret)
  let imported = 0
  let skipped = 0
  try {
    for (const profile of profiles) {
      const result = await importChromeProfile(path.join(root, profile), key)
      imported += result.imported
      skipped += result.skipped
    }
  } catch (err) {
    return dialog.showMessageBox(parent, { type: 'warning', message: t('Couldn’t import from {0}', 'Chrome'), detail: err.message })
  }
  store.flush()
  dialog.showMessageBox(parent, {
    message: imported ? t('Imported {0} passwords', imported) : t('No passwords were found in Chrome.'),
    detail: skipped ? t('{0} could not be decrypted and were skipped.', skipped) : '',
  })
}

function keychainMissing(parent) {
  dialog.showMessageBox(parent, {
    type: 'warning',
    message: t('Passwords can’t be saved'),
    detail: t('The macOS Keychain is not available, so Sade cannot encrypt them.'),
  })
}

// ------------------------------------------------------------ tab plumbing

function register(BrowserWin, onChange) {
  // Who is asking: only the main frame of a normal web page in one of our tabs.
  const context = (event) => {
    const owner = BrowserWin.from(event.sender)
    const tab = owner?.byWc(event.sender)
    const frame = event.senderFrame
    if (!tab || !frame || frame !== event.sender.mainFrame) return null
    let origin
    try {
      const url = new URL(frame.url)
      if (!/^https?:$/.test(url.protocol)) return null
      origin = url.origin
    } catch {
      return null
    }
    return { owner, tab, frame, origin }
  }

  // A username typed on its own page (two-step sign-ins).
  ipcMain.on('pw:user', (event, username) => {
    const ctx = context(event)
    if (ctx) ctx.tab.pwUser = { origin: ctx.origin, username: String(username).slice(0, 200) }
  })

  // A sign-in form was submitted: offer to save, a moment later.
  ipcMain.on('pw:candidate', (event, candidate) => {
    const ctx = context(event)
    if (!ctx || ctx.owner.isPrivate || !available()) return
    const password = String(candidate?.password || '')
    if (!password || password.length > 500) return
    let username = String(candidate?.username || '').slice(0, 200)
    if (!username && ctx.tab.pwUser?.origin === ctx.origin) username = ctx.tab.pwUser.username
    if (store.data.never.includes(ctx.origin)) return
    const existing = forOrigin(ctx.origin).find((e) => e.username === username)
    if (existing && decrypt(existing) === password) return

    const { owner, tab, origin } = ctx
    clearTimeout(tab.pwTimer)
    tab.pwTimer = setTimeout(async () => {
      if (owner.win.isDestroyed() || !owner.tabs.includes(tab)) return
      const { response } = await dialog.showMessageBox(owner.win, {
        message: existing ? t('Update password for {0}?', host(origin)) : t('Save password for {0}?', host(origin)),
        detail: username || t('(no user name)'),
        buttons: [existing ? t('Update') : t('Save'), t('Not Now'), t('Never for This Site')],
        cancelId: 1,
      })
      if (response === 0) {
        save(origin, username, password)
        owner.toast(existing ? t('Password updated') : t('Password saved'))
      }
      if (response === 2) {
        store.data.never.push(origin)
        store.save()
      }
      if (response !== 1) onChange()
    }, 2500)
  })

  // The user clicked an empty sign-in field: show the accounts saved for this site.
  ipcMain.on('pw:focus', (event, info) => {
    const ctx = context(event)
    if (!ctx || !available()) return
    const zoom = event.sender.getZoomFactor()
    offer(ctx, {
      isNew: !!info?.isNew,
      x: Math.round(Number(info?.x || 0) * zoom),
      y: Math.round(Number(info?.y || 0) * zoom) + BAR + 4,
      quiet: true,
    })
  })

  function offer({ owner, frame, origin }, { isNew, x, y, quiet }) {
    const entries = forOrigin(origin)
    if (quiet && !entries.length && !isNew) return
    const send = (payload) => {
      // The page may have navigated while the menu was open.
      if (frame.isDestroyed() || frame.origin !== origin) return
      frame.send('pw:fill', payload)
    }
    const items = entries.map((entry) => ({
      label: entry.username || t('(no user name)'),
      click: () => send({ username: entry.username, password: decrypt(entry) }),
    }))
    if (isNew || !quiet) {
      if (items.length) items.push({ type: 'separator' })
      items.push({ label: t('Use Strong Password'), click: () => send({ password: strongPassword(), generated: true }) })
    }
    items.push({ type: 'separator' }, { label: t('Manage Passwords…'), click: () => owner.openLibrary('passwords') })
    Menu.buildFromTemplate(items).popup({ window: owner.win, ...(x === undefined ? {} : { x, y }) })
  }

  // From the page's right-click menu, on any editable field.
  function offerFromContextMenu(owner, tab) {
    const frame = tab.view.webContents.mainFrame
    let origin
    try {
      const url = new URL(frame.url)
      if (!/^https?:$/.test(url.protocol)) return
      origin = url.origin
    } catch {
      return
    }
    if (!available()) return keychainMissing(owner.win)
    offer({ owner, frame, origin }, { isNew: false, quiet: false })
  }

  // The Passwords section of the library page.
  const lib = {
    'passwords.list': () => ({
      available: available(),
      entries: store.data.entries.map(({ id, origin, username }) => ({ id, origin, username })),
      never: store.data.never,
    }),
    'passwords.reveal': async (id) => (byId(id) && (await unlock()) ? decrypt(byId(id)) : null),
    'passwords.copy': async (id) => {
      if (!byId(id) || !(await unlock())) return false
      const password = decrypt(byId(id))
      clipboard.writeText(password)
      // Don't leave it on the clipboard for long.
      setTimeout(() => clipboard.readText() === password && clipboard.clear(), 60 * 1000)
      return true
    },
    'passwords.remove': (id) => (remove(String(id)), onChange()),
    'passwords.allow': (origin) => {
      store.data.never = store.data.never.filter((o) => o !== origin)
      store.save()
      onChange()
    },
    'passwords.import': async (source, owner) => {
      const run = { chrome: importFromChrome, safari: importFromSafari, csv: importFromFile }[source]
      await run?.(owner?.win)
      onChange()
    },
  }

  return { lib, offerFromContextMenu }
}

module.exports = { init, register, flush: () => store?.flush(), _test: { save, forOrigin, decrypt, importCsv, strongPassword, chromeKey, importChromeProfile } }
