# Mapa completo de rewrites do Hosting

Gerado a partir de `firebase.json`. A ordem importa: a primeira regra correspondente vence. O status de autenticação e os métodos de cada Function são descritos em [API](API.md).

| Origem | Destino |
| --- | --- |
| `/api/meta/webhook` | `Function metaWebhook` |
| `/api/meta/automations` | `Function metaAutomations` |
| `/feed` | `/feed/index.html` |
| `/favoritos` | `/favoritos/index.html` |
| `/produto/**` | `Cloud Run / Function products` |
| `/api/products/**` | `Cloud Run / Function products` |
| `/en/artigo/**` | `Cloud Run / Function artigo` |
| `/es/artigo/**` | `Cloud Run / Function artigo` |
| `/fr/artigo/**` | `Cloud Run / Function artigo` |
| `/de/artigo/**` | `Cloud Run / Function artigo` |
| `/artigo/**` | `Cloud Run / Function artigo` |
| `/sitemap.xml` | `Cloud Run / Function sitemap` |
| `/rss.xml` | `Cloud Run / Function rss` |
| `/autor/**` | `Cloud Run / Function autorpages` |
| `/colaborar/**` | `Cloud Run / Function autorpages` |
| `/api/authors/**` | `Cloud Run / Function authors` |
| `/api/linkedin/**` | `Cloud Run / Function linkedin` |
| `/api/campaigns/**` | `Cloud Run / Function campaigns` |
| `/api/bio/**` | `Cloud Run / Function bio` |
| `/api/form/**` | `Cloud Run / Function form` |
| `/api/crm/**` | `Cloud Run / Function crm` |
| `/api/crm` | `Cloud Run / Function crm` |
| `/media/blog-video/**` | `Cloud Run / Function posts` |
| `/media/blog-content/**` | `Cloud Run / Function posts` |
| `/api/posts/**` | `Cloud Run / Function posts` |
| `/api/reader/**` | `Cloud Run / Function reader` |
| `/api/blogs/**` | `Cloud Run / Function blogs` |
| `/api/transcribe` | `Cloud Run / Function transcribe` |
| `/api/transcribe/**` | `Cloud Run / Function transcribe` |
| `/api/whatsapp/**` | `Cloud Run / Function whatsapp` |
| `/api/whatsapp` | `Cloud Run / Function whatsapp` |
| `/api/social/**` | `Cloud Run / Function social` |
| `/api/social` | `Cloud Run / Function social` |
| `/api/davi/**` | `Cloud Run / Function davi` |
| `/api/davi` | `Cloud Run / Function davi` |
| `/api/agent/**` | `Cloud Run / Function agent` |
| `/api/agent` | `Cloud Run / Function agent` |
| `/api/v1/**` | `Cloud Run / Function agentApi` |
| `/api/admin/**` | `Cloud Run / Function admin` |
| `/api/devops/**` | `Cloud Run / Function devops` |
| `/api/migrate` | `Cloud Run / Function migrate` |
| `/api` | `Cloud Run / Function admin` |
| `/api/**` | `Cloud Run / Function admin` |
| `/admin` | `/admin/index.html` |
| `/admin/**` | `/admin/index.html` |
| `/crm` | `/crm/index.html` |
| `**` | `/index.html` |

As tarefas de Cloud Tasks e Scheduler não aparecem como rewrites: são exportadas diretamente em `functions/index.js` e `publicador/index.js`.
