// Development aid, loaded only when SADE_DEV is set: runs an optional script and
// writes PNGs of the bar and the active tab into that directory so the UI can be
// checked without a person at the keyboard.
const fs = require('node:fs')
const path = require('node:path')

module.exports = (ctx) => {
  const dir = process.env.SADE_DEV
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const shot = async (wc, name) => fs.writeFileSync(path.join(dir, name), (await wc.capturePage()).toPNG())

  setTimeout(async () => {
    try {
      if (process.env.SADE_DEV_SCRIPT) await require(process.env.SADE_DEV_SCRIPT)(ctx, { wait, shot })
      const w = ctx.BrowserWin.current
      await shot(w.win.webContents, 'bar.png')
      if (w.active()) await shot(w.active().view.webContents, 'tab.png')
    } catch (err) {
      console.error('dev:', err)
    }
    if (process.env.SADE_DEV_QUIT) require('electron').app.quit()
  }, Number(process.env.SADE_DEV_DELAY || 5000))
}
