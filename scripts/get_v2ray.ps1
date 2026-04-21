$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/v2fly/v2ray-core/releases/latest' -UseBasicParsing
$asset = $release.assets | Where-Object { $_.name -like '*windows-64*' } | Select-Object -First 1
Write-Host "Asset: $($asset.name)"
Write-Host "URL: $($asset.browser_download_url)"

$outzip = Join-Path $env:TEMP 'v2ray-windows-64.zip'
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $outzip -UseBasicParsing
Write-Host "Downloaded to $outzip"

$dest = Join-Path $PSScriptRoot '..\bin'
Expand-Archive -Path $outzip -DestinationPath $dest -Force
Write-Host "Extracted to $dest"
Get-ChildItem $dest | Select-Object Name
