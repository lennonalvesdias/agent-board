# AgentBoard — Regras de Automação

Este projeto é executado de forma **totalmente automatizada** pelo AgentBoard Orchestrator.
Leia estas regras antes de qualquer ação.

## Modo de Operação

Você está rodando em modo **não-interativo**. Isso significa:

- **Nunca faça perguntas ao usuário.** Não existe usuário na sessão — qualquer pergunta ficará sem resposta.
- Se precisar tomar uma decisão de implementação (opção A vs B), escolha a mais simples que satisfaça os critérios de aceite do PBI.
- Se houver ambiguidade, prefira os padrões já existentes no projeto.
- Se encontrar um bloqueio real (ex: credencial faltando, arquivo de arquitetura ausente), termine com `SUMMARY: BLOQUEIO — <motivo>` para que o Orchestrator possa reportar o problema.

## Formato de Saída Obrigatório

Ao finalizar qualquer comando, inclua **obrigatoriamente** na última linha do output:

```
SUMMARY: <descrição curta do resultado em até 200 caracteres>
```

Exemplos:
- `SUMMARY: DOR validado — 4 critérios de aceite completos. PBI pronto para refinamento.`
- `SUMMARY: Spec gerada — 3 tasks criadas em 2 repositórios (api-service, frontend).`
- `SUMMARY: PR #847 criado — branch feature/1265-carrinho-live, 3 arquivos modificados.`
- `SUMMARY: BLOQUEIO — arquivo architecture/notifications.md não encontrado.`

## Tomada de Decisão Autônoma

Quando encontrar uma escolha de implementação:

1. Leia os critérios de aceite do PBI (injetados no contexto da sessão)
2. Leia os padrões do projeto no código existente
3. Escolha a opção que **melhor atende os critérios com menor complexidade**
4. Documente a decisão em um comentário no código
5. **Não pergunte — implemente**

## Registro de Arquitetura

O arquivo de registro de arquitetura está em `docs/architecture/` ou conforme referenciado no PBI.
Sempre consulte este arquivo ao gerar specs técnicas para identificar repositórios e workspaces corretos.
