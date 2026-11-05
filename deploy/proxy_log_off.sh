#!/usr/bin/env bash
# proxy_log_off.sh -- turn copilot-proxy trace logging OFF at runtime (no restart).
#
# Linux/macOS companion of proxy_log_off.ps1. Always POSTs {"level":"off"} to
# <url>/admin/logging via curl. The proxy reads the level live per request
# (dynamic logging toggle), so capture stops on the NEXT request with no
# restart; any in-flight peer stream that was already capturing keeps its
# snapshot decision and is not interrupted.
#
# Flags:
#   --url <url>     Proxy base URL. Default: $PROXY_URL, else
#                   http://127.0.0.1:4143.
#   -h, --help      Print usage; exit 0.
#
# Exit codes:
#   0  2xx (prints the {previous,current} JSON result)
#   1  non-2xx (prints the response body verbatim) OR a transport error

set -euo pipefail

URL="${PROXY_URL:-http://127.0.0.1:4143}"

usage() {
  cat <<EOF
Usage: $0 [--url http://host:port]

Turn copilot-proxy trace logging OFF at runtime (POST /admin/logging {level:off}).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)   URL="${2:?--url requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

endpoint="${URL%/}/admin/logging"
body='{"level":"off"}'

if ! resp="$(curl -sS -m 5 -w '\n%{http_code}' \
    -X POST -H 'content-type: application/json' -d "$body" "$endpoint")"; then
  echo "ERROR: request to $endpoint failed" >&2
  exit 1
fi

http_code="$(printf '%s' "$resp" | tail -n1)"
body_out="$(printf '%s' "$resp" | sed '$d')"

echo "$body_out"
if [[ "$http_code" =~ ^2[0-9][0-9]$ ]]; then
  exit 0
fi
exit 1
