const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

// Small JSON file in userData, written atomically and debounced.
class JsonStore {
  constructor(name, fallback) {
    this.file = path.join(app.getPath('userData'), name)
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this.data = fallback
    }
  }

  save() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 500)
  }

  flush() {
    clearTimeout(this.timer)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data))
      fs.renameSync(this.file + '.tmp', this.file)
    } catch (err) {
      console.error('store: failed to write', this.file, err.message)
    }
  }
}

module.exports = { JsonStore }
