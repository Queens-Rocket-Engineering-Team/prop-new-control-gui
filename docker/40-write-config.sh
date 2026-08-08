#!/bin/sh
# Emit the runtime config the SPA fetches before it mounts.
#
# The bundle is environment-agnostic so one published image works against any
# server. PROP_SERVER_IP is an override; leaving it unset is the normal case,
# and the SPA then falls back to the host that served the page — correct
# whenever this container runs alongside the server.
#
# Runs from nginx's /docker-entrypoint.d/ before nginx starts.
set -eu

CONFIG_PATH=/usr/share/nginx/html/config.json

cat > "$CONFIG_PATH" <<EOF
{
  "serverIp": "${PROP_SERVER_IP:-}"
}
EOF

if [ -n "${PROP_SERVER_IP:-}" ]; then
    echo "prop-gui: API target pinned to ${PROP_SERVER_IP}"
else
    echo "prop-gui: no PROP_SERVER_IP set — using the host that serves the page"
fi
