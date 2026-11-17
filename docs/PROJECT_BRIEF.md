# Resumo do projeto para programas de créditos

**Problema:** publicar conteúdo técnico com qualidade exige editor, mídia, distribuição, tradução, análise de leitura e manutenção de integrações. Pequenos criadores costumam operar essas etapas em ferramentas separadas.

**Proposta:** um blog com infraestrutura Firebase e um painel que permite a autores e agentes de IA preparar rascunhos, revisar texto, gerar material visual em código, publicar, traduzir e distribuir conteúdo a partir de fluxos autenticados. Leitores têm feed, comentários, favoritos e versão Markdown de artigos.

**Tecnologia atual:** Node.js 22, Firebase Hosting/Functions/Firestore/Storage/Auth, Cloud Tasks/Scheduler, integrações opcionais com provedores de IA, Meta e e-mail. O catálogo de ferramentas em `functions/agent.js` permite inspecionar ações disponíveis. O uso de IA gera custo por chamada no provedor escolhido; o projeto não promete operação gratuita nem autonomia sem supervisão.

**Uso proposto de créditos de IA:** testar modelos para edição e revisão de artigos, tradução culturalmente adequada, diagramas explicativos em código e auxílio editorial por agentes; medir qualidade, latência e custo por artigo em ambiente próprio. Este repositório não contém métricas verificadas de audiência, receita ou economia de custos.

**Estado e próximos marcos:** o código de produto existe e a implantação original foi usada para publicação. O código está sob licença MIT. Para adoção externa faltam um instalador mais genérico, testes de integração reproduzíveis e substituição completa de elementos de marca. O plano de créditos deve especificar hipóteses, orçamento e métricas do piloto sem inflar resultados.
