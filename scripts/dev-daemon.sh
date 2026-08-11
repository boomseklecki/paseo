#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"

export PASEO_LISTEN="${PASEO_LISTEN:-127.0.0.1:6768}"
configure_dev_paseo_home

if [ -z "${PASEO_LOCAL_MODELS_DIR}" ]; then
  export PASEO_LOCAL_MODELS_DIR="$HOME/.paseo/models/local-speech"
  mkdir -p "$PASEO_LOCAL_MODELS_DIR"
fi

echo "══════════════════════════════════════════════════════"
echo "  Paseo Dev Daemon"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${PASEO_HOME}"
echo "  Models:  ${PASEO_LOCAL_MODELS_DIR}"
echo "  Listen:  ${PASEO_LISTEN}"
echo "══════════════════════════════════════════════════════"

export PASEO_CORS_ORIGINS="${PASEO_CORS_ORIGINS:-*}"
export PASEO_NODE_INSPECT="${PASEO_NODE_INSPECT:---inspect=0}"

# The server leg does not reload on a source change by default: `dev:server:raw`
# runs the daemon under plain tsx, so it compiles once at boot and then holds
# what it compiled. That is deliberate for a daemon holding ports and child
# processes, and it is also how a dev box ends up serving yesterday's code for a
# day without saying so. PASEO_DEV_SERVER_RELOAD=1 swaps in `tsx watch`.
#
# It does nothing for the web UI, which is a built Expo bundle either way - run
# `npm run build:daemon-web-ui` for app changes.
DEV_SERVER_TARGET="dev:server:watch"
if [ "${PASEO_DEV_SERVER_RELOAD:-0}" = "1" ]; then
  DEV_SERVER_TARGET="dev:server:watch:reload"
  echo "  Reload:  server restarts on source changes (web UI still needs build:daemon-web-ui)"
fi

if [ "${PASEO_SKIP_DEV_SERVER_BUILD:-0}" = "1" ]; then
  exec npm run "$DEV_SERVER_TARGET"
fi

exec sh -c "npm run build:server-deps && npm run $DEV_SERVER_TARGET"
