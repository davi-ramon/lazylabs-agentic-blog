# Arquitetura

## Visão geral

```text
Navegador → Firebase Hosting → HTML/JS estático (public/)
                           → rewrites → Cloud Functions v2 (functions/index.js)
                                             ├─ Firestore (posts, usuários, campanhas, configurações)
                                             ├─ Cloud Storage (mídia enviada)
                                             ├─ Cloud Tasks / Scheduler (tradução e Meta)
                                             └─ APIs opcionais (IA, Meta, e-mail, WhatsApp)
```

`public/` contém o feed, artigo, admin, CRM, favoritos, CSS e scripts do navegador. `functions/` contém as APIs, renderização de artigos, operações do agente, traduções, comentários, automações e integrações. `publicador/` é uma segunda codebase de Functions para Reels agendados. `firebase.json` escolhe a Function ou o arquivo estático para cada URL.

## Publicação de artigos

O admin envia dados a `POST /api/posts/publish` com ID token Firebase. `functions/posts.js` valida e grava em `posts/<slug>` no Firestore. A Function `artigo` renderiza `/artigo/<slug>` e variantes traduzidas. A tradução usa a integração de IA configurada e é processada em tarefas; a publicação base pode aparecer antes de todos os idiomas. RSS, sitemap e rota Markdown são gerados a partir dos posts publicados. A rota `.md` é uma representação do artigo, não um arquivo duplicado no Storage.

## Leitores e newsletter

O feed carrega posts publicados por `POST /api/posts/list`. Favoritos exigem conta Firebase Auth em `/api/reader/*`. Comentários e métricas são tratados no backend de posts, com regras próprias de validação. A newsletter grava inscritos em `newsletter_subscribers`, exige consentimento explícito para novas inscrições e registra envios em `campaigns` com subcoleção `recipients`. O serviço de e-mail é opcional e exige chave própria.

## Agente

`functions/agent.js` recebe mensagens de administradores autenticados, fornece ferramentas como listar posts, criar rascunhos e publicar, e registra resultados. As ferramentas usam Firestore ou funções internas/HTTP; as chamadas dependem das integrações configuradas. O catálogo de auditoria pode ser consultado com `GET /api/agent` autenticado. O agente não deve ganhar permissão de admin por prompt, header fixo ou conteúdo de artigo.

## Meta e distribuição

`/api/meta/webhook` verifica o desafio de inscrição e a assinatura HMAC de eventos. `metaAutomationTask` processa eventos em Cloud Tasks. `metaAutomationPoll` consulta comentários a cada dois minutos como apoio operacional. Regras ficam em `automations`, e eventos de processamento em `events`. Instagram e Facebook dependem das permissões e IDs da conta de cada implantador. A entrega de mensagem no Messenger depende também do tratamento da conversa pela Meta; o código não controla a classificação da caixa de entrada.

## Dados e fronteiras

O cliente Firebase contém apenas a configuração web pública de **sua** instalação. Tokens de Meta, IA, e-mail e outros provedores devem ficar em Secret Manager ou no armazenamento de configuração protegido pelo backend. Firestore Rules permitem leitura pública apenas de posts publicados; APIs administrativas usam Admin SDK e checam Firebase Auth. As regras de Storage restringem gravação de vídeo a usuários com claim `admin`.
