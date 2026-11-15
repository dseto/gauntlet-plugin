# Spec: falha do gate visível e declaração de conflito tolerante

Data: 2026-11-15. Base: branch `feat/spec-conflict-halt` (d7caa76).

## 1. O que aconteceu

Loop real `bpmn-payment-v2` em `C:\Projetos\gauntlet-bpmn-test`, iteração 1:

1. O spec-tester travou 19 testes. O teste do R16 está errado: exige 37 nós e também `task == 8`, mas as contagens por tipo somam 39. A spec dá 6 tasks.
2. O builder gerou o diagrama (18 de 19 testes passam), viu a contradição e gravou `.gauntlet/inbox/spec_conflict.json` com `"tests": ["R16", "test_r16_no_extra_elements"]`.
3. O stop gate recusou a declaração e contou a tentativa 1 de 3. O loop ficou `IN_PROGRESS`.
4. Ninguém soube o motivo. O orquestrador viu só `gate attempts: 1/3` e parou para perguntar ao usuário.

## 2. Causas raiz

| # | Problema | Causa | Evidência |
|---|----------|-------|-----------|
| B1 | Declaração de conflito válida foi recusada | `cmdSpecConflict` só aceita o id do requisito ou o id junit completo (`pytest::tests.acceptance.<arquivo>::test_r16_...`). O builder usou o nome curto, que é o que `builder.md` chama de "locked test names". | `scripts/gauntlet-cli.mjs:1113-1120`. Rodando a mesma validação sobre o arquivo real: `unknown: ['test_r16_no_extra_elements']`. |
| B2 | O motivo da falha do gate se perde | O gate só escreve o motivo no stderr e sai com código 2. Nesta versão do app (2.1.325) o builder encerra com `SubagentHandback`, não é retomado e o stderr não aparece em nenhum transcript. O scorecard guarda só o contador. | `hooks/builder-stop-gate.mjs:40-43`. Transcript do builder: último evento é o `SubagentHandback`; zero ocorrências de `gate attempt`. |
| B3 | `mkdir -p .gauntlet/inbox` é bloqueado | `classifyPath` só trata como inbox o que começa com `.gauntlet/inbox/`. A pasta em si, sem barra final, cai na classe `gauntlet`. A mensagem do bloqueio se contradiz. | `hooks/lib/common.mjs:222`. Reproduzido: `.gauntlet/inbox`, `.gauntlet/inbox/` e `./.gauntlet/inbox` → `gauntlet`. |
| B4 | Um teste travado contradiz a própria spec | `lock-acceptance` só exige que o teste falhe antes do builder. Um teste errado também falha. | `scripts/gauntlet-cli.mjs:985-986`; `tests/acceptance/test_bpmn_payment_acceptance.py:294-301` no projeto de teste. |

B2 é o mais grave. Ele não afeta só o conflito de spec: qualquer falha do gate (testes, anti-cheat, summary) fica invisível. Hoje o orquestrador segue para o critic, o `record-verdict` recusa por falta de gate, e o builder é despachado de novo sem saber o que corrigir.

## 3. Solução

Princípio: **o scorecard é o canal entre o gate e os agentes, não o stderr do hook.** O `exit 2` continua, para os ambientes em que ele retoma o builder, mas nada depende dele.

### F1. Aceitar o nome curto do teste (B1)

Em `cmdSpecConflict`, um item de `tests` é válido quando é um id de requisito travado **ou** quando `matchTests` o encontra entre os ids travados. `matchTests` já existe (`gauntlet-cli.mjs:303`) e já aceita id completo, sufixo `classname::name` e nome curto, sem confundir `test_r1` com `test_r10`.

- Arquivo: `scripts/gauntlet-cli.mjs` (cerca de 3 linhas).
- A mensagem de recusa passa a listar as formas aceitas.

### F2. Gravar e mostrar a falha do gate (B2)

1. **Gravar.** Nova função `cmdGateFailed(check, log)` no CLI. Ela grava `last_gate_failure: { attempt, check, log }` no scorecard, com `log` cortado em 2000 caracteres. `failGate` chama essa função antes de sair.
2. **Parar na 3ª falha.** Se a tentativa que falhou é a última (`attempt >= gate_max_attempts`), `cmdGateFailed` marca `GATE_FAILED` na hora, com o check no `halt_reason`, e o hook sai com 0. Hoje o `GATE_FAILED` só é marcado na 4ª parada, o que custaria um builder inteiro cujo trabalho nunca é verificado.
3. **Limpar.** `cmdBuilderPassed` apaga `last_gate_failure`.
4. **Mostrar.** `status` ganha a linha `last gate failure (attempt k/max): <check>: <log em uma linha, até 600 caracteres>`. Com o loop rodando e uma falha gravada, a linha `next:` vira `next: re-dispatch builder for iteration N with the gate failure above`.
5. **Orquestrador.** `commands/gauntlet.md`, passo 4: se `status` mostra `last gate failure` e o loop está `running`, volta ao passo 3 com o mesmo N e passa a linha da falha ao builder. O limite é o do próprio gate: na 3ª falha o status vira `GATE_FAILED`.
6. **Builder.** `agents/builder.md`, passo 1: se o scorecard tem `last_gate_failure`, uma execução anterior desta iteração falhou no gate; corrigir essa causa primeiro.

- Arquivos: `scripts/gauntlet-cli.mjs`, `hooks/builder-stop-gate.mjs`, `commands/gauntlet.md`, `agents/builder.md`.
- `last_gate_failure` é um campo opcional; `schema_version` não muda.

### F3. A pasta inbox é inbox (B3)

Mudar `classifyPath` foi a primeira ideia e foi descartada na revisão: ela liberaria também `mv .gauntlet/inbox ../gone`. Versão implementada: em `bash-guard`, quando o segmento do comando começa com `mkdir`, nomear a pasta `.gauntlet/inbox` em si é permitido. Mover, copiar ou apagar a pasta, e `mkdir .gauntlet/inbox/..`, continuam bloqueados.

- Arquivo: `hooks/bash-guard.mjs` (parâmetro `mkdirOnly` em `checkTarget`). `classifyPath` não muda.

### F4. Teste travado errado (B4)

Não existe checagem mecânica barata para "o teste diz o mesmo que a spec". A solução é em três partes, sem código novo de validação:

1. **Prevenir (instrução).** `agents/spec-tester.md`, novo passo 10 (depois de rodar os testes): antes de terminar, reler cada teste contra o texto do requisito. Todo número, nome e contagem em um `assert` precisa estar no requisito ou derivar dele, e totais precisam fechar com as parcelas.
2. **Detectar (já existe).** O builder declara o conflito. Com F1 e F2, o loop para em `HALTED_SPEC_CONFLICT` na iteração 1.
3. **Dizer a coisa certa.** A mensagem do halt e a linha do RUNBOOK passam a dizer que o conserto pode ser no teste travado ou na referência, não só "na spec".

A recuperação continua igual: `close`, corrigir, novo `init` com outro nome de componente.

## 4. Requisitos de aceitação

R1: Uma declaração de conflito que cita um teste travado pelo nome curto (`test_r1_...`) é aceita e o loop para em `HALTED_SPEC_CONFLICT`.
R2: A declaração também é aceita com o id do requisito, com o sufixo `classname::name` e com o id junit completo.
R3: Um nome que não corresponde a nenhum teste travado continua recusado, inclusive um prefixo (`test_r1` não vale por `test_r10`). A mensagem lista as formas aceitas.
R4: Depois de um gate que falha, `scorecard.last_gate_failure` tem `attempt`, `check` e `log` (no máximo 2000 caracteres).
R5: Com uma falha gravada e o loop rodando, `status` mostra a linha `last gate failure (attempt k/max): ...` e a linha `next: re-dispatch builder for iteration N ...`.
R6: Um gate que passa apaga `last_gate_failure`, e `status` deixa de mostrar a linha.
R7: A 3ª falha seguida marca `GATE_FAILED` na mesma parada: o hook sai com 0, `halt_reason` cita o check que falhou e o circuit breaker bloqueia o próximo builder.
R8: `bash-guard` permite `mkdir -p .gauntlet/inbox`, com ou sem barra final e com `./` na frente. `mkdir .gauntlet/outra` e `rm -rf .gauntlet` continuam bloqueados.
R9: `builder.md`, `gauntlet.md`, `spec-tester.md` e `templates/RUNBOOK.md` descrevem o comportamento novo (F1, F2, F4).
R10: Os 24 testes atuais de `tests/gate.test.mjs` continuam passando.

## 5. Testes

Todos em `tests/gate.test.mjs`, com os helpers que já existem (`makeProject`, `startNumbered`, `specTester`, `gate`, `cli`, `scorecard`).

| Teste | Cobre |
|-------|-------|
| Estender `spec conflict: ...`: nome curto, sufixo e id completo são aceitos; prefixo é recusado | R1, R2, R3 |
| Novo `gate failure: reason is stored, shown by status and cleared when the gate passes` | R4, R5, R6 |
| Novo `gate failure: the third failure marks GATE_FAILED at once` | R7 |
| Novo `bash-guard: the inbox folder itself is writable` | R8 |

Cuidado ao estender o teste de conflito: ele já usa duas recusas, e com R7 uma terceira recusa no mesmo loop marca `GATE_FAILED`. Os casos novos de recusa vão em um projeto separado.

O ramo `attempt > gate_max_attempts` do hook fica como rede de segurança; com R7 ele não é mais alcançado no fluxo normal.

R9 é conferido por leitura. R10 é a suíte inteira: `node --test tests/gate.test.mjs`.

## 6. Fora de escopo

- **Revisão independente dos testes travados** antes do builder (itens 3 e 4 do plano original). Custa um agente a mais por loop. Com F1 e F2, um teste errado custa uma iteração de builder e para o loop com o motivo escrito.
- **Reabrir só o teste errado** (`reopen-acceptance`). Os testes travados estão commitados e com hash; trocar um deles exige desfazer o lock com segurança. É a decisão D1 abaixo.
- **Fazer o `exit 2` retomar o builder.** É comportamento do app, não do plugin.

## 6b. Achados da revisão independente

Corrigidos: `last_gate_failure` velho (o gate já passou para a iteração) não aparece mais no `status` e é apagado pelo `record-verdict`; `mv`/`cp` da pasta inbox (ver F3).

Conhecidos e não corrigidos, por já existirem antes e fugirem do escopo:
- `cmdSpecConflict` não confere que o teste citado falhava no lock. Um builder pode parar o loop citando um teste que passa. O usuário vê o motivo no relatório.
- `ln`/`mklink` não são verbos de escrita para o `bash-guard`.
- `rm -rf .gauntlet/inbox/../..` resolve para a raiz do projeto e só pede confirmação.

Descartado: "infra consome o orçamento de tentativas". `infra()` marca `HALTED_INFRA` e encerra o loop; não há retry a perder.

## 7. Decisões abertas

- **D1. Recuperação mais barata.** Hoje um erro de uma linha em um teste travado custa `close`, novo `init` e todos os testes escritos de novo. Recomendo não resolver agora e medir quantas vezes acontece depois de F4.
- **D2. Tamanho do log gravado.** 2000 caracteres no scorecard, 600 no `status`. O builder lê o scorecard, então recebe o texto maior.

## 8. Riscos

- **O plugin vivo é a pasta do repo.** O marketplace `gauntlet-local` aponta para `C:\Projetos\gauntlet-plugin`, e a sessão do loop executou `C:/Projetos/gauntlet-plugin/scripts/gauntlet-cli.mjs`. Editar o repo ou trocar de branch muda o gate de um loop em andamento. Implementar com o loop `bpmn-payment-v2` parado ou fechado.
- **R7 muda um comportamento existente** (o `GATE_FAILED` sai uma parada antes). Nenhum teste atual depende do comportamento antigo.
- **F4.1 é só instrução.** Ela reduz, mas não elimina, testes errados.

## 9. Ordem e validação real

1. F3 (1 linha) e F1 (3 linhas), com testes.
2. F2, com testes.
3. F4 e a documentação.
4. Validação real: no loop `bpmn-payment-v2`, que está `IN_PROGRESS` com a declaração já gravada, despachar o builder de novo. Resultado esperado: na parada seguinte o gate aceita a declaração e o loop termina em `HALTED_SPEC_CONFLICT` citando R16.

Estimativa: cerca de 40 linhas de código e 60 de teste.
