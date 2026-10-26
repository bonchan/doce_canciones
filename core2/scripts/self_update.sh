#!/usr/bin/env bash
# Run by the Update button on the System tab, as doce-update.service (root), so that update.sh restarting
# the backend doesn't cut it short: git pull, then the normal update.
#   bash scripts/self_update.sh <log file>
# Everything is inside main(), which bash reads in full before running, so the pull below can safely
# replace this very file.
set -eEuo pipefail

main() {
  exec >>"$1" 2>&1
  trap 'echo "== FAILED (exit code $?)"' ERR

  local core_dir app_user app_home
  core_dir="$(cd "$(dirname "$0")/.." && pwd)"
  app_user="${DOCE_USER:?DOCE_USER not set}"
  app_home="$(getent passwd "$app_user" | cut -d: -f6)"
  as_user() { runuser -u "$app_user" -- env HOME="$app_home" PATH="$PATH" "$@"; }

  echo "== git pull"
  local before prefix changed for_app
  before="$(as_user git -C "$core_dir" rev-parse HEAD)"
  prefix="$(as_user git -C "$core_dir" rev-parse --show-prefix)"      # "core2/"
  as_user git -C "$core_dir" pull --ff-only

  # Only commits touching what the NUC runs need a rebuild (the same list as APP_PATHS in
  # backend/updater.py); the rest of the repo (other songs, arduino sketches, docs) is just pulled.
  changed="$(as_user git -C "$core_dir" diff --name-only --no-renames "$before" HEAD)"
  for_app="$(printf '%s\n' "$changed" | grep -E "^${prefix}(backend|frontend|file_server|scripts)/" || true)"
  if [ -z "$for_app" ]; then
    echo "== no rebuild: nothing the NUC uses changed (only files outside ${prefix}backend, frontend, file_server, scripts)"
    echo "== done"
    return 0
  fi

  bash "$core_dir/scripts/update.sh"
  echo "== done"
}

main "$@"
exit
