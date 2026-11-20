# =============================================================================
#  Instalador do Symphony para Windows
#  Como rodar (no PowerShell, dentro da pasta do projeto):
#     powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
#  Pode rodar quantas vezes quiser: ele pula o que já estiver pronto.
# =============================================================================

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Step($text)  { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text)    { Write-Host "    [ok] $text" -ForegroundColor Green }
function Info($text)  { Write-Host "    $text" }
function Warn($text)  { Write-Host "    [atenção] $text" -ForegroundColor Yellow }

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $local = Join-Path $env:USERPROFILE '.local\bin'
    $env:Path = "$machine;$user;$local"
}

function Has($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Winget-Install($id, $name) {
    if (-not (Has 'winget')) {
        throw "O winget não está disponível. Instale '$name' manualmente e rode este script de novo."
    }
    Info "Instalando $name (pode pedir confirmação do Windows)..."
    winget install --id $id -e --accept-source-agreements --accept-package-agreements | Out-Host
    Refresh-Path
}

function Read-Secret($prompt) {
    $secure = Read-Host -Prompt $prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Save-UserEnv($name, $value) {
    [Environment]::SetEnvironmentVariable($name, $value, 'User')   # permanente (sua conta do Windows)
    Set-Item -Path "Env:$name" -Value $value                         # vale já neste terminal
}

Refresh-Path

# 1. Programas -----------------------------------------------------------------
Step "1/6  Node.js"
if (Has 'node') { Ok "Node $(node --version)" } else { Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js LTS'; Ok "Node instalado" }

Step "2/6  Git e GitHub CLI"
if (Has 'git') { Ok (git --version) } else { Winget-Install 'Git.Git' 'Git for Windows'; Ok "Git instalado" }
if (Has 'gh')  { Ok "GitHub CLI encontrado" } else { Winget-Install 'GitHub.cli' 'GitHub CLI'; Ok "GitHub CLI instalado" }

Step "3/6  Claude Code"
if (Has 'claude') {
    Ok "Claude Code $(claude --version)"
} else {
    Info "Instalando o Claude Code com o instalador oficial..."
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
    Refresh-Path
    if (Has 'claude') { Ok "Claude Code $(claude --version)" }
    else { throw "O Claude Code foi instalado mas não está no PATH. Feche este terminal, abra outro e rode o script de novo." }
}

# 2. Dependências do projeto -----------------------------------------------------
Step "4/6  Dependências do Symphony"
npm install --no-fund --no-audit | Out-Host
npm run build | Out-Host
Ok "Symphony compilado"

# 3. Credenciais -------------------------------------------------------------------
Step "5/6  Credenciais"

if ($env:CLAUDE_CODE_OAUTH_TOKEN) {
    Ok "CLAUDE_CODE_OAUTH_TOKEN já configurado"
} else {
    Info "Agora vamos gerar o token do Claude (precisa de assinatura Pro, Max, Team ou Enterprise)."
    Info "O comando 'claude setup-token' vai abrir o navegador para você fazer login."
    Info "No final ele mostra um token que começa com 'sk-ant-oat01-'. COPIE esse token."
    Read-Host "    Aperte Enter para abrir o navegador"
    claude setup-token
    $token = Read-Secret "    Cole aqui o token (ele não aparece na tela) e aperte Enter"
    if ($token) { Save-UserEnv 'CLAUDE_CODE_OAUTH_TOKEN' $token; Ok "Token do Claude salvo" }
    else { Warn "Nenhum token colado. Rode este script de novo quando tiver o token." }
}

if ($env:LINEAR_API_KEY) {
    Ok "LINEAR_API_KEY já configurada"
} else {
    Info "Agora a chave de API do Linear:"
    Info "  1. Abra https://linear.app/settings/account/security"
    Info "  2. Em 'Personal API keys', clique em 'New API key', dê um nome (ex.: symphony) e crie."
    Info "  3. Copie a chave (começa com 'lin_api_')."
    $key = Read-Secret "    Cole aqui a chave do Linear (ela não aparece na tela) e aperte Enter"
    if ($key) { Save-UserEnv 'LINEAR_API_KEY' $key; Ok "Chave do Linear salva" }
    else { Warn "Nenhuma chave colada. Rode este script de novo quando tiver a chave." }
}

$ghOk = $true
try { gh auth status 2>$null | Out-Null; if ($LASTEXITCODE -ne 0) { $ghOk = $false } } catch { $ghOk = $false }
if ($ghOk) { Ok "GitHub CLI autenticado" }
else {
    Info "Agora o login no GitHub (para o agente conseguir dar push e abrir Pull Requests)."
    Info "Escolha: GitHub.com -> HTTPS -> Yes (autenticar o Git) -> Login with a web browser."
    gh auth login
    gh auth setup-git
}

# 4. Diagnóstico ---------------------------------------------------------------------
Step "6/6  Diagnóstico"
node dist/cli.js doctor WORKFLOW.md

Write-Host ""
Write-Host "Pronto! Para iniciar o Symphony:  npm start" -ForegroundColor Green
Write-Host "Painel: http://localhost:4000      Parar: Ctrl + C"
