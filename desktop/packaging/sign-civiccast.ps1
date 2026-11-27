<#
.SYNOPSIS
  Sign one Windows file with Scott's Azure Trusted Signing cert (ScottConversePublic).
  Copy of the azure-signing skill script, kept in the repo so signed builds do not depend on one PC.
  Called by packaging/sign-civiccast.cjs. Needs gh logged in with access to scottconverse/civiccast.

.DESCRIPTION
  Uses the sign-native-installer workflow in scottconverse/civiccast (the only repo
  that holds the Azure secrets). Steps:
    1. Hash the local unsigned exe.
    2. Upload it to a new DRAFT "signing intake" release in civiccast (never published).
    3. Dispatch sign-native-installer with tag + asset name + SHA-256.
    4. Wait for the run, download the signed exe + receipt.
    5. Fail closed unless: Authenticode status is Valid, the signer is the expected
       subject, and the receipt's unsigned_sha256 equals the local hash.
  Publishes nothing. Never prints secrets.

.EXAMPLE
  & desktop\packaging\sign-civiccast.ps1 -Exe .\dist\app-setup-1.2.0-x64.exe -Project Rigwell -Version 1.2.0
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Exe,
  [Parameter(Mandatory)] [string] $Project,
  [Parameter(Mandatory)] [string] $Version,
  [string] $OutDir = (Join-Path (Split-Path -Parent (Resolve-Path $Exe)) 'signed'),
  [string] $ExpectedSubject = 'CN=Scott Converse, O=Scott Converse,',
  [int]    $TimeoutMinutes = 30,
  [switch] $RemoveDraftAfter
)
$ErrorActionPreference = 'Stop'
$repo     = 'scottconverse/civiccast'
$workflow = 'sign-native-installer.yml'

function Fail($m) { Write-Error $m; exit 1 }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail 'gh CLI not found.' }
$exePath = (Resolve-Path $Exe).Path
if ([IO.Path]::GetExtension($exePath) -ne '.exe') { Fail 'Only .exe files are supported by the workflow.' }

# 1. hash
$sha   = (Get-FileHash -Algorithm SHA256 $exePath).Hash.ToLowerInvariant()
$slug  = ($Project.ToLowerInvariant() -replace '[^a-z0-9]+','-').Trim('-')
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tag   = "$slug-intake-$($sha.Substring(0,8))-$stamp"
$base  = [IO.Path]::GetFileNameWithoutExtension($exePath)
$asset = if ($base -match 'UNSIGNED') { "$base.exe" } else { "$base-UNSIGNED.exe" }
Write-Host "Unsigned SHA-256: $sha"
Write-Host "Intake tag:       $tag"

# 2. draft intake release (asset renamed via gh's file#label is label only, so copy)
$tmp = Join-Path ([IO.Path]::GetTempPath()) "azsign-$stamp"
New-Item -ItemType Directory -Force $tmp | Out-Null
$upload = Join-Path $tmp $asset
Copy-Item $exePath $upload
gh release create $tag $upload --repo $repo --draft --target main `
  --title "$Project $Version signing intake - DO NOT PUBLISH" `
  --notes "Private signing intake for $Project $Version. Unsigned SHA-256: $sha. Draft only; never publish." | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'Could not create draft intake release.' }

# 3. dispatch
# Compare run IDs, not times: this PC's clock can differ from GitHub's.
$beforeIds = @(gh run list --repo $repo --workflow $workflow --event workflow_dispatch --limit 30 --json databaseId --jq '.[].databaseId')
if ($LASTEXITCODE -ne 0) { Fail 'Could not read the signing runs.' }
gh workflow run $workflow --repo $repo -f release_tag=$tag -f asset_name=$asset -f expected_sha256=$sha
if ($LASTEXITCODE -ne 0) { Fail 'Workflow dispatch failed.' }

# 4. find run + wait (30 s polls; never gh run watch)
$newIds = @()
for ($i = 0; $i -lt 18 -and $newIds.Count -eq 0; $i++) {
  Start-Sleep 10
  $newIds = @(gh run list --repo $repo --workflow $workflow --event workflow_dispatch --limit 30 --json databaseId --jq '.[].databaseId' | Where-Object { $_ -notin $beforeIds })
}
if ($newIds.Count -ne 1) { Fail "Expected 1 new signing run, found $($newIds.Count). Do not start another run. Read the run list first." }
$runId = $newIds[0]
Write-Host "Run: https://github.com/$repo/actions/runs/$runId"
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
do {
  Start-Sleep 30
  $run = gh run view $runId --repo $repo --json status,conclusion | ConvertFrom-Json
} while ($run.status -ne 'completed' -and (Get-Date) -lt $deadline)
if ($run.status -ne 'completed') { Fail "Run $runId did not finish in $TimeoutMinutes min." }
if ($run.conclusion -ne 'success') { Fail "Run $runId ended: $($run.conclusion). See the run log." }

# download
$dl = Join-Path $tmp 'out'
gh run download $runId --repo $repo --name signed-native-installer --dir $dl
if ($LASTEXITCODE -ne 0) { Fail 'Artifact download failed.' }

# 5. verify (fail closed)
$receipt = Get-Content (Join-Path $dl 'signing-receipt.json') -Raw | ConvertFrom-Json
if ($receipt.unsigned_sha256 -ne $sha) { Fail 'Receipt unsigned_sha256 does not match the local exe. Wrong run?' }
$signed = Get-ChildItem $dl -Filter *.exe | Select-Object -First 1
$sig = Get-AuthenticodeSignature $signed.FullName
if ($sig.Status -ne 'Valid') { Fail "Signature status: $($sig.Status)" }
if ($sig.SignerCertificate.Subject -notlike "$ExpectedSubject*") { Fail "Unexpected signer: $($sig.SignerCertificate.Subject)" }
if (-not $sig.TimeStamperCertificate) { Fail 'No timestamp on signature.' }

New-Item -ItemType Directory -Force $OutDir | Out-Null
$finalName = ($signed.Name -replace '-UNSIGNED','')
$final = Join-Path $OutDir $finalName
Copy-Item $signed.FullName $final -Force
Copy-Item (Join-Path $dl 'signing-receipt.json') (Join-Path $OutDir "$finalName.signing-receipt.json") -Force
Remove-Item $tmp -Recurse -Force

if ($RemoveDraftAfter) { gh release delete $tag --repo $repo --yes | Out-Null }

Write-Host ''
Write-Host "SIGNED OK"
Write-Host "File:          $final"
Write-Host "Status:        $($sig.Status)"
Write-Host "Signer:        $($sig.SignerCertificate.Subject)"
Write-Host "Signed SHA256: $((Get-FileHash -Algorithm SHA256 $final).Hash.ToLowerInvariant())"
Write-Host "Draft intake:  $tag $(if ($RemoveDraftAfter) {'(removed)'} else {'(kept)'})"
