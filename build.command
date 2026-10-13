#!/bin/zsh
# Builds dist/Sade-darwin-arm64/Sade.app. Needs a working Node (brew reinstall node).
cd "$(dirname "$0")" && npm run build
