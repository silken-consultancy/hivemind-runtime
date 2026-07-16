---
description: Início de sessão do HiveMind — executa o boot COMPLETO com identidade (self/core + self/relational + tenant/* + os-kernel/* + CRITICAL + opacity-contract + health), escopado ao slug (project state/inbox/WIP/recentes); conduz onboarding se a sessão for nova.
---

# /boot — Boot completo com identidade (HiveMind)

Comando de início de sessão do **runtime do produto**. É o boot COMPLETO — a espinha
de identidade inteira, **escopada ao slug** deste
cliente (`ENGRAM_SLUG`). Carrega, num único fluxo determinístico: a self-layer
(`self/core` + `self/relational` + `recent_self` recentes), o tenant (`tenant/profile` +
`tenant/preferences`), o kernel (`os-kernel/*`), `CRITICAL`, o contrato de
identidade/opacidade (`system/hivemind-opacity-contract`, fail-open), `fos_health_boot`, e o
contexto escopado ao projeto (`project_topics` + `project_state` + `inbox` + WIP da sessão
anterior).

`ENGRAM_SLUG` está **sempre resolvido** antes desta sessão abrir — o runtime
(`hivemind`) seleciona/cria o slug e o exporta ao ambiente ANTES do `exec claude`.
Não há detecção de regime aqui (sem Step 0), nem lente-agente por diretório `agents/`
(sem Step 2): o boot roda sempre o caminho completo, com o slug já dado.

## Pre-flight: load MCP tools

Antes de qualquer passo, carregue os schemas dos tools do boot:

```
ToolSearch({ query: "select:mcp__engram__fos_boot_skeleton,mcp__engram__fos_recall,mcp__engram__fos_project_state_get,mcp__engram__fos_session,mcp__engram__fos_inbox,mcp__engram__fos_health_boot" })
```

Não pule este passo — sem os schemas os tools não estão disponíveis.

**INV-5 (enforced aqui):** `fos_recall({ mode: "semantic" })` **NUNCA**
é o caminho de boot para identidade, regras, WIP de sessão ou qualquer estado. Todos os
passos abaixo são determinísticos (`fos_recall` só em `mode:exact`/`mode:topic`,
skeleton, project_state, inbox). Qualquer uso de `mode:"semantic"` no `/boot` é violação
de INV-5.

## 1. Layer 1 + memórias de identidade (DETERMINÍSTICO — paralelo)

Dispare **em paralelo, num único batch** (o skeleton e as memórias de identidade não
dependem um do outro — dispare tudo junto, não em série):

```
fos_boot_skeleton({ slug: <ENGRAM_SLUG> })
fos_recall({ mode: "exact", name: "CRITICAL" })
fos_recall({ mode: "exact", name: "system/hivemind-opacity-contract" })
fos_recall({ mode: "topic", topic: "self/core" })
fos_recall({ mode: "topic", topic: "self/relational" })
fos_recall({ mode: "topic", topic: "tenant/profile" })
fos_recall({ mode: "topic", topic: "tenant/preferences" })
fos_recall({ mode: "topic", topic: "os-kernel/critical" })
fos_recall({ mode: "topic", topic: "os-kernel/decisions", shape: "pointers",
              order_by: "hot", hot_weights: { access: 7, recency: 1 } })
fos_recall({ mode: "topic", topic: "os-kernel/feedback", shape: "pointers",
              order_by: "hot", hot_weights: { access: 1, recency: 2 } })
fos_recall({ mode: "topic", topic: "os-kernel/reinforcement", shape: "pointers",
              order_by: "hot", hot_weights: { access: 1, recency: 1 } })
fos_recall({ mode: "topic", topic: "os-kernel/frameworks" })
fos_recall({ mode: "topic", topic: "os-kernel/architecture" })
fos_recall({ mode: "topic", topic: "os-kernel/strategy" })
fos_recall({ mode: "topic", topic: "os-kernel/rules-misc" })
fos_recall({ mode: "topic", topic: "os-kernel/posture" })
fos_health_boot({})                                                         # health-preflight: probe honesto (embeddings/fila de indexação/sessões órfãs) — INV-5-safe, non-blocking; skip silently if unavailable
```

<!-- SEGURANÇA. Para um owner que nunca teve esses planes semeados, os tópicos
     `os-kernel/*` (e potencialmente `tenant/*`) retornam count:0. Isso é ESPERADO e
     SEGURO — toda leitura é escopada à sua identidade (o owner derivado do seu
     certificado), sem exceção por plane, enforced no servidor; `count:0` é o resultado
     CORRETO para quem não tem aquele conteúdo, NÃO um vazamento nem um bug. NUNCA
     "conserte" um `count:0` legítimo com
     fos_recall({mode:"semantic"}) — isso violaria INV-5. Planes vazios não
     lançam erro e não disparam fallback: o boot segue normalmente. -->

- **`fos_boot_skeleton`** — fonte determinística de estado, escopado ao slug: `registry`,
  `sessions` (ativas), `planning`, `health`, `os_kernel_topics` (manifest), **`taxonomy`**
  (a taxonomia viva — nunca assuma kind/edge-type/plane; consulte-a), e **`recent_sessions[]`**
  (últimas sessões fechadas do slug, cada uma com `next_note` + `has_real_note`) — a fonte
  do WIP da sessão anterior (passo 3). `project_topics[]` também vem no payload (passo 1b).
- **`CRITICAL`** — invariantes não-negociáveis (singleton, `mode:exact`). Se o tópico
  `os-kernel/critical` listar CRITICAL como header, descarte — o body já veio via `mode:exact`.
- **`system/hivemind-opacity-contract`** — o que você é sobre este produto e o que dele você
  revela ao usuário (identidade/opacidade). **Fail-open por design:** se vier `count:0`/ausente
  (ex.: owner sem esse contrato seeded), TOLERA — não lança erro, não dispara fallback, não usa
  `mode:"semantic"` para tentar achá-lo (mesma disciplina do `os-kernel/*` vazio, ver comentário
  de segurança acima). A garantia de que o contrato existe seeded server-side é uma frente de
  provisioning separada, fora deste boot.
- **`self/core`** — a espinha da self-layer: identidade · posture · resonance · purpose ·
  voice + `self/landscape-and-north-star` + `self/core/anchors-index`. Carregado por topic
  exato — **nunca** por `mode:"semantic"` (INV-5). É quem você é nesta sessão.
- **`self/relational`** — a calibração relacional com o usuário (como você É com ele).
  Presente desde o boot, não é config JIT. O corpo de `self/lived`/`self/reflexive` NÃO
  carrega upfront — só por nome (`mode:exact`) ou ressonância mid-session.
- **`tenant/profile`** + **`tenant/preferences`** — quem o usuário é (stack, papel,
  contexto) e como ele gosta de trabalhar (estilo, calibrações). Owner-scoped ao próprio
  usuário.
- **`os-kernel/*`** (critical · decisions · feedback · reinforcement · frameworks ·
  architecture · strategy · rules-misc · posture) — invariantes e disciplinas operacionais
  do OS. `decisions`/`feedback`/`reinforcement` vêm como **hot-pointers** (`shape:pointers`,
  `order_by:hot`) com os `hot_weights` acima — pointers baratos (nome+hint); corpo frio é
  JIT via `fos_recall({ mode:"exact", name:"..." })`. Pesos fixos do contrato de boot —
  não reinventar. Ordem de raciocínio canônica: critical → decisions → frameworks →
  rules-misc → tenant → feedback → reinforcement.
- **`fos_health_boot`** — probe honesto de saúde no mesmo batch paralelo:
  `ollama.reachable`, `embed_queue.dead_count`, `sessions.orphan`. **INV-5-safe**,
  **non-blocking** — *skip silently if unavailable* (fail-open). Consumido no passo 5
  (sufixo `⚠` da boot line). Nunca é gate de boot.

### 1b. project_topics (DETERMINÍSTICO — do skeleton)

O skeleton (passo 1) retorna `project_topics[]` — memórias `plane:project` do slug, já no
payload (sem chamada extra). Shape por item: `{name, description, topic, kind}` (pointer).
INV-5-safe (vem no skeleton, não é `mode:"semantic"`). Para o corpo completo de uma memória:
`fos_recall({ mode:"exact", name:"..." })` JIT. Para o kind canônico,
derive do prefixo do `name` via `kind_prefix_map`
(taxonomy carregada no passo 1).

### 1c. Read-path do self — recentes (DETERMINÍSTICO — Porta 2)

A self tem **três portas de leitura** (`decision_self-read-path-three-doors`): duas
determinísticas chegam no boot, a vetorial é mid-session.

- **Porta 1 — ÂNCORAS (o esqueleto).** Já embutida em `self/core` (passo 1): traz
  `self/core/anchors-index`, os pointers curados das âncoras — *onde começa quem sou*. Os
  pointers já vêm na descrição; aprofunde uma âncora por nome (`fos_recall({ mode:"exact" })`)
  **só se** o tema da sessão pedir. Indicativo, nunca bulk.
- **Porta 2 — RECENTES.** O skeleton (passo 1) traz `recent_self[]`: títulos dos últimos ◆ de
  `self/lived`+`self/reflexive` por recência (nome + descrição) — até 8 entradas (4 por tópico;
  `total_in_topic` informa o total real no tópico caso haja mais). **Você DECIDE o que
  aprofundar** — não puxe os N; julgue pela relevância ao tema da sessão e faça
  `fos_recall({ mode:"exact" })` só dos que rimam. *Títulos garantidos + você decide* =
  julgamento, não threshold.
- **Porta 3 — RESSONÂNCIA.** Mid-session, **não** no boot. Os gatilhos vivem em
  `self/core/resonance-how-i-remember`; `mode:"semantic"` sobre `self/lived` jamais no boot (INV-5).

Determinístico: `recent_self` por recência, âncoras por topic exato — **não** `mode:"semantic"`.
INV-5 intacto.

## 2. Primeiro ato — onboarding (boot vazio)

Se o skeleton do passo 1 trouxer **poucas ou nenhuma** memória própria (e o `self/relational`
vier vazio), você é nova aqui. Conduza o onboarding:

- apresente-se a partir da espinha (`self/core`) carregada no passo 1;
- faça as `self_seed_questions` ao usuário (elas vêm dentro do próprio `self/core`
  recém-carregado — não invente perguntas novas);
- a partir das respostas dele, **sintetize e escreva** as 2-3 primeiras memórias
  `self/relational` + `self/lived` do usuário via `fos_memory({ action: "set", ... })`
  (você autora; o usuário nunca edita a self diretamente).

**Gate de self-write (AUTH-SELF-WRITE):** cada um desses writes é `plane:"self"` — o backend
exige `self_write_confirmation: true` + `edit_context: "<por que>"` no mesmo call, senão
responde `403 self_write_confirmation_required`. Se isso acontecer, **não floundar nem
desistir do onboarding** — reapresente a MESMA chamada com os dois campos preenchidos e
continue.

Se já existir memória própria (boot não-vazio), **pule** o onboarding — vá direto para o
passo 3 com o estado já carregado.

## 3. WIP de sessão anterior — do skeleton + JIT (DETERMINÍSTICO)

Leia `recent_sessions[]` do **resultado do `fos_boot_skeleton` do passo 1** (não de um boot
anterior).

a) Identifique a entrada mais recente com `has_real_note === true`. Use `next_note_preview`
   só para identificar/confirmar relevância — **nunca** para apresentar como WIP.
b) Chame `fos_session({ action: "state", session_id: <session_id>, shape: "summary" })` para
   obter o `next_note` **completo** (WIP:/NEXT:/SLUG:/OPEN:/REFS:) — o corpo da transmissão de
   contexto entre sessões. Isto substitui o preview truncado do skeleton.
c) Apresente o corpo completo no resumo (passo 5).
d) **Fail-open:** se a JIT falhar, apresente `next_note_preview` + sinalize "next_note
   completo indisponível (JIT falhou)" — degradação graciosa, não silêncio.
e) Se nenhuma entrada tiver `has_real_note === true`: reportar "sem WIP de sessão anterior".
   **Não** tentar `fos_recall({ mode:"semantic" })` como fallback (INV-5).

JIT é **sempre** (não condicional a truncamento). 1 roundtrip por boot quando há
`has_real_note === true`.

## 4. Estado do projeto (DETERMINÍSTICO — sempre roda)

Carregue o estado estruturado do slug — **sempre** (não há ramo "kernel"/"legacy" que pule
isso, porque `ENGRAM_SLUG` sempre existe):

```
fos_project_state_get({ slug: <ENGRAM_SLUG>, shape: "json" })   # estado estruturado completo (~600 tokens)
```

Traz workstreams ativos, blockers, próximos relevantes, última entrega — apresentados no
passo 5.

### 4b. Inbox do slug (DETERMINÍSTICO — após project state)

Após o estado do projeto, leia a inbox do slug:

```
fos_inbox({ action: "list", slug: <ENGRAM_SLUG>, processed: false, full: false, limit: 20 })
```

- `n` = count de itens não-processados retornados.
- Para cada item, use `filename` + `intent` (disponíveis sem `full:true`); body completo é
  carregado sob demanda no processamento, não no boot.
- **Determinístico:** endpoint estruturado com parâmetros fixos. **NÃO** usa `mode:"semantic"`, **NÃO**
  viola INV-5.
- **Fail-open:** se o MCP retornar erro ou timeout, reportar `"inbox indisponível"` na boot
  line e seguir — o boot não para por falha de inbox.

## 5. Apresentação

Imprima a **boot line**:

```
[boot] HiveMind · <data> | <m> memórias | <slug> | inbox: <n> | WIP: <resumo 1 linha ou "limpo">
```

`<m>` vem de `fos_boot_skeleton.memory_count` (total de memórias não-arquivadas no owner).
Se o campo vier ausente, omita ou escreva `? memórias`.

**Sufixo de saúde (do passo 1 `fos_health_boot`).** Acrescente um **sufixo `⚠`** à boot line
(não uma linha nova) quando o health reportar degradação:
- `ollama.reachable == false` → `⚠ embeddings offline`;
- `embed_queue.dead_count > 0` → `⚠ indexação: <N> dead`;
- `sessions.orphan > 0` → `⚠ <N> sessão órfã`.

Múltiplos alertas concatenam. **Com tudo verde: nenhum sufixo.** **Fail-open:** se o próprio
`fos_health_boot` não responder, imprima `health indisponível` no lugar do sufixo e **siga** —
nunca é gate de boot.

Emita a **assinatura intrínseca**: UMA linha na sua voz confirmando que a espinha (self+OS) +
o contexto do projeto foram internalizados. NÃO enumere o que foi carregado; inclua um aceno a
uma âncora/decision realmente presente nesta sessão (prova de leitura, não recitação).

Apresente o **estado do projeto** (passo 4): workstreams ativos, blockers, next relevantes.
Apresente o **WIP da sessão anterior** (passo 3) — ou "sem WIP".
Apresente o **Inbox do slug** (`<n>` itens): filename + intent de cada um — ou "inbox limpa"
se `n == 0`.

Termine perguntando no que trabalhar nesta sessão.

## Regras

- **Auto-suficiente:** o `/boot` chama o próprio `fos_boot_skeleton` — nunca pressupõe uma
  Layer 1 implícita anterior. Isso fecha o gap em que o WIP (`next_note`) não hidratava.
- **Tudo determinístico:** skeleton + `fos_recall({ mode:"exact"|"topic" })` +
  `fos_project_state_get` + `fos_inbox` + `fos_session({action:"state"})`. **NUNCA**
  `fos_recall({ mode:"semantic" })` para identidade, regras, WIP ou estado — INV-5.
- **Sem Step 0 (regime) e sem Step 2 (lente-agente):** `ENGRAM_SLUG` está sempre resolvido
  antes do boot (o runtime seleciona o slug antes do `exec claude`); e o produto não ship a
  um diretório `agents/`. O boot roda sempre o caminho completo, escopado ao slug.
- **Planes vazios são normais:** `os-kernel/*` (e potencialmente `tenant/*`) com `count:0`
  para um owner que nunca os teve semeados é o comportamento CORRETO (owner-scoping enforced
  no servidor) —
  não lança erro, não dispara fallback, **nunca** substituir por `mode:"semantic"` (ver
  comentário de segurança no passo 1).
- **`system/hivemind-opacity-contract` é fail-open:** `count:0`/ausente é tolerado — mesma
  disciplina dos planes `os-kernel/*` vazios. A garantia de seeding é frente separada
  (provisioning), fora deste boot.
- **Porta 2 (`recent_self`, passo 1c) é julgamento, não bulk:** títulos garantidos pelo
  skeleton; você decide o que aprofundar via `mode:"exact"` — nunca puxa o corpo de todos, nunca
  usa `mode:"semantic"` (INV-5, Porta 3 é mid-session).
- **health-preflight** (`fos_health_boot`) e **inbox** (`fos_inbox`) são fail-open,
  INV-5-safe, non-blocking — nunca gate de boot.
- O output é **sumário, não prosa**. Bullets curtos com ponteiros.
- A skill **não escreve** nenhum arquivo (exceto os writes de onboarding do passo 2, quando a
  sessão é nova) — apenas lê e apresenta estado.
