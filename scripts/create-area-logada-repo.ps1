# =============================================================================
#  Cria o repositório "area-logada" no seu GitHub (privado) a partir do modelo em
#  templates\area-logada e coloca a URL dele no WORKFLOW.md.
#  Como rodar (no PowerShell, dentro da pasta do projeto, depois do setup-windows.ps1):
#     powershell -ExecutionPolicy Bypass -File .\scripts\create-area-logada-repo.ps1
# =============================================================================
param([string]$Name = 'area-logada')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$owner = (gh api user --jq .login).Trim()
if (-not $owner) { throw "Não consegui descobrir seu usuário do GitHub. Rode 'gh auth login' antes." }

$target = Join-Path $env:USERPROFILE $Name
if (Test-Path $target) { throw "A pasta $target já existe. Apague-a ou escolha outro nome com -Name." }

Write-Host "Criando $owner/$Name (privado) a partir do modelo..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path $target | Out-Null
Copy-Item -Path (Join-Path $root 'templates\area-logada\*') -Destination $target -Recurse -Force
Copy-Item -Path (Join-Path $root 'templates\area-logada\.gitignore') -Destination $target -Force

Push-Location $target
git init -b main | Out-Host
git add . | Out-Host
git commit -m "chore: estrutura inicial da área logada" | Out-Host
gh repo create "$owner/$Name" --private --source . --remote origin --push | Out-Host
Pop-Location

$url = "https://github.com/$owner/$Name.git"
$wf = Join-Path $root 'WORKFLOW.md'
$text = [IO.File]::ReadAllText($wf)
$text = $text.Replace('https://github.com/SEU_USUARIO/area-logada.git', $url)
[IO.File]::WriteAllText($wf, $text, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Pronto! Repositório: https://github.com/$owner/$Name" -ForegroundColor Green
Write-Host "WORKFLOW.md atualizado para clonar $url"
Write-Host "(a cópia local em $target pode ser apagada; o Symphony clona sozinho para cada issue)"
