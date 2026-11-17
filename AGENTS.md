# Guia de leitura para agentes de IA

Objetivo: entender e operar uma instalação **sua** do Lazy Labs Agentic Blog, sem assumir que o código público contém credenciais ou dados da instalação original.

1. Leia `README.md`, `docs/ARCHITECTURE.md`, `docs/API.md` e `docs/DEPLOYMENT.md` antes de planejar mudanças. `firebase.json` é a fonte de verdade para o roteamento do Hosting; `functions/index.js` é a fonte de verdade para Functions realmente exportadas.
2. `functions/api.js` continua legado; a API v1 ativa está em `functions/agent-api.js` e é exportada por `agentApi`. Leia `docs/AGENT_API.md` e seu esquema OpenAPI antes de operar.
3. Para operar conteúdo, gere um token de agente no admin com os escopos necessários e use `Authorization: Bearer <TOKEN>`. A rota `/api/agent` legada ainda exige Firebase Auth. Confirme a ação e o resultado antes de anunciar uma publicação.
4. Para criar ou editar código, preserve a validação no servidor, as regras de Firestore/Storage, o consentimento da newsletter e a distinção entre conteúdo público e dados privados. Nunca imprima tokens em logs ou respostas.
5. Faça alterações primeiro em ambiente local/emulador. Rode os testes existentes e verifique manualmente fluxos que envolvem Meta, e-mail ou provedores de IA antes de implantar.
6. A aplicação usa integrações e domínios configuráveis no bootstrap, mas ainda contém elementos de marca específicos. Procure valores fixos antes de propor uma instalação para outro domínio.

As ferramentas do agente e respectivos schemas são definidos em `functions/agent.js`; `GET /api/agent` retorna o catálogo de auditoria para um administrador autenticado.
