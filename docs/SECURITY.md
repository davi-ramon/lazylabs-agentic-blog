# Segurança e privacidade

- O repositório não inclui `.env`, `.firebaserc` real, service accounts, tokens Meta, chaves de IA, banco de dados, contatos, campanhas ou histórico Git da aplicação original.
- Configurações web Firebase e publishable keys não dão poder administrativo sozinhas, mas cada implantação deve usar valores próprios e regras restritivas. Tokens de servidor ficam em Secret Manager ou configuração protegida por Functions.
- O admin verifica Firebase ID token e `role=admin` ou o e-mail verificado configurado em `ADMIN_OWNER_EMAIL`. O login legado por senha retorna 410. Não exponha a variável de bootstrap nem use `owner@example.com` como e-mail real.
- A rota do agente exige a mesma autenticação administrativa; conteúdo de artigo ou prompt do usuário não deve alterar permissões. Confirme as ações de escrita do agente e revise logs sem registrar credenciais.
- A inscrição na newsletter exige `consent: true`. O painel distingue inscritos ativos, suprimidos e sem consentimento. Importar contatos não deve marcar consentimento automaticamente sem registro válido.
- O webhook Meta exige validação de assinatura; a confirmação GET usa token de verificação. Não use o mesmo token para app secret, verificação e acesso à API.
- O usuário do Firebase Admin SDK contorna Firestore Rules; por isso a autorização em cada Function é indispensável. Revise endpoints públicos e limites de corpo antes de abrir uma instalação para tráfego real.
- Faça uma varredura de segredos em cada alteração antes de `git push`. Este extrato foi revisado, mas futuras configurações locais não são automaticamente seguras.

Se encontrar uma vulnerabilidade, comunique ao mantenedor por canal privado; não publique credenciais nem dados de leitores em issues.
