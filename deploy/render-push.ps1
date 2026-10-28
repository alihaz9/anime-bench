#Requires -Version 5.1
<#
  put the project on github and hand render a repo it can build.

  needs a github personal access token with "repo" scope (classic) or
  "Contents: read/write" + "Administration: read/write" (fine-grained):
    github.com/settings/tokens

  run:
    .\deploy\render-push.ps1 -Repo "Alikhadra101/anime-bench" -Token "ghp_xxx"

  -DryRun prints what it would do, no network, no git.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Repo,     # owner/name
  [string]$Token = $env:GITHUB_TOKEN,
  [string]$Branch = 'main',
  [switch]$Private,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'render.yaml'))) { throw "render.yaml not found above $root" }

$owner, $name = $Repo.Split('/', 2)
if (-not $name) { throw "Repo must be owner/name, got '$Repo'" }

if ($DryRun) {
  Write-Host "would create github repo $owner/$name (private=$Private)"
  Write-Host "would push $root -> https://github.com/$owner/$name.git ($Branch)"
  Write-Host 'would then: render.com -> New -> Blueprint -> pick the repo'
  return
}
if (-not $Token) { throw 'no token: pass -Token ghp_xxx or set GITHUB_TOKEN' }

$api = @{
  Authorization          = "Bearer $Token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = 'anime-bench'
}

# 1. repo (409 = already exists, which is fine)
$body = @{ name = $name; private = [bool]$Private; auto_init = $false } | ConvertTo-Json
try {
  Invoke-RestMethod -Method Post -Uri 'https://api.github.com/user/repos' -Headers $api -Body $body -ContentType 'application/json' | Out-Null
  Write-Host "created $owner/$name"
} catch {
  $code = [int]$_.Exception.Response.StatusCode
  if ($code -eq 422 -or $code -eq 409) { Write-Host "repo $owner/$name already there - pushing into it" }
  else { throw }
}

# 2. remote + push (token only on the wire, never written to .git/config)
Push-Location $root
try {
  if (-not (Test-Path '.git')) { git init -q -b $Branch }
  git rev-parse --verify HEAD *> $null
  if ($LASTEXITCODE -ne 0) {
    git add -A
    git -c user.name='anime-bench' -c user.email='anime-bench@users.noreply.local' commit -q -m 'anime bench'
  }
  git branch -M $Branch
  git remote remove origin 2>$null
  git remote add origin "https://github.com/$owner/$name.git"
  git -c "http.extraheader=AUTHORIZATION: basic $([Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$Token")))" push -u origin $Branch --force
  if ($LASTEXITCODE -ne 0) { throw 'push failed - token scope or repo name' }
  Write-Host "pushed -> https://github.com/$owner/$name"
}
finally { Pop-Location }

Write-Host ''
Write-Host 'next:'
Write-Host '  render.com -> sign in with github (no card) -> New -> Blueprint -> pick the repo'
Write-Host '  render reads render.yaml: docker, free plan, healthCheck /api/health'
Write-Host '  then copy the *.onrender.com url and set PING_URLS in the repo secrets'
