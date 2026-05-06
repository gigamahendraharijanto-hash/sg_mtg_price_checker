$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCandidates = @(
  "C:\Users\gigam\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe",
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
) | Where-Object { $_ -and (Test-Path $_) }

if (-not $nodeCandidates.Count) {
  throw "Node.js was not found. Install Node 18+ or run through the Codex bundled runtime."
}

Set-Location $root
& $nodeCandidates[0] "server.js"
