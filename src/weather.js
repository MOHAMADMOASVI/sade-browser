// Weather for the dashboard, from Open-Meteo (free, no account or key). The page
// itself has no network access; it asks the main process, which caches the answer.
const { net } = require('electron')
const data = require('./data')
const { language } = require('./i18n')

const CACHE_MS = 30 * 60 * 1000
let cache = null // { key, time, value }

async function getJson(url) {
  const response = await net.fetch(url, { signal: AbortSignal.timeout(9000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

// → { needsCity } | { error, city } | { city, now, days }
async function get() {
  const city = data.stores.settings.data.city
  if (!city) return { needsCity: true }
  const key = `${city.lat},${city.lon}`
  if (cache?.key === key && Date.now() - cache.time < CACHE_MS) return cache.value
  try {
    const w = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
        '&current=temperature_2m,apparent_temperature,weather_code,is_day' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=4',
    )
    const value = {
      city: city.name,
      now: {
        temp: Math.round(w.current.temperature_2m),
        feels: Math.round(w.current.apparent_temperature),
        code: w.current.weather_code,
        night: w.current.is_day === 0,
      },
      days: w.daily.time.map((date, i) => ({
        date,
        code: w.daily.weather_code[i],
        high: Math.round(w.daily.temperature_2m_max[i]),
        low: Math.round(w.daily.temperature_2m_min[i]),
      })),
    }
    cache = { key, time: Date.now(), value }
    return value
  } catch {
    return { error: true, city: city.name }
  }
}

// Look a place up by name and make it the dashboard's city.
async function setCity(query) {
  const name = String(query || '').trim().slice(0, 80)
  if (!name) return { notFound: true }
  let place
  try {
    const found = await getJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=${language()}`,
    )
    place = found.results?.[0]
  } catch {
    return { error: true }
  }
  if (!place) return { notFound: true }
  data.stores.settings.data.city = { name: place.name, lat: place.latitude, lon: place.longitude }
  data.stores.settings.save()
  cache = null
  return get()
}

module.exports = { get, setCity }
