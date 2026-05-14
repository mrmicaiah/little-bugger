# Verify the daemon's config.json structure without echoing secrets.
# On JSON parse error, suppresses the native error message because
# ConvertFrom-Json includes the offending token (which may be the API key).

$cfgPath = "$env:APPDATA\bugger\config.json"
if (-not (Test-Path $cfgPath)) {
    Write-Output "Config file not found: $cfgPath"
    exit 1
}

$raw = Get-Content $cfgPath -Raw
$json = $null
try {
    $json = $raw | ConvertFrom-Json -ErrorAction Stop
} catch {
    Write-Output "JSON parse FAILED (error details suppressed to avoid echoing file contents)"
    Write-Output "File size: $($raw.Length) bytes"
    exit 2
}

Write-Output "JSON: valid"
Write-Output "Top-level keys: $($json.PSObject.Properties.Name -join ', ')"

$key = $json.anthropic_api_key
if ($key -and $key.Length -gt 0) {
    $len = $key.Length
    $prefix = if ($len -ge 7) { $key.Substring(0, 7) } else { "(short)" }
    $isDummy = $key -like '*dummy*'
    Write-Output "anthropic_api_key: length=$len prefix='$prefix...' is_dummy=$isDummy"
} else {
    Write-Output "anthropic_api_key: MISSING or empty"
}

Write-Output "port: $($json.port)"

$projCount = ($json.projects.PSObject.Properties | Measure-Object).Count
Write-Output "projects ($projCount):"
foreach ($p in $json.projects.PSObject.Properties) {
    Write-Output "  - $($p.Name) -> $($p.Value)"
}
