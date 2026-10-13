// Runs in every tab. Web pages get nothing from it except swipe navigation;
// only Sade's own library page (sade://) is handed an API.
const { contextBridge, ipcRenderer } = require('electron')

if (location.protocol === 'sade:') {
  contextBridge.exposeInMainWorld('sadeLib', {
    call: (op, ...args) => ipcRenderer.invoke('lib', op, ...args),
    onChange: (listener) => ipcRenderer.on('lib:changed', () => listener()),
    onFocusSearch: (listener) => ipcRenderer.on('dash:focus', (_event, text) => listener(text)),
  })
}

// Two-finger horizontal swipe = back/forward, like Safari and Chrome. Only when
// neither the page nor anything under the pointer can use the scroll itself.
function canScrollX(node, deltaX) {
  for (let el = node instanceof Element ? node : node?.parentElement; el; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue
    const overflow = getComputedStyle(el).overflowX
    const scrolls = overflow === 'auto' || overflow === 'scroll' || el === document.scrollingElement
    if (!scrolls) continue
    if (deltaX < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true
  }
  return false
}

const SWIPE_DISTANCE = 240
let canGo = { back: false, forward: false } // kept current by the main process
ipcRenderer.on('nav:state', (_event, next) => {
  canGo = next
})

// A round arrow that slides in from the edge as the swipe builds up and turns
// blue once letting go will navigate. It lives in a closed shadow root so the
// page's own styles and scripts cannot touch it.
let hint = null
function showHint(direction, progress, armed) {
  if (!hint) {
    const holder = document.createElement('div')
    const dot = document.createElement('div')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '18')
    svg.setAttribute('height', '18')
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', '#fff')
    path.setAttribute('stroke-width', '1.8')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.append(path)
    dot.append(svg)
    Object.assign(dot.style, {
      position: 'fixed',
      top: '50%',
      width: '40px',
      height: '40px',
      marginTop: '-20px',
      borderRadius: '50%',
      display: 'grid',
      placeItems: 'center',
      zIndex: '2147483647',
      pointerEvents: 'none',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
      transition: 'transform 0.09s linear, background-color 0.15s, opacity 0.2s',
    })
    holder.attachShadow({ mode: 'closed' }).append(dot)
    document.documentElement.append(holder)
    hint = { holder, dot, path }
  }
  const back = direction === 'back'
  const { dot, path } = hint
  path.setAttribute('d', back ? 'M10 3 5 8l5 5' : 'm6 3 5 5-5 5')
  dot.style.left = back ? '0' : 'auto'
  dot.style.right = back ? 'auto' : '0'
  const travel = -46 + progress * 62 // from just off-screen to 16px inside the edge
  dot.style.transform = `translateX(${back ? travel : -travel}px) scale(${armed ? 1.12 : 0.85 + progress * 0.15})`
  dot.style.opacity = String(Math.min(1, progress * 1.6))
  dot.style.backgroundColor = armed ? '#0a84ff' : 'rgba(40, 40, 44, 0.86)'
}
function hideHint() {
  if (!hint) return
  const { holder, dot } = hint
  hint = null
  dot.style.opacity = '0'
  setTimeout(() => holder.remove(), 220)
}

let travelled = 0
let fired = false
let gestureEnd = null
window.addEventListener(
  'wheel',
  (event) => {
    if (!event.isTrusted || event.ctrlKey) return
    clearTimeout(gestureEnd)
    gestureEnd = setTimeout(() => {
      travelled = 0
      fired = false
      hideHint()
    }, 200)
    if (fired) return
    const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY) * 2
    if (event.defaultPrevented || !sideways || canScrollX(event.target, event.deltaX)) {
      travelled = 0
      return hideHint()
    }
    travelled += event.deltaX
    const direction = travelled < 0 ? 'back' : 'forward'
    if (!canGo[direction]) return hideHint()
    const progress = Math.min(1, Math.abs(travelled) / SWIPE_DISTANCE)
    fired = progress === 1
    showHint(direction, progress, fired)
    if (fired) ipcRenderer.send('nav:swipe', direction)
  },
  { passive: true },
)

// ---------------------------------------------------------------- passwords
// This script only reports sign-in forms and fills what the main process sends
// after the user picks an account; it never asks for stored passwords itself.

const TEXTY = new Set(['text', 'email', 'tel', ''])
const isPassword = (el) => el instanceof HTMLInputElement && el.type === 'password'
const isVisible = (el) => el.getClientRects().length > 0
const looksLikeUser = (el) =>
  el.type === 'email' || /user|email|login|account|phone/i.test(`${el.name} ${el.id} ${el.autocomplete}`)

// The field holding the account name: one tagged as such, else the last text
// field before the password field.
function usernameField(scope, password) {
  const fields = [...scope.querySelectorAll('input')].filter((el) => TEXTY.has(el.type) && isVisible(el))
  const tagged = fields.find((el) => /username|email/.test(el.autocomplete))
  if (tagged) return tagged
  if (!password) return fields.find(looksLikeUser) || null
  let best = null
  for (const el of fields) if (el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) best = el
  return best
}

// Set a value the way typing would, so frameworks watching the field notice.
function setValue(el, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

let lastReported = ''
function report(scope) {
  const filled = [...scope.querySelectorAll('input[type=password]')].filter((el) => el.value)
  if (!filled.length) {
    const user = usernameField(scope, null)
    if (user?.value) ipcRenderer.send('pw:user', user.value)
    return
  }
  // Sign-up and change-password forms repeat the new password; prefer that one.
  const values = filled.map((el) => el.value)
  const password = values.find((value, index) => values.indexOf(value) !== index) || values.at(-1)
  const username = usernameField(scope, filled[0])?.value || ''
  const key = `${username}\n${password}`
  if (key === lastReported) return
  lastReported = key
  ipcRenderer.send('pw:candidate', { username, password })
}

window.addEventListener('submit', (event) => event.target instanceof HTMLFormElement && report(event.target), true)
window.addEventListener(
  'keydown',
  (event) => {
    if (event.isTrusted && event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      report(event.target.form || document)
    }
  },
  true,
)

let lastField = null
window.addEventListener(
  'click',
  (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return
    // Many sign-in forms never fire "submit"; a button press is the next best signal.
    const button = event.target.closest('button, input[type=submit], input[type=button], [role=button]')
    if (button) return report(button.closest('form') || document)

    // Clicking an empty sign-in field offers the saved accounts.
    const el = event.target
    if (!(el instanceof HTMLInputElement) || el.value || el.readOnly || el.disabled) return
    const scope = el.form || document
    const password = scope.querySelector('input[type=password]')
    const isLoginField = isPassword(el) || (TEXTY.has(el.type) && (password ? usernameField(scope, password) === el : looksLikeUser(el)))
    if (!isLoginField) return
    lastField = el
    const rect = el.getBoundingClientRect()
    ipcRenderer.send('pw:focus', {
      isNew: isPassword(el) && /new-password/.test(el.autocomplete),
      x: rect.left,
      y: rect.bottom,
    })
  },
  true,
)

ipcRenderer.on('pw:fill', (_event, { username, password, generated }) => {
  const field = lastField?.isConnected ? lastField : document.activeElement
  if (!(field instanceof HTMLInputElement)) return
  const scope = field.form || document
  const passwordFields = [...scope.querySelectorAll('input[type=password]')].filter(isVisible)
  if (generated) {
    // New password and its "confirm" twin.
    for (const el of passwordFields) if (!el.value || el === field) setValue(el, password)
    return
  }
  const user = isPassword(field) ? usernameField(scope, passwordFields[0]) : field
  if (user && username) setValue(user, username)
  if (passwordFields[0]) setValue(passwordFields[0], password)
})
