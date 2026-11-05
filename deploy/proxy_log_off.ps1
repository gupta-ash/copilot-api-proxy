# proxy_log_off.ps1 -- turn copilot-proxy trace logging OFF at runtime (no restart).
# PowerShell 5.1+ compatible.
#
# Companion of proxy_log_on.ps1. Always POSTs {"level":"off"} to
# <url>/admin/logging. The proxy reads the level live per request (dynamic
# logging toggle), so capture stops on the NEXT request with no restart; any
# in-flight peer stream that was already capturing keeps its snapshot decision
# and is not interrupted.
#
# Parameters:
#   -Url <url>    Proxy base URL. Default: $env:PROXY_URL, else
#                 http://127.0.0.1:4143.
#
# Exit codes:
#   0  2xx -- prints "previous -> current"
#   1  non-2xx (prints the response body verbatim) OR a transport error

[CmdletBinding()]
param(
    [string]$Url = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrEmpty($Url)) {
    if ($env:PROXY_URL) { $Url = $env:PROXY_URL } else { $Url = 'http://127.0.0.1:4143' }
}
$endpoint = $Url.TrimEnd('/') + '/admin/logging'
$bodyJson = '{"level":"off"}'

try {
    $resp = Invoke-RestMethod -Uri $endpoint -Method Post `
        -ContentType 'application/json' -Body $bodyJson -TimeoutSec 5
    Write-Host ('copilot-proxy logging: ' + $resp.previous + ' -> ' + $resp.current)
    exit 0
} catch {
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
