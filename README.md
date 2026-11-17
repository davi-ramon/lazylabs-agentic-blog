# Lazy Labs Agentic Blog

Código do blog da Lazy Labs: editor e painel administrativo, publicação de artigos, páginas renderizadas no servidor, feed, contas de leitores, newsletter, CRM e integrações opcionais com IA e redes sociais. A aplicação usa Firebase Hosting, Cloud Functions (Node.js 22), Firestore e Cloud Storage. Agentes de IA podem operar o blog por uma rota autenticada de ferramentas; a publicação nunca é aberta a visitantes anônimos.

> **Estado do projeto:** este é um extrato de código da aplicação em produção, preparado para estudo e implantação em uma conta própria. Não é um instalador de um clique. A marca, algumas telas e fluxos são específicos da Lazy Labs; integrações externas exigem contas, permissões e configuração próprias. Nenhum banco de dados, conteúdo publicado, lista de contatos ou segredo de produção acompanha o repositório.

## O que existe

- Editor visual de artigos com revisão/reescrita por IA, diagramas, mídia incorporada, prompts copiáveis, ditado e geração de capas opcional.
- Artigos em português e traduções para inglês, espanhol, alemão e francês; versão Markdown por artigo, RSS e sitemap.
- Feed, favoritos de leitores, comentários, métricas de leitura e produtos.
- Newsletter com consentimento, campanhas e métricas; CRM e gestão de autores.
- Automação de comentários Instagram/Facebook e entrega por Direct/Messenger, mediante configuração da Meta; agenda de Reels em codebase separada.
- Agente administrativo com catálogo auditável de ferramentas e APIs de publicação protegidas.

## Começar

1. Crie um projeto Firebase próprio, ative Firestore, Authentication, Storage, Hosting e faturamento compatível com Functions v2 e tarefas agendadas. Instale Node.js 22 e Firebase CLI.
2. Clone o repositório. Copie `site.config.example.json` para `site.config.local.json`, preencha os valores da sua conta e execute `node scripts/configure.mjs`. O arquivo local é ignorado pelo Git. Revise o diff antes de implantar.
3. Execute `npm ci --prefix functions` e `npm ci --prefix publicador`.
4. Configure a autenticação administrativa e os segredos das integrações escolhidas conforme [Implantação](docs/DEPLOYMENT.md). Não exponha chaves de servidor em HTML, JavaScript do navegador ou no Git.
5. Rode `node --test functions/*.test.js public/*.test.js public/admin/*.test.js` e implante com `firebase deploy --only firestore,storage,functions,hosting` após revisar regras, domínio e custos.

O caminho completo, com etapas opcionais e limites, está em [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [Arquitetura](docs/ARCHITECTURE.md) | Componentes, fluxos e dados |
| [API](docs/API.md) | Autenticação, endpoints e exemplos para agentes |
| [Mapa de rotas](docs/ROUTES.md) | Todas as regras de rewrite do Hosting |
| [Implantação](docs/DEPLOYMENT.md) | Configuração, testes e deploy |
| [Segurança](docs/SECURITY.md) | Credenciais, dados e limites de publicação |
| [Guia para agentes](AGENTS.md) | Como uma LLM deve navegar e alterar este código |
| [Resumo do projeto](docs/PROJECT_BRIEF.md) | Contexto para candidatura a créditos de IA |

A API REST v1 para agentes usa tokens privados com escopos. Consulte [API para agentes](docs/AGENT_API.md) para criar e revogar tokens, publicar, agendar e distribuir artigos. `functions/api.js` permanece legado e não é exportado.

## Licença

O código e a documentação estão sob a [licença MIT](LICENSE). Credenciais, dados de usuários e conteúdo de terceiros não fazem parte desta distribuição. A marca Lazy Labs permanece identificada no projeto; quem implantar uma instância própria deve ajustar nome, domínio, conteúdo e integrações.
