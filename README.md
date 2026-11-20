# Symphony (Claude Code + Linear) para Windows

Implementação em TypeScript do [Symphony](https://github.com/openai/symphony/blob/main/SPEC.md):
um serviço que fica olhando o seu projeto no **Linear** e, para cada issue pronta para trabalho,
cria uma pasta isolada, clona o repositório da **área logada** e coloca o **Claude Code** para
resolver a issue: ele programa, testa, abre um Pull Request no GitHub, comenta no Linear e move a
issue para revisão.

```
Linear (issues em "Todo")  ──►  Symphony  ──►  pasta por issue + Claude Code  ──►  PR no GitHub
        ▲                                                                           │
        └──────────── comentário + issue movida para "In Review" ◄──────────────────┘
```

> Repositórios envolvidos:
> - **este** (`Dylan-`): o Symphony em si + o `WORKFLOW.md` (as regras do agente).
> - **`area-logada`** (separado, você cria no passo 3): o código da área logada que os agentes alteram.

---

## Passo a passo (iniciante)

Tudo abaixo é feito no **PowerShell** do Windows. Para abrir: aperte a tecla Windows, digite
`PowerShell` e aperte Enter.

### Passo 1 — Baixar este projeto

```powershell
cd $HOME
git clone https://github.com/mmalu3557-debug/Dylan-.git
cd Dylan-
```

> Se aparecer "git não é reconhecido", instale o Git primeiro: `winget install Git.Git`,
> feche e abra o PowerShell, e repita o comando acima.

### Passo 2 — Rodar o instalador

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
```

O instalador faz, nesta ordem (e pula o que já estiver pronto):

1. Instala **Node.js**, **Git**, **GitHub CLI** e o **Claude Code** (instalador oficial
   `irm https://claude.ai/install.ps1 | iex`).
2. Instala as dependências do Symphony e compila (`npm install` + `npm run build`).
3. **Token do Claude:** roda `claude setup-token`. O navegador abre, você faz login na sua conta
   Claude (precisa ser assinatura Pro, Max, Team ou Enterprise) e, no final, o terminal mostra
   um token que começa com `sk-ant-oat01-...`. **Copie esse token** e cole quando o script pedir.
   Ele fica salvo na variável de ambiente `CLAUDE_CODE_OAUTH_TOKEN` da sua conta do Windows.
4. **Chave do Linear:** o script explica onde criar
   (Linear → Settings → Account → Security & access → *Personal API keys* → *New API key*) e
   pede para você colar. Ela fica salva na variável `LINEAR_API_KEY`.
   *Não cole a chave em chats nem no `WORKFLOW.md`* — ela só precisa existir no seu computador.
5. **Login no GitHub** (`gh auth login`): escolha *GitHub.com → HTTPS → Yes → Login with a web
   browser*. É isso que permite ao agente dar `push` e abrir Pull Requests.
6. Roda o diagnóstico (`npm run doctor`).

> Se der erro dizendo que algum comando "não é reconhecido" logo depois de instalar,
> feche o PowerShell, abra de novo, entre na pasta (`cd $HOME\Dylan-`) e rode o instalador outra vez.

### Passo 3 — Criar o repositório da área logada

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-area-logada-repo.ps1
```

Isso cria o repositório **privado** `area-logada` no seu GitHub (com `README`, `CLAUDE.md` com as
regras para os agentes e `.gitignore`) e já coloca a URL dele no `WORKFLOW.md`.

> Prefere fazer à mão? Crie o repositório em <https://github.com/new>, envie o conteúdo de
> `templates/area-logada` para ele e troque `SEU_USUARIO` na linha `after_create` do `WORKFLOW.md`.

### Passo 4 — Apontar para o seu projeto do Linear

Abra o `WORKFLOW.md` (ex.: `notepad WORKFLOW.md`) e troque
`COLE_AQUI_A_URL_DO_SEU_PROJETO_NO_LINEAR` pela URL do projeto — no Linear, abra o projeto e copie
a URL do navegador (algo como `https://linear.app/sua-empresa/project/area-logada-3f2a9c1b7d4e/overview`).

Confira também se os nomes dos estados (`Todo`, `In Progress`, `In Review`, `Done`) batem com os
do seu time no Linear. O diagnóstico do próximo passo lista os estados reais.

### Passo 5 — Diagnóstico

```powershell
npm run doctor
```

Tudo precisa aparecer com ✔. Cada ✖ vem com uma dica (→) do que fazer.

### Passo 6 — Iniciar o Symphony

```powershell
npm start
```

- Painel: <http://localhost:4000> (agentes rodando, fila, tokens, custo, erros).
- Para parar: `Ctrl + C`.
- Logs: pasta `log\` (`symphony.log` e, em `log\sessions\`, a conversa completa de cada agente).
- As pastas de trabalho ficam em `C:\Users\<você>\symphony_workspaces\<ISSUE>`.

Para testar: crie uma issue simples no projeto (ex.: "Criar página de login com e-mail e senha"),
coloque em **Todo** e acompanhe no painel.

---

## Como o fluxo funciona

| Estado no Linear | O que acontece |
|---|---|
| **Todo** / **In Progress** | Symphony despacha um agente (até `max_concurrent_agents` ao mesmo tempo). |
| **In Review** | O agente terminou e abriu o PR. Symphony para de mexer na issue. |
| **Done** / **Canceled** | Symphony apaga a pasta de trabalho da issue. |
| Volta para **Todo** | O agente retoma na mesma pasta/branch (ex.: para aplicar ajustes de revisão). |

Issues em **Todo** bloqueadas por outra issue ainda aberta ("blocked by") esperam o bloqueio acabar.

Se algo falhar (erro, travamento, sem resposta), o Symphony tenta de novo sozinho, esperando
10s, 20s, 40s… até no máximo 5 minutos entre tentativas.

## Mudando o comportamento

Tudo fica no `WORKFLOW.md` e vale **sem reiniciar** (o Symphony relê o arquivo ao salvar):

- **O texto abaixo do segundo `---`** é o prompt que o agente recebe. Escreva ali as regras do
  seu time (variáveis como `{{ issue.identifier }}` e `{{ issue.description }}` são preenchidas
  automaticamente).
- `agent.max_concurrent_agents`: quantas issues em paralelo.
- `claude.model`: escolha o modelo (ex.: `model: opus`); sem a linha, usa o padrão da sua conta.
- `tracker.required_labels: [symphony]`: só pega issues com essa label.
- `tracker.provider.assignee: me`: só pega issues atribuídas a você.

Se você salvar um `WORKFLOW.md` com erro, o Symphony continua com a última versão boa e mostra o
erro no painel e no log.

## Segurança (leia)

O modo configurado (`permission_mode: bypassPermissions`) é de **alta confiança**: o agente executa
comandos e edita arquivos sem pedir permissão. Proteções que o Symphony aplica:

- o agente só é iniciado dentro da pasta da própria issue (validado antes de iniciar);
- a chave do Linear **não** é passada para o agente: ele usa a ferramenta `linear_graphql`, que o
  Symphony executa por ele;
- o agente nunca fica esperando resposta humana (perguntas interativas estão desativadas);
- só issues do projeto configurado são consideradas.

Mesmo assim o agente roda com o **seu usuário do Windows** e o seu login do GitHub. Recomendações:
use issues de fontes confiáveis, proteja a branch `main` no GitHub (Settings → Branches → exigir PR),
e se quiser mais restrição troque para `permission_mode: acceptEdits` e liste os comandos
permitidos em `claude.allowed_tools` (ex.: `["Bash(npm *)", "Bash(git *)", "Bash(gh *)"]`).

## Problemas comuns

| Sintoma | Solução |
|---|---|
| `coding agent executable not found` | Feche e abra o PowerShell; ou rode o instalador de novo. |
| `missing Linear API key` | `setx LINEAR_API_KEY "lin_api_..."` e abra um PowerShell novo. |
| `project ... não encontrado` | Confira a URL do projeto no `WORKFLOW.md`. |
| Agente termina mas não abre PR | Rode `gh auth status`; se precisar, `gh auth login`. |
| `after_create hook failed` | A URL do repositório no `WORKFLOW.md` está errada ou sem acesso (`gh auth setup-git`). |
| Erro de login do Claude | Gere outro token com `claude setup-token`; remova `ANTHROPIC_API_KEY` se existir. |

## Para desenvolvedores

```powershell
npm test          # 70+ testes (inclui um ponta a ponta com Linear e Claude falsos)
npm run dev       # roda direto do TypeScript
npm start -- C:\caminho\WORKFLOW.md --port 4001
```

Detalhes de conformidade com a spec, perfil do adaptador do Linear e políticas de segurança:
[docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).
