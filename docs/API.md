# API operacional

Base URL após implantação: `https://SEU-DOMINIO`. O [mapa de rotas](ROUTES.md) lista todas as 47 regras do Firebase Hosting. As Functions exportadas estão em `functions/index.js`; valide o método e o corpo no handler indicado antes de automatizar escritas.

## Autenticação

- **Admin:** `Authorization: Bearer <FIREBASE_ID_TOKEN>`; o backend valida o token e exige custom claim `role=admin` ou e-mail verificado igual a `ADMIN_OWNER_EMAIL`. Alguns endpoints de leitura aceitam `viewer`.
- **Leitor:** Firebase ID token para favoritos e recursos de conta.
- **Meta webhook:** desafio GET com token de verificação e POST com assinatura `X-Hub-Signature-256`; não usa ID token de admin.
- **API REST v1 ativa:** `functions/agent-api.js` aceita tokens privados com hash SHA-256 e escopos. Veja [o contrato e os exemplos](AGENT_API.md). `functions/api.js` é legado e não é exportado.

As respostas costumam ser JSON `{ "ok": true, ... }` ou `{ "ok": false, "message": "..." }`; códigos HTTP variam por handler. Não trate `ok:true` como confirmação de entrega externa quando o retorno apenas enfileira uma tarefa.

## Artigos, leitores e mídia

| Método e rota | Acesso | Função / uso |
| --- | --- | --- |
| `POST /api/posts/list` | Público somente com `{ "status":"published", "blog_id":"ID_DO_BLOG" }`; outros filtros exigem admin/viewer | Lista posts para feed ou painel; `functions/posts.js` |
| `POST /api/posts/feedPreview` | Público | Trecho de post publicado |
| `POST /api/posts/related` | Público | Recomendações de artigos |
| `POST /api/posts/get` | Admin | Post completo para edição |
| `POST /api/posts/publish` | Admin | Cria ou atualiza post; corpo `{ "data": { "slug": "meu-post", "title": "Título", "content": "<p>Texto</p>", "status": "draft" } }` |
| `POST /api/posts/setStatus` | Admin | Altera status do post |
| `POST /api/posts/del` | Admin | Exclui post por slug |
| `POST /api/posts/translate` | Admin | Enfileira tradução dos idiomas ausentes |
| `POST /api/posts/taxonomyGet` / `taxonomyAdd` | Leitura pública / escrita admin | Categorias e tipos de post |
| `POST /api/posts/uploadImage` / `uploadVideo` / `finalizeStudioVideo` | Admin | Mídia do editor |
| `POST /api/posts/comments`, `commentReplies`, `commentCreate`, `likes`, `toggleLike` | Público com validações próprias | Comentários e reações |
| `POST /api/posts/engagement*`, `incrementView` | Público com validações próprias | Eventos e contadores de leitura |
| `POST /api/reader/list`, `status`, `toggle` | Leitor autenticado | Favoritos; `functions/reader.js` |
| `GET /artigo/<slug>`, `GET /artigo/<slug>.md` | Público | Artigo HTML ou Markdown; também `en`, `es`, `fr`, `de` conforme traduções disponíveis |
| `GET /rss.xml`, `GET /sitemap.xml` | Público | Feeds e índice |
| `GET/HEAD /media/blog-video/...`, `/media/blog-content/...` | Público | Mídia validada e servida por `posts` |

`POST /api/posts/publish` faz upsert; confira o status e a lista antes de repetir um pedido após timeout. `slug` identifica o documento `posts/<slug>`. O contrato completo de campos é a validação em `functions/posts.js`; integrações devem testar com rascunho antes de publicar.

## Agente e IA editorial

| Método e rota | Acesso | Uso |
| --- | --- | --- |
| `GET /api/agent` | Admin | Catálogo de ferramentas, parâmetros e exemplos de auditoria |
| `POST /api/agent` | Admin | Conversa com tool calling; corpo `{ "message":"Liste meus rascunhos", "history":[] }` |
| `GET /api/davi/status`; `POST /api/davi/chat`, `edit`, `diagram`, `metadata`, `image`, `socialDraft` | Admin | Serviços do editor/assistente; `functions/davi.js` |
| `POST /api/transcribe` | Admin | Áudio base64, `mimeType`, idioma e provedor; `functions/transcribe.js` |

O catálogo real de tools é `TOOLS` em `functions/agent.js`: listar/obter posts, criar rascunho, alterar status, publicar, listar inscritos, disparar WhatsApp, transcrever áudio, listar/criar leads. A descrição do catálogo contém algumas referências legadas a Supabase; a implementação e os testes devem prevalecer sobre esse texto.

Exemplo de chamada autenticada ao catálogo (substitua o domínio e obtenha o ID token via Firebase Auth):

```bash
curl -H 'Authorization: Bearer <FIREBASE_ID_TOKEN>' \
  https://SEU-DOMINIO/api/agent
```

## Newsletter, autores, gestão e integrações

| Prefixo / rotas | Acesso | Uso |
| --- | --- | --- |
| `/api/campaigns/subscribe` (`POST`) | Público, consentimento explícito | Inscrição |
| `/api/campaigns/open`, `click`, `unsubscribe` | URL assinada gerada pelo backend | Métricas e descadastro |
| `/api/campaigns/subscribers`, `list`, `detail`, `settings` | Admin | Lista, campanhas, detalhes e preferências |
| `/api/campaigns/subscriber`, `send`, `log` (`POST`) | Admin | Supressão/restauração, envio e registro |
| `/api/blogs/list`, `create`, `update`, `delete`, `verifyDomain` | Papéis verificados no handler | Gestão de blogs |
| `/api/authors/list`, `invite`, `regenerateToken`, `updateAdmin`, `delete`, `getByToken`, `updateProfile` | Admin ou token de convite conforme handler | Autores |
| `/api/products/*`, `/produto/*` | Público para oferta/evento, admin para gestão | Produtos e conversão |
| `/api/crm/*` | Sessão/usuário de CRM ou admin conforme ação | Leads, funis, negócios, usuários |
| `/api/social/*`, `/api/linkedin/*`, `/api/whatsapp/*` | Admin e/ou OAuth conforme ação | Distribuição social e mensagens |
| `/api/form/*`, `/api/bio/*` | Público para formulário/links; admin para configuração | Captação e bio |
| `GET /api/admin/session` | Admin | Verifica sessão; login legado retorna HTTP 410 |
| `/api/admin/listUsers`, `inviteUser`, `removeUser`, `profile`, `setresend` | Admin | Usuários e configuração de e-mail |
| `GET/POST/DELETE /api/meta/automations` | Admin | Lista/salva/remove regras; `GET ?action=media&channel=instagram|facebook` lista publicações |
| `GET/POST /api/meta/webhook` | Meta, assinatura válida | Verificação e eventos de comentários/mensagens |

`functions/crm.js` usa o campo de ação no corpo para operações de CRM; veja o switch `handleAction` para o schema específico. A automação Meta usa regras em `automations` e um fluxo de execução fixo; posições visuais dos blocos no editor não criam novas capacidades de execução.

## Tarefas sem rota pública

`translationTask`, `translationRetry`, `newsletterInactivitySweep`, `metaAutomationTask`, `metaAutomationPoll`, `reelPublicar` e tarefas do publicador são disparadas por Cloud Tasks ou Scheduler. Não chame suas URLs diretamente como se fossem endpoints de usuário.
