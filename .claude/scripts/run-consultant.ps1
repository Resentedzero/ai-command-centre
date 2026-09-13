param(
    [Parameter(Mandatory = $true)]
    [string]$Phase
)

$ErrorActionPreference = "Stop"

$Repo = "C:\Users\cress\ai-command-centre"
$BridgeDir = "C:\Users\cress\ai-command-centre-data\agent-bridge"
$ReviewFile = Join-Path $BridgeDir "CONSULTANT_REVIEW.md"

New-Item -ItemType Directory -Force $BridgeDir | Out-Null

Set-Location $Repo

$prompt = @"
You are the independent senior architecture, security, and code-review
consultant for the primary Claude Code engineering agent.

CURRENT PHASE:
$Phase

You are a READ-ONLY consultant.

Your job is to independently inspect the current repository state and
challenge the primary agent's work.

DO NOT:
- edit source code
- edit tests
- create or delete repository files
- modify .env or secrets
- modify Git state
- commit
- push
- reset
- restore
- checkout
- clean
- stash

Review the actual repository, relevant specifications, implementation,
tests, and current architecture.

Pay particular attention to:

- correctness
- architectural compliance
- security
- authorization boundaries
- fail-closed behavior
- emergency-stop behavior
- budget enforcement
- resource-unit separation
- approval behavior
- provider routing
- accidental fallback
- retry behavior
- concurrency
- transaction boundaries
- test coverage
- test isolation
- hidden coupling
- scope creep
- accidental implementation of later phases

Use the project's established architecture and decisions as the authority.
Do not recommend changes merely because you personally prefer a different
design.

Classify each finding as exactly one of:

CONFIRMED DEFECT
PLAUSIBLE RISK
ARCHITECTURAL PREFERENCE
DEFERRED FUTURE-PHASE ISSUE

Be adversarial but fair.

The primary agent will receive your review and decide what to change.
You are not the implementer.

Return:

# Verdict

# Confirmed Defects

# Plausible Risks

# Deferred Future-Phase Issues

# Missing Tests

# Recommended Fixes

# Human Decisions Required

Keep the review technically rigorous but reasonably concise.
"@

$env:ANTHROPIC_API_KEY = $null

$review = $prompt | claude `
    -p `
    --model opus `
    --tools "Read,Glob,Grep" `
    --restricted `
    --strict-mcp-config `
    --permission-mode plan `
    --permission-prompts none `
    --no-session-persistence `
    --output-format text

if ($LASTEXITCODE -ne 0) {
    throw "Consultant exited with code $LASTEXITCODE"
}

$review | Set-Content -Encoding UTF8 $ReviewFile

Write-Host ""
Write-Host "========================================"
Write-Host "CONSULTANT REVIEW COMPLETE"
Write-Host "========================================"
Write-Host ""
Write-Host "Phase: $Phase"
Write-Host "Review: $ReviewFile"
Write-Host ""