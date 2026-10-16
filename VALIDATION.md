# Relatório de entrega — 16/10/2026

Branch: `codex/complete-wagering-challenge`.
Base preservada: `4a94474`, também em `recovery/pre-challenge-20261016`.
Marcos locais: `c50734f` (fluxo financeiro/persistência) e `84cdca6` (concorrência, recuperação e reforço de invariantes). Nenhum push ou candidatura foi enviado.

## Execuções verificadas

Ambiente: Windows, Bun 1.4.3, PostgreSQL 16 e LocalStack 3.8.1 reais, nos containers do Compose Jungle. Não foram usados mocks para substituir PostgreSQL/SQS.

| Execução | Resultado observado |
|---|---|
| Baseline `bun test src` antes de alterações | 33 passaram |
| `bun install --frozen-lockfile` | sucesso, 793 instalações verificadas, sem alterações |
| `bun run build` | sucesso, TypeScript estrito |
| `bun run lint` | sucesso, sem erros/warnings |
| `bun test src test/financial.integration.spec.ts test/processes.integration.spec.ts test/app.e2e.spec.ts` | **77 passaram, 0 falharam**, 10 arquivos, 48,26 segundos |
| Reexecução da integração após reforçar o teste de dois publishers | **13 passaram, 0 falharam**, 9,60 segundos; ambos publishers obrigatoriamente reivindicam trabalho |
| `bun run test:migrations` | três migrations passaram por up/down/up em banco novo exclusivo de teste |
| Inicialização de `bun dist/main.js` | readiness HTTP 200 contra PostgreSQL/SQS |
| `git diff --check` | sem erros de whitespace |

Distribuição: 56 testes unitários (incluindo os 33 originais), 1 e2e de aplicação, 13 de integração e 7 de processos/concorrência. As asserções adicionais do teste de publishers não alteraram a quantidade de testes.

## Matriz final

| Requisito | Estado e evidência |
|---|---|
| Decimal exato e rejeição de entradas inválidas | Validado; precisão monetária e limite numeric testados |
| BET/WIN/LOSS/REFUND/ROLLBACK | Validado em regras unitárias e PostgreSQL real |
| OPENING, unicidade e saldo não negativo | Validado; abertura positiva/zero, duplicação e CHECKs |
| Ledger append-only e consistente | Validado; UPDATE/DELETE/TRUNCATE bloqueados, reconciliação e constraints diferidas |
| Atomicidade wallet/transação/ledger/inbox/outbox | Validado; conflito tardio de inbox desfaz todos os efeitos |
| Replay histórico e payload divergente | Validado; chave/hash persistidos, saldo original preservado |
| 50 duplicatas | Validado tanto no use case como por HTTP em três processos; um único débito |
| Duas BETs 80.00 sobre 100.00 | Validado em processos concorrentes: 200/422, saldo 20.00, um débito |
| Wallets distintas | Validado com operações em paralelo |
| Referências fora de ordem e limite | Validado; REFUND antes da BET resolve, esgotamento rejeita |
| Endpoints e erros distintos | Validado; 201/200/202/400/404/409/422/503, consulta externa, cursor e reconciliação |
| SQS inbox, ack pós-commit e redelivery | Validado com broker real |
| Retry, backoff e DLQ | Validado com três recebimentos reais e payload inválido |
| Outbox, dois publishers e recuperação | Validado com transações/conexões concorrentes, falha de publicação e retomada |
| Crash entre commit e ack | Validado por morte real do processo com código 86 e sucessor após visibilidade expirar |
| Restart e persistência | Validado; replay e reconciliação mantidos após novo processo |
| Logs JSON, métricas e health | Exercitados; lock timeout contabilizado, métricas expostas e readiness 503/live 200 com banco inacessível |
| Migrations reversíveis | Validado em banco exclusivo, sem reverter o principal |
| Auth alternativa aceita | Guard no-op explícito e desenho OIDC documentado |
| Shutdown gracioso SIGTERM | Implementado; validação Linux pendente, não confundida com teste de crash Windows |

## Problemas encontrados e corrigidos

- Projeto inicial tinha somente domínio/testes e tabela wallets; faltavam fluxos, endpoints, ledger persistente e workers.
- Compose e ORM divergiam sobre a senha de desenvolvimento; alinhados ao volume existente, sem reset.
- Reprocessamento mantinha indevidamente o estado PENDING_REFERENCE mesmo após encontrar referência; o teste real detectou e a regra foi corrigida.
- Testes SQS inicialmente disputavam fila compartilhada; passaram a usar prefixos exclusivos por execução.
- Uma mensagem de DLQ não confirmada bloqueava o grupo FIFO usado por todas as falhas; os grupos agora usam identidade da mensagem e o teste confirma sua leitura.
- O nome original `app.e2e-spec.ts` não era descoberto pelo Bun; renomeado para `app.e2e.spec.ts`, preservando o teste.
- Ajustes de lint foram realizados, sem suprimir erros de implementação. A exceção específica para `await-thenable` em testes documenta a tipagem de `.rejects` do Bun, que retorna void nos tipos apesar da execução assíncrona.

## Limitações e pendências explícitas

- Validar SIGTERM gracioso em Linux. Crash/restart no Windows estão comprovados.
- Sem autenticação completa, conforme opção aceita; guard e integração planejada documentados.
- Sem benchmark, dashboard, OpenTelemetry ou double-entry (diferenciais opcionais).
- Outbox é at-least-once; consumidores externos precisam deduplicar eventId. Sem garantia de ordenação global entre publishers.
- Trigger de soma do ledger tem custo crescente por wallet; sem promessa de throughput de produção.
- Retenção, redrive operacional, IAM e configuração AWS de produção não foram implementados.
- Não foram parados containers para injetar indisponibilidade: a falha de conexão foi testada usando porta sem serviço.

## Preservação do ambiente

Nenhum volume Docker foi removido; nenhum comando `down -v`; nenhum container BizManager foi administrado. Banco principal recebeu apenas migrations aditivas e dados auditáveis de teste. Bancos `wagering_migration_test_*` e filas isoladas foram preservados para inspeção. Apenas subprocessos criados pelos testes foram encerrados.

## Reproduzir e entregar

```powershell
bun install --frozen-lockfile
docker compose up -d postgres localstack
bun run db:migrate
bun run queues:setup
bun run build
bun run lint
bun run test
bun run test:e2e
bun run test:integration
bun run test:concurrency
bun run test:migrations
```

Executar suítes de infraestrutura em sequência, sem outro worker no mesmo banco durante a inspeção da outbox. Conferir README.md/ARCHITECTURE.md e commits locais antes de publicar. Push e envio do formulário continuam dependendo de autorização do proprietário.
