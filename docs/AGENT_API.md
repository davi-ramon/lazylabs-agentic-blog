# API para agentes — Lazy Labs Blog

Qualquer LLM capaz de fazer chamadas HTTP pode operar o blog. O provedor da IA não precisa ser instalado no servidor. O agente recebe um token `llb_…` e usa a API REST. Uma assinatura do ChatGPT, Claude ou DeepSeek não equivale a uma integração automática: o aplicativo ou ferramenta onde o agente roda precisa suportar requisições HTTP e guardar o token com segurança.

Base: `https://blog.example.com/api/v1`. Esquema OpenAPI: `GET /api/v1/openapi.json` com token de agente. Endpoint de saúde público: `GET /api/v1/health`.

## Criar e proteger um token

No admin, abra **Configurações → Integrações e APIs → API para agentes de IA**. Informe nome, validade e escopos. Copie o token quando aparecer; o servidor salva apenas SHA-256 e não poderá mostrá-lo novamente. Use um token por agente e somente os escopos necessários. Revogue-o no mesmo painel se houver exposição. Validade máxima: 365 dias.

O acesso de gerenciamento dos tokens requer a sessão Firebase de administrador. A API de agente usa `Authorization: Bearer <token llb_…>`. Não coloque o token em HTML público, repositórios, prompts publicados ou código do navegador. Guarde-o no cofre de segredos do serviço de agentes ou em variável de ambiente do backend. O limite temporário é 120 requisições por minuto por token por instância; também se aplicam limites da Meta, provedores de e-mail, Firebase e redes sociais.

## Escopos

| Escopo | Ações |
| --- | --- |
| `posts:read` | Listar e ler artigos |
| `posts:write` | Criar e editar rascunhos |
| `posts:publish` | Publicar, arquivar e solicitar tradução; requerido para editar artigo já publicado |
| `posts:schedule` | Agendar; requerido para editar artigo agendado |
| `posts:delete` | Excluir artigo e traduções |
| `media:write` | Enviar arquivos e gerar incorporações |
| `newsletter:read` | Histórico e métricas de campanhas |
| `newsletter:send` | Enviar campanha para inscritos ativos que consentiram |
| `social:write` | Preparar e publicar em canais sociais configurados |
| `automations:read`, `automations:write` | Ver e alterar automações Meta |

## Rotas editoriais

| Método | Rota | Dados principais |
| --- | --- | --- |
| GET | `/capabilities` | Escopos do token e recursos |
| GET | `/posts?status=published` | Até 200 artigos por página de listagem interna; status: `draft`, `scheduled`, `published`, `archived` |
| GET | `/posts/{slug}` | Artigo completo |
| POST | `/posts` | `slug`, `title`, `content_html`, opcionalmente `excerpt`, `category`, `post_type`, `tags`, `cover_url`, `auto_translate`, `tts_enabled` |
| PATCH | `/posts/{slug}` | Atualiza campos editoriais, mantendo os demais |
| DELETE | `/posts/{slug}` | Exclusão permanente |
| POST | `/posts/{slug}/publish` | Publica agora |
| POST | `/posts/{slug}/schedule` | `{ "scheduled_at": "2026-12-01T14:00:00Z" }` |
| POST | `/posts/{slug}/archive` | Arquiva |
| POST | `/posts/{slug}/translate` | Enfileira traduções do artigo publicado |

O agendador consulta o Firestore a cada dois minutos e publica artigos vencidos. Portanto, a publicação pode ocorrer alguns minutos após o horário escolhido. A tradução usa a fila atual do blog e pode continuar depois da resposta de publicação.

## Mídia e distribuição

| Método | Rota | Dados principais |
| --- | --- | --- |
| POST | `/media/embed` | `{ "urls": ["https://www.youtube.com/shorts/…", "https://www.instagram.com/reel/…"] }`; retorna HTML seguro para inserir em `content_html` |
| POST | `/media/image` | Base64 e parâmetros aceitos pelo uploader de imagens do blog |
| POST | `/media/video` | Base64 e parâmetros aceitos pelo uploader de vídeo do blog |
| GET | `/newsletter/campaigns` | Histórico |
| GET | `/newsletter/campaigns/{id}` | Entrega, abertura e cliques |
| POST | `/newsletter/send` | `{ "slug": "artigo-publicado", "subject": "Assunto" }` e cabeçalho `Idempotency-Key` |
| POST | `/social/draft` | Título, slug, conteúdo e resumo para preparar cópia social |
| POST | `/social/publish` | `{ "slug": "artigo-publicado", "channel": "facebook" }` e `Idempotency-Key` |
| GET | `/automations` | Regras atuais |
| POST | `/automations` | Mesmo formato validado pelo editor de automações Meta |
| DELETE | `/automations/{id}` | Desativa a regra |

Os envios reais dependem das contas externas já configuradas. A API não consegue inventar permissões da Meta, criar crédito no Resend ou contornar spam do Messenger. `Idempotency-Key` deve ser um identificador único de 12 a 100 caracteres para cada envio; repetir a chave recebe `409`, evitando reenvio acidental. Para automações de comentário, o fluxo continua restrito à semântica que o worker Meta implementa.

## Exemplo de fluxo

```bash
export LAZY_BLOG_TOKEN='llb_…'
curl -sS https://blog.example.com/api/v1/capabilities \
  -H "Authorization: Bearer $LAZY_BLOG_TOKEN"

curl -sS https://blog.example.com/api/v1/posts \
  -H "Authorization: Bearer $LAZY_BLOG_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"meu-artigo","title":"Meu artigo","content_html":"<h2>Introdução</h2><p>Texto do artigo.</p>","category":"Tecnologia","tags":["IA"]}'

curl -sS -X POST https://blog.example.com/api/v1/posts/meu-artigo/publish \
  -H "Authorization: Bearer $LAZY_BLOG_TOKEN"
```

Para mídia, envie o arquivo ao endpoint, use a URL retornada como `cover_url` ou insira o HTML retornado por `/media/embed` no artigo. Para newsletter, confirme que o artigo está publicado e chame `/newsletter/send` com uma chave única. Recomenda-se separar o agente que redige do agente que publica ou envia campanhas, concedendo escopos diferentes.

