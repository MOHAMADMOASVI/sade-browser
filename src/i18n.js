// t('English text', ...args) → the same text in the language chosen in Settings.
// English strings are the keys; translations live in ui/strings.js, which the
// built-in pages load too.
const { translator, LANGUAGES } = require('../ui/strings')
const data = require('./data')

const language = () => data.stores.settings?.data.language || 'en'
const t = (text, ...args) => translator(language())(text, ...args)

module.exports = { t, language, LANGUAGES }
