#!/bin/zsh
# Launches Sade with the bundled Electron (no working Node install needed).
cd "$(dirname "$0")" && exec ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
