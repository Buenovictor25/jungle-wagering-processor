# Auditoria inicial — 16/10/2026

Fonte: README integral de https://github.com/junglegaming/backend-challenge (seções 1–14).
Base: `4a94474`, master sincronizada; recuperação `recovery/pre-challenge-20261016`.
Branch de trabalho: `codex/complete-wagering-challenge`.
Baseline executada: `bun test src`, 33 passando. Banco existente: 0 wallets.

| Requisito | Estado inicial | Evidência / falta |
|---|---|---|
| Money decimal exato, Wallet e Ledger de domínio | Concluído | 32 testes de domínio |
| Bun / Nest / PostgreSQL / MikroORM | Parcial | runner configurado como Jest; TS não estrito |
| Wallet persistente, unicidade | Parcial | migration inicial; falta CHECK saldo |
| OPENING e ledger persistente | Ausente | somente entidade de domínio |
| BET/WIN/LOSS/REFUND/ROLLBACK | Ausente | sem use case |
| Idempotência persistente e hash | Ausente | sem tabela |
| Lock por wallet multi-instância | Ausente | sem processamento |
| Inbox/outbox atômicos | Ausente | sem tabelas/workers |
| Referências fora de ordem | Ausente | sem retries |
| API, paginação, reconciliação | Ausente | controller padrão Nest |
| SQS e DLQ | Parcial | filas e redrive configurados, sem consumidor |
| Observabilidade / health | Ausente | sem implementação |
| Integração e concorrência reais | Ausente | somente testes unitários e scaffold e2e |
| Documentação e extensão de autenticação | Ausente | README padrão Nest |

Prioridade: garantias financeiras no schema e transação SQL, API e testes reais; depois workers e falhas. A validação final deve ser registrada separadamente, sem confundir implementação com comprovação.
