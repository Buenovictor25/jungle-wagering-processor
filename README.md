# Jungle — Distributed Wagering Processor

NestJS, Bun, TypeScript estrito, PostgreSQL 16, MikroORM 7 e SQS/LocalStack. BET, WIN, LOSS, REFUND e ROLLBACK com saldo decimal exato, ledger imutável, idempotência persistente e inbox/outbox atômicos.

[Desafio oficial](https://github.com/junglegaming/backend-challenge) · [Decisões e limitações](ARCHITECTURE.md) · [Auditoria inicial](AUDIT.md) · [Validação final](VALIDATION.md) · [Auditoria de publicação](FINAL_AUDIT.md)

## Setup

Pré-requisitos: Bun 1.x (validado com 1.4.3), Docker/Compose. Na raiz do repositório:

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env  # somente se ainda não existir
docker compose up -d --wait postgres localstack
bun run db:migrate
bun run queues:setup
bun run start
```

PostgreSQL: localhost:5433; LocalStack: localhost:4566; HTTP: localhost:3000. O Bun carrega .env automaticamente. Usuário/senha/banco de desenvolvimento: jungle/jungle_dev/wagering. O Compose e ORM agora usam defaults consistentes. Um volume existente mantém a senha original: ajustar DB_PASSWORD sem remover o volume. A configuração anterior dizia jungle, mas o volume deste workspace usa jungle_dev; não alteramos a senha no banco.

Migrations são explícitas: iniciar a API não altera schema. Setup de filas é idempotente; workers também criam/verificam filas na inicialização.

```powershell
bun run build
bun run start:prod
```

Não executar docker compose down -v. Os comandos deste projeto não administram containers BizManager.

## Configuração

| Variável | Default |
|---|---|
| DB_HOST / DB_PORT | 127.0.0.1 / 5433 |
| DB_USER / DB_PASSWORD / DB_NAME | jungle / jungle_dev / wagering |
| SQS_ENDPOINT | http://127.0.0.1:4566 |
| AWS_REGION | us-east-1 |
| AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY | test / test |
| PORT | 3000 |
| WORKERS_ENABLED | habilitado; false desabilita consumidor/retry/publisher |
| SQS_QUEUE_PREFIX | wager; testes usam prefixos isolados |

TEST_CRASH_AFTER_COMMIT=true é failpoint exclusivo de NODE_ENV=test: encerra com código 86 depois do commit e antes do ack. Nunca habilitar fora do teste de crash.

## API e contratos

Dinheiro: {"amount":"25.00","currency":"BRL"}. Saída com duas casas; entrada sem casas ou com uma casa é normalizada. Rejeita number JSON, negativos, NaN, Infinity, notação científica, mais de duas casas e mais de 16 dígitos inteiros. IDs são strings não vazias de até 255 caracteres.

| Método e caminho | Resultado |
|---|---|
| POST /wallets | criação e OPENING atômicos quando saldo inicial > 0 |
| GET /wallets/:walletId | saldo atual e versão |
| GET /wallets/:walletId/ledger?cursor=...&limit=50 | {items,nextCursor}, limite 1–100 |
| POST /wagering/transactions | processamento ou referência pendente |
| GET /wagering/transactions/:transactionId | payload e resultado persistido |
| GET /providers/:providerId/wagering/transactions/:externalTransactionId | consulta por identidade externa |
| POST /wallets/:walletId/reconciliation | soma do ledger, diferença e consistência |
| GET /health/live | processo vivo |
| GET /health/ready | PostgreSQL e SQS alcançáveis |
| GET /metrics | exposição Prometheus |

Exemplo PowerShell:

```powershell
$base = 'http://localhost:3000'
$walletBody = @{playerId=[guid]::NewGuid().ToString();initialBalance=@{amount='100.00';currency='BRL'}} | ConvertTo-Json
$wallet = Invoke-RestMethod "$base/wallets" -Method Post -ContentType 'application/json' -Body $walletBody
$externalId = [guid]::NewGuid().ToString()
$bet = @{providerId='provider-a';externalTransactionId=$externalId;playerId=$wallet.playerId;walletId=$wallet.id;roundId='round-1';gameId='fortune-chimp';kind='BET';money=@{amount='25.00';currency='BRL'}} | ConvertTo-Json
$headers = @{'Idempotency-Key'="provider-a:$externalId"}
Invoke-RestMethod "$base/wagering/transactions" -Method Post -ContentType 'application/json' -Headers $headers -Body $bet
Invoke-RestMethod "$base/wallets/$($wallet.id)/reconciliation" -Method Post
```

Repetir a chamada de BET devolve mesmo transactionId/saldo histórico e idempotentReplay=true. Resultado: {transactionId,status,balance,idempotentReplay,failureCode?}. Header Idempotency-Key obrigatório; chave igual e payload diferente produz conflito. Identidade externa (providerId,externalTransactionId) também é única: outra chave para a mesma identidade é conflito.

REFUND/ROLLBACK exigem referenceExternalTransactionId; valor deve ser integral. WIN pode referenciar BET. LOSS não gera ledger. OPENING não pode ser submetido externamente.

| HTTP | Significado |
|---|---|
| 201 | wallet criada |
| 200 | processado/replay, consulta ou reconciliação |
| 202 | PENDING_REFERENCE persistido |
| 400 | payload/chave/valor/cursor inválido |
| 404 | wallet/transação inexistente |
| 409 | conflito de chave, identidade externa ou wallet duplicada |
| 422 | rejeição financeira persistida com failureCode |
| 503 | infraestrutura/timeout de lock; reenviar com mesma chave |

Falhas financeiras: INSUFFICIENT_FUNDS, REVERSAL_INSUFFICIENT_FUNDS, PLAYER_MISMATCH, CURRENCY_MISMATCH, REFERENCE_MISMATCH, INVALID_REFERENCE, INVALID_REFERENCE_KIND, REFERENCE_NOT_PROCESSED, REVERSAL_AMOUNT_MISMATCH, ALREADY_REVERSED, REFERENCE_NOT_FOUND, BALANCE_LIMIT_EXCEEDED.
Contratos: INVALID_PAYLOAD, INVALID_IDENTIFIER, INVALID_MONEY, INVALID_KIND, POSITIVE_AMOUNT_REQUIRED, REFERENCE_REQUIRED, INVALID_LIMIT, INVALID_CURSOR.
Conflitos: IDEMPOTENCY_CONFLICT, INBOX_CONFLICT, UNIQUENESS_CONFLICT.

Autenticação completa foi omitida conforme alternativa aceita no desafio. ProviderIdentityGuard é o ponto explícito para OIDC e vínculo de providerId. Health não usa esse guard. A configuração é uma demonstração local, sem autorização para exposição pública.

## SQS

Filas: wager-transactions.fifo, wager-transactions-dlq.fifo e wager-events.fifo (saída). Enviar MessageGroupId=walletId e MessageDeduplicationId; a garantia final permanece no banco.

```json
{
  "messageId": "message-unique-id",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-16T12:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "tx-1",
    "idempotencyKey": "provider-a:tx-1",
    "playerId": "PLAYER_ID",
    "walletId": "WALLET_ID",
    "roundId": "round-1",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": {"amount": "25.00", "currency": "BRL"}
  }
}
```

Consumidor e HTTP reutilizam o mesmo use case. Ack somente após commit; rejeição financeira recebe ack. Payload inválido/conflitante vai para DLQ. Falhas transitórias: visibilidade exponencial, até três recebimentos; existe redrive policy no broker.

Referência ausente recebe ack pois o banco assume o retry: oito reprocessamentos depois da tentativa inicial, intervalos 2,4,8,16,32,64,128,256 segundos. Esgotamento gera REFERENCE_NOT_FOUND e evento.

Eventos versão 1: WagerTransactionProcessed (inclusive LOSS/OPENING), WagerTransactionRejected, WalletBalanceChanged e WagerTransactionPendingReference. Publisher usa SKIP LOCKED, nunca publica antes do commit e mantém falhas com backoff até 300 segundos. EventId estável permite deduplicação persistente pelo consumidor; entrega at-least-once.

## Testes e reprodução

```powershell
bun run build
bun run lint
bun run test
bun run test:e2e
bun run test:integration
bun run test:concurrency
bun run test:migrations
```

PostgreSQL e LocalStack são reais, não substituídos por mocks. Os 33 testes originais foram preservados. Testes adicionais cobrem regras, constraints, atomicidade, replay histórico, reversões, paginação, 50 duplicatas, disputa de saldo, DLQ, retry, publishers e reinício. Toda wallet criada na integração/concorrência é reconciliada ao final.

Concorrência inicia três processos Bun/Nest nas portas 33101–33103, mais temporários em 33104/33105, encerrando somente os processos que criou. O teste de crash espera o visibility timeout real de 30 segundos.

Executar suítes de infraestrutura em sequência e sem outro worker no mesmo banco durante a validação da outbox. Elas deixam dados auditáveis com UUID e filas isoladas test-*/crash-*; não apagam dados anteriores. test:migrations cria um banco wagering_migration_test_<timestamp>, faz up/down/up somente nele e o preserva para inspeção (requer CREATEDB). Não executar db:rollback no banco principal com dados: a reversão financeira remove suas tabelas.

## Entrega

Revisar VALIDATION.md, ARCHITECTURE.md, git log e git diff master...HEAD. Reexecutar validações no ambiente de entrega. Push e candidatura exigem autorização do proprietário e não foram realizados.
