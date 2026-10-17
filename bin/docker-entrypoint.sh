#!/bin/sh
# think's container entrypoint (both containers). It runs as root only long
# enough to become the user who owns the data folder — PUID/PGID, default
# 1000:1000 — so files written into the mounted canvases, logins and requests
# keep that ownership on the host. Then it runs the command as that user.
set -eu

PUID=${PUID:-1000}
PGID=${PGID:-1000}

if [ "$(id -u)" != 0 ]; then
  exec "$@" # started as a user already (e.g. `docker run --user`): nothing to do
fi

case "$PUID:$PGID" in
  *[!0-9:]*) echo "think: PUID and PGID must be numbers (got $PUID:$PGID)" >&2; exit 1 ;;
esac
if [ "$PUID" = 0 ] || [ "$PGID" = 0 ]; then
  echo "think: refusing to run as root — set PUID/PGID to the owner of your data folder (id -u / id -g)" >&2
  exit 1
fi

# The image's `think` user takes the wanted ids (duplicates allowed: 1000 is also `node`).
[ "$(id -g think)" = "$PGID" ] || groupmod -o -g "$PGID" think
[ "$(id -u think)" = "$PUID" ] || usermod -o -u "$PUID" -g "$PGID" think >/dev/null

mkdir -p /run/think
chown think:think /run/think
chmod 700 /run/think

# Folders Docker created for missing bind mounts belong to root: hand them over
# (the top level only — never anything inside the user's data).
for d in /projects /projects/data /projects/.agents /projects/guests /projects/.auth; do
  if [ -d "$d" ] && [ "$(stat -c %u "$d")" = 0 ]; then
    chown "$PUID:$PGID" "$d"
    case "$d" in */.agents | */.auth) chmod 700 "$d" ;; esac
  fi
done

export HOME=/home/think USER=think
exec setpriv --reuid="$PUID" --regid="$PGID" --init-groups -- "$@"
