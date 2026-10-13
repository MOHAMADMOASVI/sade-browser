const list = document.getElementById('list')
const search = document.getElementById('search')
const empty = document.getElementById('empty')
const clear = document.getElementById('clear')
const lib = window.sadeLib
let t = sadeStrings.translator('en')
let lang = 'en'

const SECTIONS = ['bookmarks', 'history', 'downloads', 'passwords', 'permissions', 'settings']
const SECTION_NAMES = { bookmarks: 'Bookmarks', history: 'History', downloads: 'Downloads', passwords: 'Passwords', permissions: 'Permissions', settings: 'Settings' }
const PERMISSION_NAMES = {
  media: 'Camera and microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  'clipboard-read': 'Clipboard',
  midi: 'MIDI devices',
  midiSysex: 'MIDI devices',
}
let section = 'bookmarks'
let historyLimit = 300
let editing = null // URL of the bookmark being edited
let renderTicket = 0
let entering = false
let pillPlaced = false
const revealed = new Map() // password id → plain text, shown briefly
let copied = null
let flash = null // password id whose value just changed on screen
const calm = matchMedia('(prefers-reduced-motion: reduce)')

// Collapse a row (or the edit form) before it goes, so the list closes up
// smoothly instead of jumping.
function vanish(node, then) {
  if (calm.matches || !node?.isConnected) return then()
  const height = `${node.offsetHeight}px`
  node.style.overflow = 'hidden'
  node.animate(
    [
      { height, minHeight: height, opacity: 1 },
      { height: '0px', minHeight: '0px', paddingBlock: '0px', opacity: 0 },
    ],
    { duration: 190, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards' },
  ).onfinish = then
}

// Close the bookmark edit form, if one is open, then redraw.
function closeEdit() {
  editing = null
  vanish(list.querySelector('.edit'), render)
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'onclick') node.addEventListener('click', value)
    else if (key === 'class') node.className = value
    else node[key] = value
  }
  node.append(...children.filter((child) => child != null))
  return node
}

function short(url) {
  let text = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
  try {
    text = decodeURI(text)
  } catch {}
  return text
}

const matches = (text) =>
  search.value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => text.toLowerCase().includes(term))

function dayLabel(time) {
  const day = new Date(time)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86400e3)
  if (day.toDateString() === today.toDateString()) return t('Today')
  if (day.toDateString() === yesterday.toDateString()) return t('Yesterday')
  return day.toLocaleDateString(lang, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

function size(bytes) {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (bytes >= 1000 && i < units.length - 1) {
    bytes /= 1000
    i++
  }
  return `${bytes.toFixed(bytes < 10 && i ? 1 : 0)} ${units[i]}`
}

// A settings line: label and explanation on the left, one control on the right.
function setting(title, sub, control) {
  return el(
    'div',
    { class: 'row setting' },
    el('div', { class: 'main' }, el('span', { class: 'title', textContent: title }), el('span', { class: 'sub', textContent: sub })),
    control,
  )
}

function choice(key, current, options) {
  const select = el('select')
  for (const [value, label] of options) select.append(el('option', { value: String(value), textContent: label, selected: value === current }))
  select.addEventListener('change', () => {
    const picked = options.find(([value]) => String(value) === select.value)
    lib.call('settings.set', key, picked[0])
  })
  return select
}

const action = (label, name, arg) => el('button', { textContent: label, onclick: () => lib.call('settings.run', name, arg) })

function row({ href, title, sub, meta, metaClass = '', actions = [], className = '' }) {
  const main = el(
    href ? 'a' : 'div',
    { class: 'main', ...(href ? { href } : {}) },
    el('span', { class: 'title', dir: 'auto', textContent: title }),
    el('span', { class: 'sub', textContent: sub || '' }),
  )
  const node = el(
    'div',
    { class: 'row ' + className },
    main,
    meta ? el('span', { class: 'meta ' + metaClass, textContent: meta }) : null,
  )
  // Each action is handed its row, so "remove" can animate it away first.
  node.append(
    el('div', { class: 'actions' }, ...actions.map(([label, run]) => el('button', { textContent: label, onclick: () => run(node) }))),
  )
  return node
}

const renderers = {
  async bookmarks() {
    const all = (await lib.call('bookmarks.list')).filter((b) => matches(`${b.title} ${b.url} ${b.folder || ''}`))
    const folders = new Map()
    for (const b of all) {
      const key = b.folder || ''
      if (!folders.has(key)) folders.set(key, [])
      folders.get(key).push(b)
    }
    const nodes = []
    for (const key of [...folders.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))) {
      if (key || folders.size > 1) nodes.push(el('h2', { textContent: key || t('No folder'), dir: 'auto' }))
      for (const b of folders.get(key)) {
        nodes.push(
          row({
            href: b.url,
            title: b.title,
            sub: short(b.url),
            actions: [
              [t('Edit'), () => (editing === b.url ? closeEdit() : ((editing = b.url), render()))],
              [t('Remove'), (node) => vanish(node, () => lib.call('bookmarks.remove', b.url))],
            ],
          }),
        )
        if (editing === b.url) {
          const title = el('input', { value: b.title, placeholder: t('Title'), dir: 'auto' })
          const folder = el('input', { value: b.folder || '', placeholder: t('Folder'), dir: 'auto' })
          const save = () => {
            editing = null
            vanish(form, () => lib.call('bookmarks.update', b.url, { title: title.value, folder: folder.value }))
          }
          const form = el('div', { class: 'edit' }, title, folder, el('button', { textContent: t('Save'), onclick: save }))
          form.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') save()
            if (event.key === 'Escape') closeEdit()
          })
          nodes.push(form)
        }
      }
    }
    return { nodes, empty: search.value ? t('No matching bookmarks') : t('No bookmarks yet — press ⌘D on any page') }
  },

  async history() {
    const { rows, total } = await lib.call('history.list', search.value, historyLimit)
    const nodes = []
    let lastDay = ''
    for (const h of rows) {
      const day = dayLabel(h.last)
      if (day !== lastDay) nodes.push(el('h2', { textContent: (lastDay = day) }))
      nodes.push(
        row({
          href: h.url,
          title: h.title || short(h.url),
          sub: short(h.url),
          meta: new Date(h.last).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }),
          actions: [[t('Remove'), (node) => vanish(node, () => lib.call('history.remove', h.url))]],
        }),
      )
    }
    if (total > rows.length) {
      nodes.push(
        el('button', {
          id: 'more',
          textContent: t('Show more ({0} older)', total - rows.length),
          onclick: () => ((historyLimit += 500), render()),
        }),
      )
    }
    return {
      nodes,
      empty: search.value ? t('No matching history') : t('No history yet'),
      clear: total && !search.value ? [t('Clear History'), () => confirm(t('Clear all history?')) && lib.call('history.clear')] : null,
    }
  },

  async downloads() {
    const all = (await lib.call('downloads.list')).filter((d) => matches(`${d.name} ${d.url}`))
    const nodes = all.map((d) => {
      const progress = d.total ? `${Math.round((d.received / d.total) * 100)}%` : size(d.received)
      const meta = d.state === 'progress' ? progress : d.state === 'failed' ? t('Failed') : size(d.total || d.received)
      const actions = []
      if (d.state === 'done') actions.push([t('Open'), () => lib.call('downloads.open', d.id)])
      if (d.state !== 'failed') actions.push([t('Show in Finder'), () => lib.call('downloads.reveal', d.id)])
      if (d.state !== 'progress') {
        actions.push([t('Remove from list'), (node) => vanish(node, () => lib.call('downloads.remove', d.id))])
      }
      return row({ title: d.name, sub: short(d.url), meta, actions, className: d.state === 'failed' ? 'failed' : '' })
    })
    return {
      nodes,
      empty: t('No downloads'),
      clear: all.some((d) => d.state !== 'progress') ? [t('Clear List'), () => lib.call('downloads.clear')] : null,
    }
  },

  async permissions() {
    const all = (await lib.call('permissions.list')).filter((p) => matches(p.origin))
    const nodes = all.map((p) =>
      row({
        title: short(p.origin),
        sub: PERMISSION_NAMES[p.permission] ? t(PERMISSION_NAMES[p.permission]) : p.permission,
        meta: p.allowed ? t('Allowed') : t('Blocked'),
        actions: [[t('Reset'), (node) => vanish(node, () => lib.call('permissions.remove', p.key))]],
      }),
    )
    return { nodes, empty: t('No site has asked for a permission yet') }
  },
}

renderers.passwords = async () => {
  const { entries, never, available } = await lib.call('passwords.list')
  const shown = entries
    .filter((e) => matches(`${e.origin} ${e.username}`))
    .sort((a, b) => short(a.origin).localeCompare(short(b.origin)))
  const reveal = async (id) => {
    flash = id
    if (revealed.has(id)) revealed.delete(id)
    else {
      const password = await lib.call('passwords.reveal', id)
      if (password == null) return
      revealed.set(id, password)
      setTimeout(() => revealed.delete(id) && render(), 20000)
    }
    render()
  }
  const copy = async (id) => {
    if (!(await lib.call('passwords.copy', id))) return
    copied = flash = id
    render()
    setTimeout(() => ((copied = null), (flash = id), render()), 1500)
  }
  const nodes = shown.map((e) =>
    row({
      title: short(e.origin),
      sub: e.username || t('(no user name)'),
      meta: copied === e.id ? t('Copied') : revealed.get(e.id) || '••••••••',
      metaClass: flash === e.id ? 'flash' : '',
      actions: [
        [t('Copy Password'), () => copy(e.id)],
        [revealed.has(e.id) ? t('Hide') : t('Show'), () => reveal(e.id)],
        [t('Remove'), (node) => vanish(node, () => lib.call('passwords.remove', e.id))],
      ],
    }),
  )
  const blocked = never.filter((origin) => matches(origin))
  if (blocked.length) {
    nodes.push(el('h2', { textContent: t('Never saved') }))
    for (const origin of blocked) {
      nodes.push(
        row({ title: short(origin), actions: [[t('Remove'), (node) => vanish(node, () => lib.call('passwords.allow', origin))]] }),
      )
    }
  }
  if (!shown.length) {
    const hint = !available
      ? t('The macOS Keychain is not available, so Sade cannot encrypt them.')
      : search.value
        ? t('No matching passwords')
        : t('No saved passwords yet — Sade offers to save them when you sign in')
    nodes.unshift(el('p', { class: 'hint', textContent: hint }))
  }
  if (available && !search.value) {
    const bring = (source) => el('button', { textContent: t('Import…'), onclick: () => lib.call('passwords.import', source) })
    nodes.push(
      el('h2', { textContent: t('Import passwords') }),
      setting(t('From Chrome'), t('macOS asks for your Mac password to unlock them'), bring('chrome')),
      setting(t('From Safari'), t('Through a file exported from the Passwords app'), bring('safari')),
      setting(t('From a CSV file'), t('Exported from any other password manager'), bring('csv')),
    )
  }
  return { nodes, empty: '' }
}

renderers.settings = async () => {
  const { settings, isDefault, extensions, languages } = await lib.call('settings.get')
  const nodes = [
    el('h2', { textContent: t('General') }),
    setting(t('Language'), t('Menus, pages and messages'), choice('language', settings.language, Object.entries(languages))),
    setting(
      t('Default browser'),
      isDefault ? t('Sade opens links from other apps') : t('Links from other apps open elsewhere'),
      isDefault ? el('span', { class: 'meta', textContent: t('Sade is the default') }) : action(t('Make Default…'), 'default-browser'),
    ),
    setting(
      t('Search engine'),
      t('Used when you type words instead of an address'),
      choice('search', settings.search, [
        ['google', 'Google'],
        ['duckduckgo', 'DuckDuckGo'],
        ['bing', 'Bing'],
      ]),
    ),
    setting(
      t('Appearance'),
      t('Private windows are always dark'),
      choice('theme', settings.theme, [
        ['system', t('Match system')],
        ['light', t('Light')],
        ['dark', t('Dark')],
      ]),
    ),
    setting(
      t('Open Sade from anywhere'),
      t('⌘M in any app shows or hides Sade, while Sade is running. It replaces “Minimize”.'),
      choice('summon', settings.summon, [
        [false, t('Off')],
        [true, t('On')],
      ]),
    ),
    setting(
      t('When Sade opens'),
      t('Restored tabs load only when you switch to them'),
      choice('restore', settings.restore, [
        [true, t('Restore last tabs')],
        [false, t('Start with a new tab')],
      ]),
    ),
    el('h2', { textContent: t('Your data') }),
    setting(t('Import from Chrome'), t('Bookmarks and history'), action(t('Import…'), 'import-chrome')),
    setting(t('Import from Safari'), t('Bookmarks and history; needs Full Disk Access'), action(t('Import…'), 'import-safari')),
    setting(t('History'), t('Remove every page Sade remembers visiting'), action(t('Clear History…'), 'clear-history')),
    el('h2', { textContent: t('Extensions') }),
    ...extensions.map((ext) => setting(ext.name, ext.version, action(t('Remove'), 'remove-extension', ext.id))),
    setting(t('Chrome Web Store'), t('Not every extension works fully in Sade'), action(t('Open Store'), 'web-store')),
  ]
  return { nodes, empty: '' }
}

async function render() {
  const ticket = ++renderTicket
  const result = await renderers[section]()
  if (ticket !== renderTicket) return
  list.replaceChildren(...result.nodes)
  flash = null
  // Play the entrance once per section visit, not on every data refresh.
  if (entering) {
    entering = false
    result.nodes.forEach((node, index) => node.style.setProperty('--i', index))
    list.classList.add('enter')
    setTimeout(() => list.classList.remove('enter'), 700)
  }
  empty.hidden = result.nodes.length > 0
  empty.textContent = result.empty
  clear.hidden = !result.clear
  if (result.clear) {
    clear.textContent = result.clear[0]
    clear.onclick = result.clear[1]
  }
  list.querySelector('.edit input')?.focus()
}

function applyLanguage() {
  t = sadeStrings.translator(lang)
  document.documentElement.lang = lang
  document.documentElement.dir = sadeStrings.direction(lang)
  for (const link of document.querySelectorAll('#nav a')) link.textContent = t(SECTION_NAMES[link.hash.slice(1)])
  search.placeholder = t('Filter')
  document.title = t(SECTION_NAMES[section])
  movePill(false)
}

// The highlight behind the section names slides from one to the next.
const pill = document.getElementById('pill')
function movePill(animate) {
  const current = document.querySelector('#nav a.current')
  if (!current) return
  pill.classList.toggle('instant', !animate)
  pill.style.left = `${current.offsetLeft}px`
  pill.style.width = `${current.offsetWidth}px`
  if (!animate) void pill.offsetWidth // commit the jump before transitions come back on
  pill.classList.remove('instant')
}
window.addEventListener('resize', () => movePill(false))
window.addEventListener('scroll', () => document.querySelector('header').classList.toggle('scrolled', scrollY > 4), {
  passive: true,
})

function route() {
  const wanted = location.hash.slice(1)
  section = SECTIONS.includes(wanted) ? wanted : 'bookmarks'
  for (const link of document.querySelectorAll('#nav a')) link.classList.toggle('current', link.hash === '#' + section)
  document.title = t(SECTION_NAMES[section])
  movePill(pillPlaced)
  pillPlaced = true
  historyLimit = 300
  editing = null
  revealed.clear()
  search.value = ''
  search.hidden = section === 'settings'
  entering = true
  render()
}

search.addEventListener('input', render)
window.addEventListener('hashchange', route)
lib.onChange(async () => {
  // A new language re-translates the page in place, with the entrance replayed.
  const chosen = (await lib.call('lang')) || 'en'
  if (chosen !== lang) {
    lang = chosen
    applyLanguage()
    entering = true
  }
  if (!editing) render()
})
lib.call('lang').then((chosen) => {
  lang = chosen || 'en'
  applyLanguage()
  route()
})
