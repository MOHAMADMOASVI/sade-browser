const params = new URLSearchParams(location.search)
const host = params.get('host') || ''
const lang = params.get('lang')
const t = sadeStrings.translator(lang)
document.documentElement.dir = sadeStrings.direction(lang)
document.getElementById('title').textContent = params.get('proxy')
  ? t('The proxy {0} needs a sign-in', host)
  : t('{0} needs a sign-in', host)
document.getElementById('username').placeholder = t('User name')
document.getElementById('password').placeholder = t('Password')
document.getElementById('cancel').textContent = t('Cancel')
document.getElementById('submit').textContent = t('Sign In')
document.getElementById('detail').textContent = params.get('realm') || ''

document.getElementById('form').addEventListener('submit', (event) => {
  event.preventDefault()
  sadeAuth.submit({
    username: document.getElementById('username').value,
    password: document.getElementById('password').value,
  })
})
document.getElementById('cancel').addEventListener('click', () => sadeAuth.submit(null))
window.addEventListener('keydown', (event) => event.key === 'Escape' && sadeAuth.submit(null))
