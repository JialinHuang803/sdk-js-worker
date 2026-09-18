param(
  [string]$Subscription = "2807db07-c2ff-4a43-b586-5cfc12779347",
  [string]$ResourceGroup = "rg-sdk-js-worker",
  [string]$AppName = "func-sdk-js-worker-2807"
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
  npm --prefix api run build
  if ($LASTEXITCODE -ne 0) { throw "Activity API build failed." }
  $archive = Join-Path ([System.IO.Path]::GetTempPath()) ("sdk-js-worker-api-" + [guid]::NewGuid() + ".zip")
  try {
    Compress-Archive -LiteralPath @(
      (Join-Path $root "api\host.json"),
      (Join-Path $root "api\package.json"),
      (Join-Path $root "api\dist"),
      (Join-Path $root "api\node_modules")
    ) -DestinationPath $archive
    az functionapp deployment source config-zip --subscription $Subscription `
      --resource-group $ResourceGroup --name $AppName --src $archive `
      --build-remote false --timeout 600 --output none
    if ($LASTEXITCODE -ne 0) { throw "Activity API deployment failed." }
  } finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
  }
} finally {
  Pop-Location
}
