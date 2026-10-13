// Builds dist/Sade-darwin-<arch>/Sade.app
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..')

async function main() {
  const packagerModule = await import('@electron/packager')
  const packager = packagerModule.packager || packagerModule.default
  const [appPath] = await packager({
    dir: root,
    out: path.join(root, 'dist'),
    name: 'Sade',
    platform: 'darwin',
    arch: process.arch,
    overwrite: true,
    icon: path.join(__dirname, 'icon.icns'),
    appBundleId: 'local.sade.browser',
    appCategoryType: 'public.app-category.productivity',
    // Lets macOS offer Sade as the default browser.
    protocols: [{ name: 'Web site URL', schemes: ['http', 'https'] }],
    extendInfo: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'HTML document',
          CFBundleTypeRole: 'Viewer',
          LSItemContentTypes: ['public.html', 'public.xhtml'],
        },
      ],
      NSCameraUsageDescription: 'A website you allowed wants to use the camera.',
      NSMicrophoneUsageDescription: 'A website you allowed wants to use the microphone.',
      NSLocationUsageDescription: 'A website you allowed wants to use your location.',
    },
    ignore: [/^\/dist($|\/)/, /^\/build($|\/)/, /^\/start\.command$/, /^\/build\.command$/],
    prune: true,
    asar: false, // keep plain files so preloads and sade:// pages load straight from disk
  })
  // Ad-hoc signature: enough to run on this Mac (not for distribution).
  const bundle = path.join(appPath, 'Sade.app')
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' })
  console.log('Built', bundle)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
