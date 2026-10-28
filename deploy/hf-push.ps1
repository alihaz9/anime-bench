#Requires -Version 5.1
<#
  stage the app into a clean folder and push it to a Hugging Face Space.

  one-time:
    huggingface.co -> New Space -> name: anime-bench -> SDK: Docker -> Blank
    huggingface.co/settings/tokens -> New token -> role: write

  run:
    .\deploy\hf-push.ps1 -Space "yourname/anime-bench" -Token "hf_xxx"

  -DryRun stages the folder and prints the tree without touching git or the network.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Space,   # user/space-name
  [string]$Token = $env:HF_TOKEN,
  [string]$Staging = (Join-Path $env:TEMP 'ab-hf-space'),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'server\index.js'))) { throw "run from the project: server/index.js not found under $root" }

# a space is its own git repo -- never reuse the project's .git
if (Test-Path $Staging) { Remove-Item $Staging -Recurse -Force }
New-Item -ItemType Directory -Path $Staging | Out-Null

$files = @('Dockerfile', 'package.json', 'package-lock.json', '.dockerignore')
foreach ($f in $files) {
  $src = Join-Path $root $f
  if (Test-Path $src) { Copy-Item $src -Destination $Staging } else { Write-Warning "missing $f -- build may fall back to npm install" }
}
foreach ($d in @('server', 'web')) {
  Copy-Item (Join-Path $root $d) -Destination $Staging -Recurse
}
Copy-Item (Join-Path $PSScriptRoot 'huggingface\README.md') -Destination (Join-Path $Staging 'README.md')

# space config: the space sits behind the hf edge proxy, so trust one hop.
# (root Dockerfile stays untouched for local/render use; this patch only lands in the space)
$dockerfile = Get-Content (Join-Path $root 'Dockerfile') -Raw
if ($dockerfile -notmatch 'TRUST_PROXY') {
  $dockerfile = $dockerfile -replace '(?m)^(FROM\s+\S+)', "`$1`n`nENV TRUST_PROXY=1 CACHE_MAX=600"
}
Set-Content -Path (Join-Path $Staging 'Dockerfile') -Value $dockerfile -Encoding utf8

# .env is dropped by .dockerignore on purpose - runtime vars live in
# space settings -> variables, not in the image.

# the space must not ship node_modules or a stale lock from the host
@'
node_modules
.git
.env.local
'@ | Add-Content -Path (Join-Path $Staging '.dockerignore') -Encoding utf8

Write-Host "staged $Staging"
Get-ChildItem $Staging -Name | ForEach-Object { Write-Host "  $_" }

if ($DryRun) { Write-Host 'dry run -- no git, no push'; return }
if (-not $Token) { throw 'no token: pass -Token hf_xxx or set HF_TOKEN' }

Push-Location $Staging
try {
  git init -q -b main
  git add -A
  git -c user.name='anime-bench' -c user.email='anime-bench@users.noreply.local' commit -q -m 'deploy anime bench'
  $url = "https://user:$Token@huggingface.co/spaces/$Space"
  git remote add space $url
  git push --force space main
  Write-Host "space page: https://huggingface.co/spaces/$Space"
  Write-Host 'direct url sits on the space page under "Embed this space" (host.hf.space).'
}
finally {
  git remote remove space 2>$null
  Pop-Location
}
