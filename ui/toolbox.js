const $ = (id) => document.getElementById(id)
let t = sadeStrings.translator('en')

function show(state) {
  t = sadeStrings.translator(state.lang)
  document.documentElement.dir = sadeStrings.direction(state.lang)
  const number = (value) => value.toLocaleString(state.lang, { useGrouping: false })

  $('fullscreen').querySelector('span').textContent = t(state.fullscreen ? 'Exit full screen' : 'Full screen')
  $('fullscreen').classList.toggle('on', state.fullscreen)
  $('translate').querySelector('span').textContent = t(state.translated ? 'Show original' : 'Translate page')
  $('translate').classList.toggle('on', state.translated)
  $('translate').disabled = !state.isWeb

  $('device-title').textContent = t('Preview as')
  const names = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' }
  for (const button of document.querySelectorAll('#devices button')) {
    button.querySelector('span').textContent = t(names[button.dataset.device])
    button.classList.toggle('on', button.dataset.device === state.device)
  }

  $('zoom-title').textContent = t('Page zoom')
  $('zoom-reset').textContent = `⁦${number(state.zoom)}%⁩`
  $('zoom-out').title = t('Zoom out')
  $('zoom-in').title = t('Zoom in')
  $('zoom-reset').title = t('Actual size')

  $('extensions').hidden = !state.extensions
  $('extensions-title').textContent = t('Extensions')
  $('store').textContent = t('Get extensions')
  if (state.tabId != null) $('actions').setAttribute('tab', state.tabId)
}

$('fullscreen').addEventListener('click', () => sade.send('tools:fullscreen'))
$('translate').addEventListener('click', () => sade.send('tools:translate'))
$('devices').addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (button) sade.send('tools:device', button.dataset.device)
})
$('zoom-out').addEventListener('click', () => sade.send('tools:zoom', -0.5))
$('zoom-in').addEventListener('click', () => sade.send('tools:zoom', 0.5))
$('zoom-reset').addEventListener('click', () => sade.send('tools:zoom', 0))
$('store').addEventListener('click', () => sade.send('tools:store'))

// A click on the see-through part of the layer, or Escape, closes the panel.
document.addEventListener('mousedown', (event) => {
  if (!event.target.closest('#panel')) sade.send('tools:close')
})
window.addEventListener('keydown', (event) => event.key === 'Escape' && sade.send('tools:close'))

sade.on('tools:show', (state) => {
  show(state)
  document.body.classList.remove('closing')
  document.body.classList.add('open')
})
sade.on('tools:state', show)
sade.on('tools:hide', () => {
  document.body.classList.remove('open')
  document.body.classList.add('closing')
})
