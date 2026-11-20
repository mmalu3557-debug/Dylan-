# Instruções para agentes — repositório "área logada"

Este repositório contém o código da área logada (área autenticada do cliente).

## Stack

- Se o repositório ainda não tiver código, a primeira issue define a stack. Se ela não disser
  nada, use **Next.js (App Router) + TypeScript + Tailwind CSS**, com **npm** como gerenciador.
- Depois que a stack existir, siga o que já está no repositório; não troque de framework.

## Convenções

- TypeScript com `strict: true`. Nada de `any` sem justificativa.
- Componentes e telas em português do Brasil (textos visíveis ao usuário).
- Toda rota da área logada exige usuário autenticado; nunca exponha dados de outro usuário.
- Não coloque segredos no código. Use variáveis de ambiente e documente-as em `.env.example`.
- Escreva testes para regras de negócio e para fluxos críticos (login, permissões).

## Antes de abrir um PR

Rode, quando existirem no `package.json`:

```
npm ci
npm run lint
npm test
npm run build
```

Tudo precisa passar. Descreva no PR o que mudou e como testar.
