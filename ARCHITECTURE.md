# Arquitetura e decisões

## Organização e ORM

domain/ contém Money, Wallet, WalletLedgerEntry, WagerTransaction, InboxMessage, OutboxMessage, WagerRules e subclasses de IntegrationEvent, sem NestJS/ORM. Construtores privados/protegidos e factories separam criação e reidratação. WagerTransaction encapsula transições; o registro persistente guarda a identidade e o payload completo. WagerRules concentra regras de referências e direções.

WageringService coordena o mesmo caso de uso para HTTP e SQS. Cada operação usa em.fork().transactional(), isolando Identity Map e transação. SQL parametrizado por EntityManager.execute usa o contexto transacional ativo do MikroORM; não há segundo pool para processar finanças. SQL explícito facilita revisão de locks, índices parciais e triggers. Trade-off: as tabelas adicionais são gerenciadas por migrations, não pelo gerador de schema. Não executar schema:update ou gerar migrations somente a partir de WalletRecord.

## Dinheiro e estados

Money é decimal.js imutável; entrada/saída e numeric(18,2) do PostgreSQL permanecem strings. Não há number para dinheiro. A API limita a 16 dígitos inteiros, mantendo adições dentro da precisão decimal. number representa apenas contagens, tempos, limites e versões.

Wallet é reidratada sob lock. Debit/credit validam moeda e saldo; WalletLedgerEntry.create verifica a aritmética antes/depois. LOSS não altera saldo/versão/ledger. OPENING positivo gera crédito e mantém versão 1; saldo zero não gera lançamento.

Transições: PENDING → PROCESSED/REJECTED/FAILED/PENDING_REFERENCE; PENDING_REFERENCE → PENDING_REFERENCE/PROCESSED/REJECTED/FAILED. Estados terminais não mudam, protegidos em classe e trigger. FAILED fica reservado a tratamento operacional de falhas permanentes de registros existentes; indisponibilidade do banco não é registrada falsamente como rejeição financeira. Mensagens impossíveis de persistir ficam auditáveis na DLQ.

WIN/LOSS podem referenciar BET. REFUND só reverte BET; ROLLBACK reverte BET/WIN/REFUND. Toda referência é validada por provider/player/wallet/moeda/rodada, com valor integral nas reversões. Conforme a regra literal, unicidade da reversão é por reference+kind: REFUND e ROLLBACK sobre uma BET são permitidos uma vez cada. Não se presume exclusão entre tipos nem cancelamento automático de resultados. WIN independente de BET é permitido; LOSS aceita valor não negativo, sem efeito financeiro.

## Concorrência e schema

Ordem única: lock de wallet (SELECT FOR UPDATE), verificar/criar transação, validar referência, alterar saldo, ledger, outbox, inbox, commit. O lock de linha PostgreSQL funciona entre processos/máquinas; wallets distintas não dividem mutex global. Lock timeout 5s e statement timeout 10s. Após 503, o cliente reenvia com mesma chave.

Constraints únicas: player+moeda, idempotency key global, provider+ID externo, lançamento por transação/wallet, consumer+messageId e reversão por referência/tipo. CHECKs impedem saldo negativo, montante não positivo e aritmética incorreta. Ledger rejeita UPDATE, DELETE e TRUNCATE. Identidade/moeda da wallet são imutáveis; versão só incrementa com saldo.

Triggers diferidas verificam no commit saldo=soma assinada do ledger, moeda/status/wallet, ledger obrigatório para transação financeira processada e ausência para LOSS/rejeições. Nada é publicado no fluxo financeiro. Qualquer falha antes do commit desfaz transação, saldo, ledger, inbox e outbox. Teste força conflito de inbox após gerar os demais efeitos e comprova rollback completo.

## Idempotência

HTTP usa header Idempotency-Key; SQS usa data.idempotencyKey. SHA-256 sobre JSON canônico do DTO validado: campos de negócio selecionados, chaves de objetos ordenadas recursivamente, dinheiro normalizado e referência omitida quando ausente. Header/metadados não entram no hash.

Resultado terminal persistido inclui saldo observado; replay não é recalculado usando saldo atual. Replay pendente devolve o estado persistido mais recente sem contornar backoff. Mesmo ID externo com chave diferente é conflito. Inbox compara hash e identidade da transação, na mesma transação SQL. FIFO é otimização.

## Mensageria e recuperação

Ack ocorre depois que submit resolve, inclusive constraints diferidas. Crash entre commit e ack produz redelivery sem novo débito. A suíte mata realmente um worker nesse ponto, inicia sucessor e verifica saldo/inbox/ledger.

Retry de referência seleciona vencidos, bloqueia wallet e revalida status/prazo. Instâncias concorrentes não aplicam a mesma pendência. Oito retries após aceitação inicial; espera nominal total 510 segundos mais polling/carga. Esgotamento gera rejeição+evento. Evento de pendência é emitido apenas na entrada no estado.

Publisher bloqueia linhas da outbox com SKIP LOCKED, sem locks de wallet. Mantém transação aberta durante envio SQS: recuperação simples, ao custo de conexão durante rede. Conexão limitada a 2s, requisição a 5s, SDK até duas tentativas. Falha mantém registro com backoff. Publicou e caiu antes de publishedAt: evento reaparece com mesmo eventId. Consumidores externos devem deduplicar persistentemente por eventId; a janela FIFO não substitui isso.

Não há garantia de ordem global ou estrita entre publishers; WalletBalanceChanged carrega walletVersion. Eventos confirmados permanecem na outbox e não são descartados por limite de tentativas.

beforeApplicationShutdown interrompe agendamento e drena lote antes do ORM fechar; mensagens recebidas ainda não iniciadas recuperam visibilidade. onApplicationShutdown fecha SQS. Hooks SIGTERM habilitados. Testes Windows comprovam crash abrupto/restart; shutdown gracioso em Linux não foi exercitado.

## Observabilidade

Reconciliação usa lock da wallet para visão consistente entre saldo e soma, devolve diferença sem corrigir silenciosamente e registra divergência. Cursor base64url contém walletId e sequence; bigint permanece string. O lock por wallet assegura ordem dos lançamentos confirmados daquela wallet.

Logs JSON com correlationId/messageId/transactionId/walletId/providerId, sem montantes ou payload financeiro completo. Logging de SQL desabilitado. Métricas Prometheus: tentativas por status, duplicatas, retries, DLQ, conflitos de lock, divergências, soma/contagem de latência e lag da outbox consultado do banco. Contadores são locais ao processo e reiniciam; coletor externo agrega/persiste. Live independe da infraestrutura; ready verifica PostgreSQL/SQS.

## Autenticação

Alternativa explicitamente aceita pelo desafio: ProviderIdentityGuard no-op. Extensão planejada: OIDC via Keycloak/Zitadel, JWT/JWKS com issuer/audience/expiração e vínculo entre claim de provider e providerId. Nenhuma tabela de senhas. Health aberto; SQS é canal interno confiável mas aplica validação de DTO/domínio. Autorização/rate limiting são necessários antes de exposição pública.

## Limitações

- Não há exactly-once no broker: efeito financeiro único no banco, eventos at-least-once.
- Trigger soma histórico em cada commit; favorece correção auditável, mas é O(n) por wallet. Para escala, estudar cadeia de saldos/versionamento e reconciliação incremental, com benchmark antes de retirar garantias.
- Workers compartilham processo com API. WORKERS_ENABLED permite instâncias somente HTTP; separação de deployments é extensão.
- Hot wallets e lotes de pendências limitam throughput. Não foi publicado benchmark/RPS/SLA.
- Sem double-entry, dashboard ou OpenTelemetry (opcionais), nem expurgo/retenção automáticos. DLQ/outbox requerem monitoramento e redrive operacional.
- Setup de filas é local; IAM, provisionamento e políticas AWS de produção não foram implementados.
- Domínio valida códigos monetários reconhecidos por Intl do runtime. A escala é fixada em duas casas para todo o desafio; não se implementam escalas específicas de cada moeda. Testes exercitam BRL e conflito com USD.
- Indisponibilidade foi testada por conexão a porta sem serviço, preservando os containers existentes. Falha de publicação/redrive usa LocalStack real.
- Shutdown SIGTERM gracioso no Linux não foi validado; crash abrupto e reinício reais foram.
