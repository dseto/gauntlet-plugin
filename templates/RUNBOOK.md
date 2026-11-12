# RUNBOOK — Harness + Gauntlet Loop

## Garantias e limites

Este harness é um **guardrail cooperativo com validação fail-closed**, não uma sandbox de segurança. Hooks e scripts ficam dentro do workspace, e um agente determinado consegue contorná-los (`node -e`, caminhos indiretos, etc.).

Ele serve para três coisas:

1. **Evitar acidentes** no uso diário.
2. **Detectar trapaças** (supressões, testes enfraquecidos) e fazer a rodada falhar quando aparecem.
3. **Orquestrar um loop de avaliação** com estado determinístico.

| Mecanismo | Natureza |
|---|---|
| `bash-guard` | heurístico (regex sobre o comando); bloqueia best-effort |
| `file-guard` | confiável para as ferramentas Edit/Write; não cobre escrita via processos filhos |
| `fast-file-check` | roda **depois** da edição e **não reverte** o arquivo; só devolve o erro ao agente |
| `anti-cheat-diff` | heurístico (regex + contagem de asserts) |
| `orchestrator-breaker` | confiável enquanto o scorecard não for adulterado |
| `builder-stop-gate` | confiável; se morrer por timeout, `record-verdict` recusa a iteração |
| independência do critic | instruída ao agente, não garantida tecnicamente |

**Timeout de hook é fail-open no Claude Code.** Um hook morto por timeout não bloqueia nada. Os guards são rápidos (10 s). Para o stop gate, a proteção é `record-verdict` exigir `gate_passed_iteration`.

**Fora de escopo:** avaliação cega A/B (candidate_A/B + chave secreta). Fica para o futuro, quando referência e artefato forem do mesmo tipo.

## Uso diário (só a Camada 1)

Nada a fazer: os hooks do plugin `gauntlet` valem em qualquer sessão aberta neste repositório (e ficam inertes em projetos sem `.gauntlet/`). Hooks carregam no início da sessão; depois de rodar `/gauntlet:init` ou atualizar o plugin, reinicie a sessão.

Mensagens que você vai ver:

- `[HARNESS] BLOCKED ...` — ação bloqueada (segredo, arquivo protegido, escrita fora do projeto, force push).
- Pedido de confirmação — comandos ambíguos (`rm -rf <pasta>`, `git reset --hard`, `git clean -f`, git de escrita quando o agente não pode ser identificado).
- `[HARNESS] FAIL fast check ...` — erro de sintaxe no arquivo recém-editado. O arquivo **já foi salvo**; o agente deve corrigi-lo.

### Desligar temporariamente (falso positivo)

No PowerShell, desligue e abra o Claude nesse mesmo terminal:

```powershell
$env:HARNESS_OFF = "1"
```

```powershell
claude
```

Para religar, abra um terminal novo, ou remova a variável e reinicie a sessão:

```powershell
Remove-Item Env:HARNESS_OFF
```

As permissões `deny` nativas do `settings.json` continuam valendo mesmo com `HARNESS_OFF=1`.

### Alterar um arquivo protegido legitimamente

A lista está em `.claude/harness/discovery.json` -> `protected_files`. Para mudar um desses arquivos, use uma das opções:

- edite fora do Claude;
- rode a sessão com `HARNESS_OFF=1`.

### Allowlist de supressões

Uma supressão legítima entra em `.claude/harness/allowed-suppressions.json` (editável só pelo usuário):

```json
[{ "path": "src/x.py", "rule": "noqa", "reason": "motivo tecnico" }]
```

Regras: `ts-ignore`, `ts-expect-error`, `eslint-disable`, `type-ignore`, `noqa`, `skip`, `snapshot`.

## Gauntlet Loop (Camada 2, sob demanda)

Use só quando houver uma tarefa com **referência concreta**: spec, mockup, saída esperada ou implementação a igualar.

### Pré-requisitos

- git >= 2.23 e identidade configurada (`git config user.name` e `user.email`).
- **Árvore limpa.** Faça commit dos arquivos do harness antes do primeiro `/gauntlet`, porque o `init` exige isso.
- Build e testes passando. Testes que já falham ficam registrados na baseline e não bloqueiam o builder; build quebrado bloqueia o `init`.

### Iniciar, continuar, encerrar

- **Iniciar:** `/gauntlet:gauntlet <componente> <caminho_da_referencia>`. Cria a branch `gauntlet/<componente>` e copia a referência para `.gauntlet/reference/` com hash travado.
- **Continuar:** `/gauntlet`.
- **Ver o estado:** `/gauntlet:gauntlet` mostra o estado; o CLI fica no plugin: `node "<pasta-do-plugin>/scripts/gauntlet-cli.mjs" status` (rode na raiz do projeto).
- **Voltar ao melhor resultado:** `gauntlet-cli rollback-to-best` (mesmo caminho do plugin). Não é destrutivo: cria um novo commit, nunca usa `reset --hard`, recusa com a árvore suja e preserva `.claude/`.
- **Encerrar:** `gauntlet-cli close`. Arquiva o scorecard em `.gauntlet/history/`. O merge da branch é manual.

### Status

| status | significado |
|---|---|
| `IN_PROGRESS` | loop rodando |
| `APPROVED` | score >= 85 e nenhum blocker |
| `HALTED_MAX_ITER` | 6 iterações sem aprovação |
| `HALTED_PLATEAU` | as últimas 3 notas variaram <= 6 pontos |
| `GATE_FAILED` | o builder falhou no stop gate 3 vezes seguidas |
| `HALTED_INFRA` | timeout ou erro de infraestrutura (não é culpa do builder) |

Qualquer status diferente de `IN_PROGRESS` deixa o loop em `terminal`: o circuit breaker bloqueia novos builders até um `close`.
