param(
  [Parameter(Mandatory = $true)]
  [string]$WorkspacePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Convert-ToWindowsHostPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PathValue
  )

  if ($PathValue -match '^[A-Za-z]:[\\/]') {
    return $PathValue -replace '/', '\'
  }
  if ($PathValue -match '^/mnt/([A-Za-z])/(.*)$') {
    $drive = $matches[1].ToUpper()
    $rest = $matches[2] -replace '/', '\'
    return "${drive}:\$rest"
  }
  return $PathValue
}

$scanPath = Convert-ToWindowsHostPath -PathValue $WorkspacePath

$before = Get-MpThreatDetection |
  Select-Object InitialDetectionTime, ThreatName, Resources, ActionSuccess, SeverityID, ThreatID

Start-MpScan -ScanType CustomScan -ScanPath $scanPath

$after = Get-MpThreatDetection |
  Where-Object {
    $_.Resources -and (
      @($_.Resources) | Where-Object {
        ($_ -is [string]) -and ($_ -like "$scanPath*")
      }
    )
  } |
  Select-Object InitialDetectionTime, ThreatName, Resources, ActionSuccess, SeverityID, ThreatID

[pscustomobject]@{
  workspacePath = $WorkspacePath
  scanPath = $scanPath
  beforeCount = @($before).Count
  workspaceDetectionCount = @($after).Count
  detections = @($after)
} | ConvertTo-Json -Depth 6

