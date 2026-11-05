#!/usr/bin/env bash
# proxy_log_on.sh -- turn copilot-proxy trace logging ON at runtime (no restart).
#
# Linux/macOS companion of proxy_log_on.ps1. POSTs {"level":<lvl>} to
# <url>/admin/logging via curl. The proxy reads the level live per request
# (dynamic logging toggle), so the change takes effect on the NEXT request with
# no restart and WITHOUT interrupting any in-flight peer streams (they keep
# their snapshot decision).
#
# Flags:
#   --level <lvl>   raw | on | verbose | off  (default: verbose). Also accepts a
#                   bare positional arg: `proxy_log_on.sh raw`.
#                     verbose = full console logging + packet/body trace
#                     raw     = packet/body trace only (quieter)
#                     on      = normal logging, no body capture
#   --url <url>     Proxy base URL. Default: $PROXY_URL, else
#                   http://127.0.0.1:4143.
#   -h, --help      Print usage; exit 0.
#
# Exit codes:
#   0  2xx (prints the {previous,current} JSON result)
#   1  non-2xx (prints the response body verbatim, e.g. the 400 valid-level
#      list) OR a transport error

set -euo pipefail

LEVEL='verbose'
URL="${PROXY_URL:-http://127.0.0.1:4143}"

usage() {
  cat <<EOF
Usage: $0 [--level raw|on|verbose|off] [--url http://host:port]
       $0 <level>            # positional shorthand (default: verbose)

Turn copilot-proxy trace logging ON at runtime (POST /admin/logging).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --level) LEVEL="${2:?--level requires a value}"; shift 2 ;;
    --url)   URL="${2:?--url requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown arg: $1" >&2; usage >&2; exit 1 ;;
    *) LEVEL="$1"; shift ;;
  esac
done

endpoint="${URL%/}/admin/logging"
body="{\"level\":\"${LEVEL}\"}"

# One request; capture body + HTTP status. `-w '\n%{http_code}'` appends the
# status on its own trailing line. We do NOT pass --fail: a 4xx must still
# yield its body (the valid-level list) verbatim.
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
