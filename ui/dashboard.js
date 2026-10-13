const lib = window.sadeLib
const $ = (id) => document.getElementById(id)
let t = sadeStrings.translator('en')
let lang = 'en'
let first = true
let editingCity = false

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'onclick') node.addEventListener('click', value)
    else node[key] = value
  }
  node.append(...children.filter((child) => child != null))
  return node
}

const number = (value) => value.toLocaleString(lang, { useGrouping: false })
// A temperature, kept left-to-right so the degree sign stays after the digits in Persian.
const degrees = (value) => `⁦${number(value)}°⁩`

// A site's icon, falling back to its first letter if there is none or it fails.
function icon(item, small) {
  const box = el('span', { class: 'icon' + (small ? ' small' : ''), textContent: (item.host || '?')[0] })
  if (item.icon) {
    const img = el('img', { src: item.icon, alt: '' })
    img.addEventListener('load', () => box.replaceChildren(img))
  }
  return box
}

// ----------------------------------------------------------------- search
// The one place in Sade to type an address or a search.

const input = $('q')
const drop = $('suggestions')
const KIND = { tab: 'Switch to tab', bookmark: 'Bookmark', history: '', command: 'Command', search: 'Search', go: 'Open' }
const GLYPH = { tab: '▢', bookmark: '★', history: '↺', command: '⌘', search: '⌕', go: '→' }
let items = []
let selected = 0
let ticket = 0

function short(url) {
  let text = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
  try {
    text = decodeURI(text)
  } catch {}
  return text
}

function drawSuggestions() {
  drop.hidden = !items.length
  drop.replaceChildren(
    ...items.map((item, index) => {
      const mark = item.icon ? el('img', { src: item.icon, alt: '' }) : el('span', { class: 'glyph', textContent: GLYPH[item.kind] })
      const row = el(
        'div',
        { class: 'row' + (index === selected ? ' selected' : '') },
        mark,
        el('span', { class: 'title', dir: 'auto', textContent: item.title }),
        el('span', { class: 'url', dir: 'ltr', textContent: item.url && item.kind !== 'search' && item.kind !== 'go' ? short(item.url) : '' }),
        el('span', { class: 'kind', textContent: KIND[item.kind] ? t(KIND[item.kind]) : '' }),
      )
      row.addEventListener('mousemove', () => {
        if (selected === index) return
        selected = index
        for (const [i, node] of [...drop.children].entries()) node.classList.toggle('selected', i === selected)
      })
      // mousedown, not click: the field must not lose focus before the pick lands.
      row.addEventListener('mousedown', (event) => {
        event.preventDefault()
        pick(item)
      })
      return row
    }),
  )
}

async function suggest() {
  const mine = ++ticket
  const next = input.value.trim() ? await lib.call('dashboard.suggest', input.value) : []
  if (mine !== ticket) return
  items = next || []
  selected = 0
  drawSuggestions()
}

function pick(item) {
  lib.call('dashboard.pick', item)
  // Switching tabs or running a command leaves this page open: start clean.
  input.value = ''
  items = []
  ticket++
  drawSuggestions()
}

function focusSearch(text = '') {
  input.value = text
  input.focus()
  input.select()
  suggest()
}

input.addEventListener('input', suggest)
input.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!items.length) return
    selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    drawSuggestions()
  } else if (event.key === 'Enter') {
    if (items[selected]) pick(items[selected])
  } else if (event.key === 'Escape') {
    if (input.value) focusSearch('')
    else input.blur()
  }
})
input.addEventListener('blur', () => {
  items = []
  ticket++
  drawSuggestions()
})
input.addEventListener('focus', () => input.value.trim() && suggest())
// Typing anywhere on the page goes to the field.
window.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLInputElement
  if (!typing && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) input.focus()
})
lib.onFocusSearch(focusSearch)

// ------------------------------------------------------------------- date

// Today in the reader's own calendar, with the other two calendars beneath.
function dates() {
  const now = new Date()
  const own = lang === 'fa' ? 'persian' : 'gregory'
  const format = (calendar, options) => now.toLocaleDateString(`${lang}-u-ca-${calendar}`, options)
  $('weekday').textContent = format(own, { weekday: 'long' })
  $('day').textContent = format(own, { day: 'numeric', month: 'long' })
  $('other-dates').textContent = ['persian', 'gregory', 'islamic-umalqura']
    .filter((calendar) => calendar !== own)
    .map((calendar) => format(calendar, { day: 'numeric', month: 'long', year: 'numeric' }))
    .join('   ·   ')
  input.placeholder = t('What are you looking for?')
}

// --------------------------------------------------------------- occasion

// Today's occasion; when there is none, the next one and how far off it is.
function occasion() {
  const now = new Date()
  const today = sadeOccasions.on(now, lang)
  const node = $('occasion')
  if (today.length) {
    node.replaceChildren(el('span', { class: 'dot' }), el('span', { dir: 'auto', textContent: today.join('، ') }))
    return
  }
  const [next] = sadeOccasions.upcoming(now, lang, 1)
  if (!next) return node.replaceChildren()
  const when =
    next.days === 1
      ? t('Tomorrow')
      : next.days <= 10
        ? t('in {0} days', number(next.days))
        : next.date.toLocaleDateString(lang, { day: 'numeric', month: 'short' })
  node.replaceChildren(el('span', { class: 'dim', textContent: `${when}  ` }), el('span', { dir: 'auto', textContent: next.names.join('، ') }))
}

// ---------------------------------------------------------------- weather

// WMO weather code → [emoji, description]
function describe(code, night) {
  const sky = (day, dark) => (night ? dark : day)
  if (code === 0) return [sky('☀️', '🌙'), 'Clear sky']
  if (code <= 2) return [sky('🌤️', '☁️'), 'Partly cloudy']
  if (code === 3) return ['☁️', 'Cloudy']
  if (code <= 48) return ['🌫️', 'Fog']
  if (code <= 57) return ['🌦️', 'Drizzle']
  if (code <= 67) return ['🌧️', 'Rain']
  if (code <= 77) return ['🌨️', 'Snow']
  if (code <= 82) return ['🌧️', 'Showers']
  if (code <= 86) return ['🌨️', 'Snow']
  return ['⛈️', 'Thunderstorm']
}

function cityForm(placeholder) {
  const field = el('input', { placeholder, dir: 'auto', spellcheck: false })
  const submit = async () => {
    if (!field.value.trim()) return
    $('weather').replaceChildren(el('span', { class: 'chip loading', textContent: '…' }))
    const result = await lib.call('dashboard.city', field.value)
    editingCity = false
    if (result?.notFound) return showWeather({ needsCity: true }, t('City not found'))
    showWeather(result)
  }
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit()
    if (event.key === 'Escape') {
      editingCity = false
      weather()
      input.focus()
    }
  })
  return el('span', { class: 'city-form' }, field, el('button', { textContent: t('Show'), onclick: submit }))
}

// One chip: sky, temperature, city. Its tooltip carries the detail and the next
// three days; clicking it changes the city.
function showWeather(w, note) {
  const slot = $('weather')
  if (editingCity || (w?.needsCity && note)) {
    slot.replaceChildren(cityForm(note || t('Your city')))
    return slot.querySelector('input').focus()
  }
  const edit = () => ((editingCity = true), showWeather(w))
  if (!w || w.needsCity) {
    return slot.replaceChildren(el('button', { class: 'chip', onclick: edit }, el('span', { class: 'dim', textContent: `${t('Weather')} — ${t('Your city')}` })))
  }
  if (w.error) {
    return slot.replaceChildren(
      el('button', { class: 'chip', title: t('Change city'), onclick: edit }, el('span', { class: 'dim', textContent: t('Weather is unavailable right now') })),
    )
  }
  const [glyph, text] = describe(w.now.code, w.now.night)
  const today = w.days[0]
  const forecast = w.days
    .slice(1)
    .map((day) => `${new Date(day.date + 'T12:00').toLocaleDateString(lang, { weekday: 'short' })}  ${degrees(day.high)} / ${degrees(day.low)}  ${t(describe(day.code)[1])}`)
  slot.replaceChildren(
    el(
      'button',
      {
        class: 'chip swap',
        title: [`${t(text)} · ${t('Feels like {0}', degrees(w.now.feels))} · ↑ ${degrees(today.high)} ↓ ${degrees(today.low)}`, ...forecast, '', t('Change city')].join('\n'),
        onclick: edit,
      },
      el('span', { class: 'glyph', textContent: glyph }),
      el('span', { textContent: degrees(w.now.temp) }),
      el('span', { class: 'dim', dir: 'auto', textContent: `${w.city} · ${t(text)}` }),
    ),
  )
}

async function weather() {
  if (editingCity) return
  showWeather(await lib.call('dashboard.weather'))
}

// ------------------------------------------------------------------ sites

function siteIcon(site, index, hint) {
  const node = el(
    'a',
    { class: 'site', href: site.url, title: hint },
    icon(site),
    el('span', { class: 'name', dir: 'ltr', textContent: site.host }),
  )
  node.style.setProperty('--i', index)
  return node
}

async function sites() {
  const d = await lib.call('dashboard.get')
  if (!d) return
  const recent = d.recent.slice(0, 5)
  const top = d.topSites.slice(0, 5)
  $('recent-title').textContent = t('Last visited')
  $('recent-section').hidden = !recent.length
  $('recent').replaceChildren(...recent.map((page, index) => siteIcon(page, index, page.title || page.url)))
  $('top-title').textContent = t('Most visited')
  $('top-section').hidden = !top.length
  $('top').replaceChildren(...top.map((site, index) => siteIcon(site, recent.length + index, t('{0} visits', number(site.visits)))))
}

async function start() {
  lang = (await lib.call('lang')) || 'en'
  t = sadeStrings.translator(lang)
  document.documentElement.lang = lang
  document.documentElement.dir = sadeStrings.direction(lang)
  document.title = t('New Tab')
  dates()
  occasion()
  weather()
  await sites()
  if (!first) return
  first = false
  // Open ready to type.
  focusSearch(await lib.call('dashboard.prefill'))
  ;[...document.querySelector('main').children].forEach((node, index) => node.style.setProperty('--order', index))
  document.body.classList.add('enter')
  setTimeout(() => document.body.classList.remove('enter'), 1300)
}

lib.onChange(start)
start()
