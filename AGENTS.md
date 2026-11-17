# Guia de leitura para agentes de IA

Objetivo: entender e operar uma instalação **sua** do Lazy Labs Agentic Blog, sem assumir que o código público contém credenciais ou dados da instalação original.

1. Leia `README.md`, `docs/ARCHITECTURE.md`, `docs/API.md` e `docs/DEPLOYMENT.md` antes de planejar mudanças. `firebase.json` é a fonte de verdade para o roteamento do Hosting; `functions/index.js` é a fonte de verdade para Functions realmente exportadas.
2. `functions/api.js` é código legado/experimental não exportado. Nunca instrua um usuário a publicar via `/api/v1` sem antes implementar e testar essa ligação.
3. Para operar conteúdo, obtenha autorização administrativa e use o token Firebase Auth em `Authorization: Bearer <ID_TOKEN>`. A rota `/api/agent` também exige admin; não tem acesso anônimo. Confirme a ação e o resultado antes de anunciar uma publicação.
4. Para criar ou editar código, preserve a validação no servidor, as regras de Firestore/Storage, o consentimento da newsletter e a distinção entre conteúdo público e dados privados. Nunca imprima tokens em logs ou respostas.
5. Faça alterações primeiro em ambiente local/emulador. Rode os testes existentes e verifique manualmente fluxos que envolvem Meta, e-mail ou provedores de IA antes de implantar.
6. A aplicação usa integrações e domínios configuráveis no bootstrap, mas ainda contém elementos de marca específicos. Procure valores fixos antes de propor uma instalação para outro domínio.

As ferramentas do agente e respectivos schemas são definidos em `functions/agent.js`; `GET /api/agent` retorna o catálogo de auditoria para um administrador autenticado.
