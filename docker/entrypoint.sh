#!/bin/sh
# Container entrypoint. ROLE selects the process; web and worker never run migrations implicitly.
# Any arguments replace the role process (e.g. `docker run --rm techplanner id -u`).
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

case "${ROLE:-web}" in
  web)
    exec node server.js
    ;;
  worker)
    exec node dist/worker.mjs
    ;;
  migrate)
    exec node dist/migrate.mjs
    ;;
  *)
    echo "entrypoint: unknown ROLE '${ROLE}' (expected web, worker or migrate)" >&2
    exit 64
    ;;
esac
