# Auditoria final de publicação — 16/10/2026

**Veredito: APTO PARA PUBLICAÇÃO do repositório e avaliação técnica, com as ressalvas abaixo.** Não é uma certificação de produção nem confirmação de atendimento integral de cenários não executados. Não houve push ou envio de candidatura.

Fonte comparada: [README oficial Jungle Gaming](https://github.com/junglegaming/backend-challenge), seções 1–14, consultado novamente nesta auditoria. Evidências: código versionado, migrations, execução real e reprodução a partir de `git archive HEAD`.

## Critérios obrigatórios

| Requisito | Classificação | Evidência / limite |
|---|---|---|
| Bun, NestJS, TypeScript estrito, PostgreSQL, MikroORM, Compose/SQS | PASSOU | instalação congelada, build e containers reais |
| Dinheiro decimal exato, validação, moeda e escala | PASSOU | Money/Decimal, numeric(18,2), strings; testes unitários e fronteira de precisão |
| Wallet única, saldo não negativo e OPENING | PASSOU | constraints, abertura positiva/zero e integração |
| BET/WIN/LOSS/REFUND/ROLLBACK | PASSOU | regras unitárias e persistência real; rejeição de reversão sem fundos distinta de BET |
| Referência por provedor e validação de contexto/valor | PASSOU | WagerRules e lookup composto, testes de referências inválidas |
| Ledger imutável e saldo consistente | PASSOU | triggers UPDATE/DELETE/TRUNCATE, aritmética, constraints diferidas e reconciliação |
| Concorrência por wallet entre instâncias | PASSOU | FOR UPDATE, três processos e timeout de lock |
| Idempotência persistente, conflito e saldo original | PASSOU | chave/hash/resultado no banco e replay histórico testado |
| Inbox, saldo, ledger e outbox atômicos | PASSOU | conflito tardio de inbox provoca rollback completo |
| Referência fora de ordem, backoff e limite | PASSOU | pendência, reprocessamento e esgotamento testados |
| HTTP obrigatório, erros distintos e cursor | PASSOU | endpoints presentes; 200/201/202/400/404/409/422/503 exercitados |
| Reconciliação sem ajuste silencioso | PASSOU | lock/soma/resposta implementados; consistência normal testada |
| Sinalização de divergência após corrupção administrativa | NÃO VERIFICADO | caminho existe; não se desabilitaram constraints para fabricar corrupção |
| SQS com mesmo use case, inbox e ack pós-commit | PASSOU | redelivery e morte real depois de commit/antes de ack |
| Retry e DLQ | PASSOU | recebimentos reais com backoff, esgotamento e mensagem inválida |
| Outbox e publishers concorrentes | PASSOU | ambos publishers reivindicam trabalho; falha/republicação verificadas |
| Envelope de eventos versionado por subclasses | PASSOU | IntegrationEvent e quatro subclasses concretas; JSON sem instâncias Money |
| Logs, métricas, liveness e readiness | PASSOU | revisão do código, métricas/lock e falha de conexão exercitados |
| SIGTERM gracioso em Linux durante mensagem em andamento | NÃO VERIFICADO | hooks implementados; crash/restart Windows não substituem esse teste |
| Migrations versionadas e reversíveis | PASSOU | três migrations, up/down/up em banco exclusivo |
| Testes de domínio, integração e concorrência | PASSOU | 77 testes, PostgreSQL/SQS reais; todos os oito grupos de cenários da seção 13 representados |
| Alternativa de autenticação aceita | PASSOU | ProviderIdentityGuard no-op explícito e desenho OIDC documentado |
| README e ARCHITECTURE | PASSOU | instruções reproduzidas com código extraído do Git; decisões/limitações documentadas |

## Restrições eliminatórias

Nesta tabela, PASSOU significa que a restrição foi respeitada na revisão e nos cenários executados; não significa prova formal para qualquer carga possível.

| Restrição | Classificação | Evidência |
|---|---|---|
| Não usar number/float para dinheiro | PASSOU | Decimal/string/numeric; number restrito a contagens, versões e tempos |
| Não permitir saldo negativo por race | PASSOU | CHECK e BETs concorrentes de 80 sobre 100; saldo final 20 |
| Não duplicar débitos/créditos | PASSOU | 50 duplicatas, replay, reversões e redelivery |
| Não manter idempotência somente em memória | PASSOU | índices únicos e resultado persistido |
| Não depender de uma única instância | PASSOU | três processos simultâneos |
| Não publicar antes do commit | PASSOU | outbox no commit financeiro; publisher em outra transação |
| Não omitir ledger auditável | PASSOU | ledger persistente append-only |
| Não substituir completamente PostgreSQL/SQS por mocks | PASSOU | dois ambientes reais executados |
| Não confiar somente em FIFO / lock global | PASSOU | garantias no PostgreSQL e locks por linha |

## Validação executada nesta auditoria

| Execução | Classificação | Resultado |
|---|---|---|
| Build no workspace | PASSOU | `bun run build` |
| Lint no workspace | PASSOU | `bun run lint`, zero erros |
| Suíte completa no workspace | PASSOU | 77 passaram, 0 falharam, 181 asserções, 47,90s |
| Instalação somente dos arquivos do Git | PASSOU | git archive de e998c92, sem node_modules/dist/.env locais; bun install --frozen-lockfile |
| PostgreSQL/LocalStack com volumes novos | PASSOU | projeto isolado jungle-delivery-audit, portas 25433/24566 |
| Setup, migrations, filas, build e lint na cópia limpa | PASSOU | todos com exit code 0 |
| Suíte completa na cópia limpa | PASSOU | 77 passaram, 0 falharam, 181 asserções, 48,38s |
| Migrations up/down/up na infraestrutura isolada | PASSOU | banco wagering_migration_test_1792125250511 |
| Consistência global no banco isolado | PASSOU | consulta SQL final: zero wallets divergentes |
| Instalação em outra máquina/OS sem cache de imagens | NÃO VERIFICADO | fonte/dependências/volumes novos foram testados no mesmo host; imagens Docker disponíveis localmente |

## Segurança e integridade do Git

| Verificação | Classificação | Resultado |
|---|---|---|
| .env real versionado | PASSOU | apenas .env.example; .env e .env.production ignorados; histórico de nomes também revisado |
| Tokens/chaves privadas reconhecíveis | PASSOU | nenhum achado em 78 blobs históricos; padrões de chaves privadas, GitHub, AWS e tokens comuns |
| Revisão de referências a credenciais | PASSOU | encontrados defaults locais públicos, não credenciais de serviços reais |
| Ausência absoluta de senhas literais | FALHOU | existe senha de demonstração jungle_dev e credenciais LocalStack test; são explícitas e necessárias ao setup local, não segredos privados |
| Arquivos importantes fora do Git | PASSOU | archive instala, compila e testa sem arquivos locais; fontes, scripts, Dockerfile, migrations e lockfile versionados |
| Diferenças e commits identificados | PASSOU | master/origin/master locais em 4a94474; três commits de implementação anteriores à auditoria |
| Estado remoto atualizado nesta auditoria | NÃO VERIFICADO | comparação com refs locais; nenhum novo fetch/push necessário para verificar a entrega local |

A busca por padrões não prova ausência de todo segredo imaginável. Não foram encontrados segredos reais no escopo examinado. Credenciais locais são documentadas como descartáveis; isso não autoriza reutilizá-las em produção. Nenhum valor privado foi exposto em logs da auditoria.

## Correções limitadas à entrega

1. README agora usa `docker compose up -d --wait`: evita rodar migration antes da infraestrutura estar saudável em ambiente novo.
2. Build exclui `.tmp`: uma cópia de auditoria dentro dessa pasta não pode entrar como fonte TypeScript do aplicativo. Build/lint reexecutados após a alteração.

Não foram acrescentadas funcionalidades opcionais nem encontradas falhas financeiras críticas nos cenários verificados. O corpo da implementação financeira permaneceu inalterado nesta auditoria.

## Branch, commits e escopo

Branch: `codex/complete-wagering-challenge`. Base: `4a94474`, também preservada em `recovery/pre-challenge-20261016`.

- `c50734f`: fluxo financeiro/persistência e integração.
- `84cdca6`: concorrência, crash recovery, regras/schema e testes.
- `e998c92`: documentação e validação anterior.
- A auditoria é registrada em um commit local adicional, contendo este relatório, ajuste do README e exclusão de temporários do build.

Antes da auditoria, a diferença contra master abrangia 36 arquivos, 3.989 inserções e 97 remoções. A mudança atual é restrita à documentação/configuração de build. A reprodução limpa confirmou que nenhum arquivo obrigatório dependia de conteúdo não versionado.

## Veredito e ressalvas

**APTO PARA PUBLICAÇÃO DO REPOSITÓRIO PARA AVALIAÇÃO.** Nenhum bloqueador eliminatório foi detectado. Isso não equivale a aptidão para produção ou a promessa de nota máxima: SIGTERM gracioso Linux e corrupção administrativa não foram exercitados; a modelagem usa SQL explícito pelo MikroORM e entidades de estado simplificadas, conforme trade-offs documentados. Autenticação completa é uma omissão aceita pelo enunciado, não uma funcionalidade entregue.

Containers isolados de auditoria foram parados após os testes, preservando volumes e evidências. Os containers originais Jungle permaneceram saudáveis; BizManager não foi administrado. Nenhum push e nenhuma candidatura enviados.
