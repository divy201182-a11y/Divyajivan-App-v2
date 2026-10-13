# Divyajivan Auto-Deploy Script
# Generates version.json automatically, then deploys to Netlify

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$build = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
$version = @{ build = $build; updated = (Get-Date -Format "yyyy-MM-dd HH:mm:ss") } | ConvertTo-Json
Set-Content -Path "$dir\version.json" -Value $version -Encoding utf8
Write-Host "Generated version.json (build: $build)"

$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
Set-Location $dir
netlify deploy --prod --dir=.
