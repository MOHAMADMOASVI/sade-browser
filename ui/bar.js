const $ = (id) => document.getElementById(id)
const tabsEl = $('tabs')
const elements = new Map()
let state = { tabs: [] }
let t = sadeStrings.translator('en')
let lang = null
let firstRender = true
let previous = {} // what the last render showed, to tell a change from a tab switch
let drag = null

const calm = matchMedia('(prefers-reduced-motion: reduce)')
// Tabs still in the strip, leaving out the ones animating away.
const liveTabs = () => [...tabsEl.children].filter((el) => !el.classList.contains('closing'))
// Where a tab sits in the layout, ignoring any transform currently applied to it.
const naturalLeft = (el) => tabsEl.getBoundingClientRect().left + el.offsetLeft

const CLOSE = '<svg viewBox="0 0 8 8"><path d="M1 1l6 6M7 1 1 7"/></svg>'
const STAR = '<svg viewBox="0 0 16 16"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg>'

function fade(el, duration = 220) {
  if (!calm.matches) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'ease-out' })
}

// After a reorder, glide every tab from where it was to where it is now.
function slide(before) {
  if (calm.matches) return
  for (const [id, el] of elements) {
    if (drag?.moving && id === drag.id) continue // the dragged tab follows the pointer instead
    const from = before.get(id)
    if (from === undefined) continue
    const delta = from - el.getBoundingClientRect().left
    if (Math.abs(delta) < 1) continue
    el.animate([{ transform: `translateX(${delta}px)` }, { transform: 'none' }], {
      duration: 220,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    })
  }
}

// kind: 'soft', 'hard' or null. When the reload ends the icon completes its
// current turn before going back to grey, so a fast reload is still visible.
let reloadShown = null
let spin = null // the running rotation; its playbackRate follows the connection speed
const TURN_MS = 1000

// How long one turn takes at a given download speed: 2.6s on a crawling connection
// (or while still waiting for the first byte), down to 0.35s at 3 MB/s and above.
function turnDuration(bytesPerSecond) {
  const slow = Math.log10(20e3)
  const fast = Math.log10(3e6)
  const pace = Math.max(0, Math.min(1, (Math.log10(Math.max(bytesPerSecond, 1)) - slow) / (fast - slow)))
  return 2600 * (350 / 2600) ** pace
}

function showReload(kind) {
  const button = $('reload')
  const svg = button.querySelector('svg')
  if (kind === reloadShown) return
  reloadShown = kind
  if (kind) {
    button.classList.remove('soft', 'hard')
    button.classList.add(kind)
    if (calm.matches) return
    spin?.cancel()
    spin = svg.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
      duration: TURN_MS,
      iterations: Infinity,
    })
    spin.playbackRate = TURN_MS / turnDuration(0)
    return
  }
  // Done: coast through the rest of the current turn, then back to the arrow.
  const finish = () => !reloadShown && button.classList.remove('soft', 'hard')
  if (!spin) return finish()
  const angle = ((spin.currentTime % TURN_MS) / TURN_MS) * 360
  spin.cancel()
  spin = null
  svg.animate([{ transform: `rotate(${angle}deg)` }, { transform: 'rotate(360deg)' }], {
    duration: 260 + (360 - angle),
    easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)',
  }).onfinish = finish
}

// The measured speed arrives a few times a second; ease toward it so the icon
// speeds up and slows down smoothly instead of lurching.
sade.on('reload:speed', (bytesPerSecond) => {
  if (!spin) return
  const target = TURN_MS / turnDuration(bytesPerSecond)
  spin.updatePlaybackRate(spin.playbackRate + (target - spin.playbackRate) * 0.45)
})

function host(url) {
  try {
    const u = new URL(url)
    return u.protocol.startsWith('http') ? u.hostname.replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

function createTabElement(id) {
  const el = document.createElement('div')
  el.className = 'tab'
  el.dataset.id = id
  el.innerHTML = `<img class="fav" hidden draggable="false" /><span class="dot"></span><span class="label" dir="auto"></span><input class="address" spellcheck="false" autocomplete="off" dir="ltr" hidden /><button class="star" hidden>${STAR}</button><button class="close">${CLOSE}</button>`
  const img = el.querySelector('.fav')
  img.addEventListener('load', () => fade(img))
  img.addEventListener('error', () => {
    img.hidden = true
    el.querySelector('.dot').hidden = false
  })
  return el
}

function applyLanguage() {
  t = sadeStrings.translator(lang)
  $('back').title = t('Back')
  $('forward').title = t('Forward')
  $('reload').title = `${t('Reload')}  ·  ⇧ ${t('Force Reload')}`
  $('new').title = t('New Tab')
  $('settings').title = t('Settings')
  $('private').textContent = t('Private')
  $('find-input').placeholder = t('Find')
}

function render() {
  if (state.lang !== lang) {
    lang = state.lang
    applyLanguage()
  }
  document.body.classList.toggle('fullscreen', !!state.fullscreen)
  document.body.classList.toggle('private', !!state.isPrivate)
  document.body.classList.toggle('inactive', state.focused === false)
  $('private').hidden = !state.isPrivate
  $('actions').hidden = !!state.isPrivate
  $('back').disabled = !state.canBack
  $('forward').disabled = !state.canForward
  showReload(state.reloading)

  const ids = new Set(state.tabs.map((tab) => tab.id))
  for (const [id, el] of elements) {
    if (ids.has(id)) continue
    elements.delete(id)
    // Collapse the tab, then take it out of the strip.
    el.classList.add('closing')
    el.addEventListener('animationend', () => el.remove(), { once: true })
    setTimeout(() => el.remove(), 400)
  }
  const before = new Map([...elements].map(([id, el]) => [id, el.getBoundingClientRect().left]))
  let reordered = false
  let activeUrl = ''
  state.tabs.forEach((tab, index) => {
    let el = elements.get(tab.id)
    if (!el) {
      elements.set(tab.id, (el = createTabElement(tab.id)))
      if (!firstRender) {
        el.classList.add('opening')
        el.addEventListener('animationend', () => el.classList.remove('opening'), { once: true })
      }
    }
    const live = liveTabs()
    if (live[index] !== el) {
      if (el.isConnected) reordered = true
      tabsEl.insertBefore(el, live[index] || null)
    }

    const isActive = tab.id === state.activeId
    if (isActive) activeUrl = tab.url
    el.classList.toggle('active', isActive)
    el.classList.toggle('pinned', !!tab.pinned)
    el.classList.toggle('loading', !!tab.loading)
    el.title = tab.title || tab.url || ''
    el.querySelector('.close').title = t('Close Tab')

    const img = el.querySelector('.fav')
    if (tab.favicon && img.dataset.src !== tab.favicon) {
      img.dataset.src = tab.favicon
      img.src = tab.favicon
      img.hidden = false
    } else if (!tab.favicon) {
      delete img.dataset.src
      img.hidden = true
    }
    el.querySelector('.dot').hidden = !img.hidden

    // The active tab doubles as the address field: site first, page title after.
    const label = el.querySelector('.label')
    const site = host(tab.url)
    // Arriving at a different site is worth a soft fade; a changing title is not.
    if (el.dataset.site !== undefined && el.dataset.site !== site) fade(label, 260)
    el.dataset.site = site
    label.textContent = ''
    if (isActive && site) {
      label.append(site)
      if (tab.title && tab.title !== site) {
        const sub = document.createElement('span')
        sub.className = 'sub'
        sub.textContent = '  ' + tab.title
        label.append(sub)
      }
    } else {
      label.textContent = tab.title || site || (tab.url ? tab.url : t('New Tab'))
    }

    // A star marks a bookmarked page; it pops when the page has just been bookmarked.
    const star = el.querySelector('.star')
    const starred = isActive && !!state.bookmarked && !tab.pinned
    const justBookmarked =
      starred && star.hidden && previous.activeId === tab.id && previous.url === tab.url && previous.bookmarked === false
    star.hidden = !starred
    star.title = t('Remove bookmark')
    if (justBookmarked && !calm.matches) {
      star.animate(
        [
          { transform: 'scale(0) rotate(-40deg)', opacity: 0 },
          { transform: 'scale(1.5) rotate(8deg)', opacity: 1, offset: 0.6 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 420, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      )
    }
  })
  if (reordered) slide(before)
  if (editing && editing.id !== state.activeId) stopEditing(false)
  if (state.tabs.length) firstRender = false
  previous = { activeId: state.activeId, url: activeUrl, bookmarked: !!state.bookmarked, downloadDone: previous.downloadDone }

  $('actions').setAttribute('tab', state.activeWcId ?? '')

  // Download pill: a thin bar along its bottom edge fills as the file arrives.
  const dl = state.download
  const pill = $('download')
  pill.hidden = !dl
  if (dl) {
    pill.textContent = dl.done ? `✓ ${dl.name}` : `↓ ${Math.round(dl.progress * 100)}%  ${dl.name}`
    pill.title = dl.done ? t('Show in Finder') : t('Downloading…')
    pill.style.setProperty('--progress', dl.done ? 1 : dl.progress)
    pill.classList.toggle('done', !!dl.done)
    if (dl.done && previous.downloadDone === false && !calm.matches) {
      pill.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.08)', color: 'var(--good)' }, { transform: 'scale(1)' }],
        { duration: 520, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      )
    }
  }
  previous.downloadDone = dl ? !!dl.done : undefined
}

// Editing the address in place: the active tab's label becomes a text field
// holding the full address. Enter goes there in the same tab; Escape or clicking
// away puts the label back.
let editing = null // { id, el, input }
function startEditing() {
  const tab = state.tabs.find((candidate) => candidate.id === state.activeId)
  const el = tab && elements.get(tab.id)
  if (!el || tab.pinned || editing?.id === tab.id) return editing?.input.select()
  stopEditing(false)
  const input = el.querySelector('.address')
  editing = { id: tab.id, el, input }
  el.classList.add('editing')
  input.hidden = false
  input.value = /^(https?|file):/.test(tab.url) ? tab.url : ''
  input.placeholder = t('Search or enter address')
  input.focus()
  input.select()
}
function stopEditing(returnFocus) {
  if (!editing) return
  const { el, input } = editing
  editing = null
  el.classList.remove('editing')
  input.hidden = true
  if (returnFocus) sade.send('address:cancel')
}
tabsEl.addEventListener('keydown', (event) => {
  if (!editing || event.target !== editing.input) return
  if (event.key === 'Enter') {
    const text = editing.input.value
    stopEditing(false)
    sade.send('address:go', text)
  } else if (event.key === 'Escape') {
    stopEditing(true)
  }
})
tabsEl.addEventListener('focusout', (event) => editing && event.target === editing.input && stopEditing(false))
sade.on('address:edit', startEditing)

// Drag a tab sideways to reorder it. The tab lifts and follows the pointer; the
// move is committed as soon as it passes the middle of a neighbour, so the rest
// of the strip rearranges live.
let suppressClick = false
tabsEl.addEventListener('pointerdown', (event) => {
  const el = event.target.closest('.tab')
  if (!el || event.button !== 0 || event.target.closest('.close, .star, .address')) return
  drag = { id: Number(el.dataset.id), el, startX: event.clientX, grab: event.clientX - naturalLeft(el), moving: false }
})
tabsEl.addEventListener('pointermove', (event) => {
  if (!drag) return
  if (!drag.moving) {
    if (Math.abs(event.clientX - drag.startX) < 6) return
    drag.moving = true
    // Capture only once a drag is certain: capturing on press would steal the
    // click from the tab (and its buttons) on a plain press-and-release.
    tabsEl.setPointerCapture(event.pointerId)
    tabsEl.classList.add('dragging')
    drag.el.classList.add('dragged')
  }
  const from = state.tabs.findIndex((tab) => tab.id === drag.id)
  if (from < 0) return

  // The furthest neighbour (in the same pinned/unpinned group) whose middle the pointer has passed.
  const children = liveTabs()
  let target = from
  children.forEach((child, index) => {
    if (index === from || !!state.tabs[index]?.pinned !== !!state.tabs[from].pinned) return
    const middle = naturalLeft(child) + child.offsetWidth / 2
    if (index > from && event.clientX > middle) target = Math.max(target, index)
    if (index < from && event.clientX < middle) target = target === from ? index : Math.min(target, index)
  })
  if (target !== from) {
    // Reorder locally right away so repeated pointer events don't re-send the move.
    const [moved] = state.tabs.splice(from, 1)
    state.tabs.splice(target, 0, moved)
    render()
    sade.send('tab:move', drag.id, target)
  }

  const strip = tabsEl.getBoundingClientRect()
  const left = Math.max(strip.left - 6, Math.min(strip.right - drag.el.offsetWidth + 6, event.clientX - drag.grab))
  drag.el.style.transform = `translateX(${left - naturalLeft(drag.el)}px) scale(1.03)`
})
const endDrag = () => {
  if (drag?.moving) {
    suppressClick = true
    const el = drag.el
    // Settle back into the slot.
    el.classList.add('settling')
    el.style.transform = ''
    setTimeout(() => el.classList.remove('dragged', 'settling'), 240)
  }
  drag = null
  tabsEl.classList.remove('dragging')
  setTimeout(() => (suppressClick = false))
}
window.addEventListener('pointerup', endDrag)
window.addEventListener('pointercancel', endDrag)
tabsEl.addEventListener('contextmenu', (event) => {
  const el = event.target.closest('.tab')
  if (el) sade.send('tab:menu', Number(el.dataset.id))
})

tabsEl.addEventListener('click', (event) => {
  const el = event.target.closest('.tab')
  if (!el || suppressClick || event.target.closest('.address')) return
  const id = Number(el.dataset.id)
  if (event.target.closest('.close')) sade.send('tab:close', id)
  else if (event.target.closest('.star')) sade.send('bookmark:toggle')
  else if (id === state.activeId) {
    // On the dashboard the search field is the place to type; elsewhere, edit in place.
    const tab = state.tabs.find((candidate) => candidate.id === id)
    if (tab?.url.startsWith('sade://app/dashboard.html') || tab?.pinned) sade.send('search:focus')
    else startEditing()
  }
  else sade.send('tab:select', id)
})
tabsEl.addEventListener('auxclick', (event) => {
  const el = event.target.closest('.tab')
  if (el && event.button === 1) sade.send('tab:close', Number(el.dataset.id))
})
$('back').addEventListener('click', () => sade.send('nav:back'))
$('forward').addEventListener('click', () => sade.send('nav:forward'))
// Click reloads; Shift-click (or Option-click) reloads without the cache.
$('reload').addEventListener('click', (event) => sade.send('nav:reload', event.shiftKey || event.altKey))
$('new').addEventListener('click', () => sade.send('tab:new'))
$('settings').addEventListener('click', () => sade.send('settings:open'))
$('download').addEventListener('click', () => sade.send('download:reveal'))

// Show an element with its entrance animation; hide it with a short exit.
function leave(el, after) {
  if (el.hidden) return
  if (calm.matches) {
    el.hidden = true
    return after?.()
  }
  el.classList.add('leaving')
  setTimeout(() => {
    el.hidden = true
    el.classList.remove('leaving')
    after?.()
  }, 150)
}

const find = $('find')
const findInput = $('find-input')
function hideFind(notify) {
  if (find.hidden) return
  $('find-count').textContent = ''
  find.classList.remove('nomatch')
  leave(find)
  if (notify) sade.send('find:stop')
}
findInput.addEventListener('input', () => {
  if (!findInput.value) {
    $('find-count').textContent = ''
    find.classList.remove('nomatch')
  }
  sade.send('find:query', findInput.value, true, false)
})
findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sade.send('find:query', findInput.value, !event.shiftKey, true)
  if (event.key === 'Escape') hideFind(true)
})

let toastTimer = null
sade.on('toast', (text) => {
  const el = $('toast')
  clearTimeout(toastTimer)
  el.classList.remove('leaving')
  el.textContent = text
  // Restart the entrance even when a toast is already showing.
  el.hidden = true
  void el.offsetWidth
  el.hidden = false
  toastTimer = setTimeout(() => leave(el), 1700)
})

sade.on('state', (next) => {
  state = next
  render()
})
sade.on('find:show', () => {
  find.classList.remove('leaving')
  find.hidden = false
  findInput.focus()
  findInput.select()
  if (findInput.value) sade.send('find:query', findInput.value, true, false)
})
sade.on('find:hide', () => hideFind(false))
sade.on('find:result', ({ current, total, final }) => {
  $('find-count').textContent = findInput.value ? `${current}/${total}` : ''
  if (!final) return
  // Nothing found: the box turns red and shakes its head once.
  const missed = !!findInput.value && total === 0
  if (missed && !find.classList.contains('nomatch') && !calm.matches) {
    find.animate(
      [0, -5, 5, -3, 3, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: 300, easing: 'ease-out' },
    )
  }
  find.classList.toggle('nomatch', missed)
})
