# Implantação em uma conta própria

Esta versão foi extraída de uma aplicação Lazy Labs. A implantação básica é Firebase; VM local pode executar emuladores para desenvolvimento, mas o projeto não tem servidor HTTP independente nem pacote Docker pronto. Apps Script é integração legada, não destino de implantação do blog.

## Pré-requisitos

- Node.js **22** para as Cloud Functions, npm e Firebase CLI.
- Projeto Firebase próprio com Hosting, Firestore, Authentication e Storage. Cloud Functions v2, Cloud Tasks e Scheduler podem exigir faturamento ativo. Confira cotas e alertas no seu projeto antes de ativar rotinas periódicas.
- Um site de Hosting criado no seu projeto e um domínio próprio ou subdomínio do Hosting.
- Provedores externos apenas se você usar os recursos correspondentes: DeepSeek/OpenAI/Groq/Cloudflare Workers AI, Meta, Resend, LinkedIn, WhatsApp, Supabase legado e outros.

## Configuração base

```bash
git clone https://github.com/davi-ramon/lazylabs-agentic-blog.git
cd lazylabs-agentic-blog
cp site.config.example.json site.config.local.json
# Edite site.config.local.json com seu projeto, site, domínio e configuração web do Firebase.
node scripts/configure.mjs
npm ci --prefix functions
npm ci --prefix publicador
```

No PowerShell, use `Copy-Item site.config.example.json site.config.local.json`. O script gera `.firebaserc` e substitui os marcadores em código e testes. É uma configuração inicial: execute uma vez em clone limpo e revise `git diff`. Valores opcionais não preenchidos permanecem com `YOUR_*` e os recursos correspondentes não funcionarão até serem configurados.

Encontre `firebaseWebApiKey`, `firebaseSenderId` e `firebaseAppId` no cadastro do aplicativo Web em Firebase → Configurações do projeto. A configuração web é pública por desenho; ela **não** substitui autenticação, regras e verificação no servidor. Nunca insira chaves de serviço ou tokens de provedores nesses campos.

Copie `functions/.env.example` para `functions/.env` e defina `ADMIN_OWNER_EMAIL` com uma conta do Firebase Auth cujo e-mail esteja verificado. O backend também aceita usuários com custom claim `role=admin`; estabeleça essa claim de forma administrativa na sua conta, e não por rota pública. Configure provedores de login no Firebase Authentication e seus domínios autorizados. Revise `firestore.rules` e `storage.rules` antes de implantar.

## Integrações opcionais

| Recurso | Configuração necessária |
| --- | --- |
| IA de texto, tradução, diagramas | Chaves/modelos na área protegida de configurações do admin; contas próprias do provedor |
| Capas de IA | Conta e token Cloudflare Workers AI ou outro provedor suportado |
| Instagram/Facebook | IDs próprios, app Meta, permissões, webhooks e `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_SYSTEM_USER_TOKEN`, `META_INSTAGRAM_USER_TOKEN` no Firebase Secret Manager |
| Newsletter | Remetente verificado e chave do serviço de e-mail no backend; consentimento explícito |
| Reels agendados | ID da conta Instagram, bucket, token Meta e Cloud Tasks em `publicador/` |
| Supabase/Apps Script | Legado; configure apenas se ainda precisar dessas rotas. Os placeholders do repositório não apontam para uma instância real |
| IndexNow | Defina `enableIndexNow: true` em `site.config.local.json` antes do script; ele gera chave e arquivo de prova local |

Para segredos da Meta, por exemplo: `firebase functions:secrets:set META_APP_SECRET`. Repita para os nomes de Secret Manager realmente usados; jamais coloque o valor em `site.config.local.json`. Os IDs da Página e da conta Instagram também devem ser salvos nas configurações administrativas da instalação.

## Testes e deploy

```bash
node --test functions/*.test.js public/*.test.js public/admin/*.test.js
firebase emulators:start --only hosting,functions,firestore,auth,storage
firebase deploy --only firestore,storage,functions,hosting
```

O Firebase CLI pode pedir índices adicionais para consultas novas. `firestore.indexes.json` acompanha o código. Alguns testes de integração externa precisam de contas e eventos reais; testes locais não provam entrega de Messenger, e-mail ou tradução por provedor. Após o deploy, verifique `/`, `/artigo/<slug>` com um post publicado, `/rss.xml`, `/sitemap.xml` e o login do `/admin` antes de habilitar automações.

## Limites de portabilidade

O código mantém o visual e certas decisões de produto da Lazy Labs. `functions/api.js` é experimental e não está conectado ao Firebase exportado. A automação Meta usa consulta periódica de dois minutos além do webhook, com custo potencial; não há escala ilimitada. Revise CORS, URLs, templates de e-mail, métricas, marcas e conteúdo editorial para sua instalação. Não importe dados ou contatos de outra pessoa sem base e consentimento adequados.
