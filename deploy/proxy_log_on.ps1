# proxy_log_on.ps1 -- turn copilot-proxy trace logging ON at runtime (no restart).
# PowerShell 5.1+ compatible.
#
# Companion of proxy_log_off.ps1. POSTs {"level":<lvl>} to <url>/admin/logging.
# The proxy reads the level live per request (dynamic logging toggle), so the
# change takes effect on the NEXT request with no restart and WITHOUT
# interrupting any in-flight peer streams (they keep their snapshot decision).
#
# Parameters:
#   -Level <lvl>  raw | on | verbose | off  (default: verbose). Also accepts a
#                 bare positional arg: `proxy_log_on.ps1 raw`.
#                   verbose = full console logging + packet/body trace
#                   raw     = packet/body trace only (quieter)
#                   on      = normal logging, no body capture
#   -Url <url>    Proxy base URL. Default: $env:PROXY_URL, else
#                 http://127.0.0.1:4143. (Lets an operator flip a peer box
#                 remotely -- there is no guard on /admin/logging.)
#
# Exit codes:
#   0  2xx -- prints "previous -> current"
#   1  non-2xx (prints the response body verbatim, e.g. the 400 valid-level
#      list) OR a transport error

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Level = 'verbose',
    [string]$Url = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrEmpty($Url)) {
    if ($env:PROXY_URL) { $Url = $env:PROXY_URL } else { $Url = 'http://127.0.0.1:4143' }
}
$endpoint = $Url.TrimEnd('/') + '/admin/logging'
$bodyJson = '{"level":"' + $Level + '"}'

try {
    $resp = Invoke-RestMethod -Uri $endpoint -Method Post `
        -ContentType 'application/json' -Body $bodyJson -TimeoutSec 5
    Write-Host ('copilot-proxy logging: ' + $resp.previous + ' -> ' + $resp.current)
    exit 0
} catch {
    # Non-2xx OR transport error. Print the server body verbatim if present
    # (PS7 exposes it via ErrorDetails.Message; PS5.1 via the response stream).
    $body = $null
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        $body = $_.ErrorDetails.Message
    } elseif ($_.Exception.Response) {
        try {
            $stream = $_.Exception.Response.GetResponseStream()
            if ($stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                $body = $reader.ReadToEnd()
            }
        } catch { }
    }
    if ($body) { Write-Host $body } else { Write-Host ('ERROR: ' + $_.Exception.Message) }
    exit 1
}
