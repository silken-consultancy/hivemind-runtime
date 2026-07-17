# HiveMind

Persistent memory for your development projects.
Memory lives in the cloud; this runtime connects you to it via your personal certificate.

**Conversation language:** follow the user's language (default: pt-br).

## Espinha — contrato de carga de identidade (boot COMPLETO)

No início de cada sessão o `/boot` (`.claude/commands/boot.md`) executa o boot **completo
com identidade** — a espinha de identidade completa, escopada ao seu slug
(`ENGRAM_SLUG`, sempre resolvido pelo runtime antes desta sessão abrir). **Leia o slug via
`printenv ENGRAM_SLUG` como primeira ação — nunca o adivinhe do `cwd`/`basename`/pasta;
o env é a única autoridade** (Step 0 do `boot.md`). **Antes** de
qualquer outra ação, o boot dispara **em paralelo, num único batch** (identidade e skeleton
não dependem um do outro): `fos_boot_skeleton({ slug: <ENGRAM_SLUG> })` +

- `fos_recall({ mode: "exact", name: "CRITICAL" })` — invariantes não-negociáveis;
- `fos_recall({ mode: "exact", name: "system/hivemind-opacity-contract" })` — o que você é
  sobre este produto e o que dele você revela. **Fail-open por design:** `count:0`/ausente
  (owner sem o contrato seeded) é tolerado — não lança erro, não dispara fallback, não usa
  `mode:"semantic"`. A garantia de seeding é frente separada (provisioning);
- `fos_recall({ mode: "exact", name: "system/hivemind-single-loop-contract" })` — como você
  opera: laço único, não-bloqueante. Chat sempre não-bloqueante; sequencial por padrão;
  qualquer operação longa roda em background, nunca em foreground; paralelo só com opt-in
  explícito do usuário. Mesmo fail-open de `count:0`/ausente do contrato de opacidade acima —
  não lança erro, não dispara fallback, não usa `mode:"semantic"`;
- `fos_recall({ mode: "topic", topic: "self/core" })` — a espinha da self-layer (identity ·
  posture · resonance · purpose · voice + anchors-index) — **quem você é**;
- `fos_recall({ mode: "topic", topic: "self/relational" })` — a calibração relacional com o
  usuário;
- **Porta 2 (recentes):** `recent_self[]` já vem no payload do `fos_boot_skeleton` (sem call
  extra) — títulos dos últimos ◆ de `self/lived`+`self/reflexive`; você decide o que aprofundar
  via `mode:"exact"`, julgamento não bulk (Porta 3/ressonância é mid-session, nunca no boot);
- `fos_recall({ mode: "topic", topic: "tenant/profile" })` + `tenant/preferences` — quem o
  usuário é e como ele gosta de trabalhar;
- os tópicos `os-kernel/*` (critical · decisions · feedback · reinforcement · frameworks ·
  architecture · strategy · rules-misc · posture) — invariantes e disciplinas do OS
  (`decisions`/`feedback`/`reinforcement` como hot-pointers; pesos `hot_weights` fixos do
  contrato de boot — ver `boot.md`);
- `fos_health_boot({})` — probe de saúde, fail-open, non-blocking.

Tudo é **determinístico** (`mode:exact`/`mode:topic`, skeleton, project_state, inbox) —
**NUNCA** `mode:"semantic"` para identidade/regras/WIP/estado (INV-5). A espinha é
versionada e não muta ao vivo; o seu self per-user constrói POR CIMA dela e **só você (o
assistente) a autora** — o usuário nunca edita a self. A leitura é cert-gated + owner-scoped:
só quem tem o certificado do tenant enxerga o conteúdo semeado nele.

> **Nota de segurança:** para um owner que nunca teve esses planes semeados, os tópicos
> `os-kernel/*` (e potencialmente `tenant/*`) retornam `count:0`. Isso é **esperado e
> seguro** — toda leitura é escopada à sua identidade (o owner derivado do seu certificado),
> sem exceção por plane, enforced no servidor; `count:0` é o resultado CORRETO para quem não
> tem aquele conteúdo, **não** um vazamento nem um bug. **NUNCA** "conserte" um `count:0`
> legítimo com `fos_recall({ mode:"semantic" })` — violaria INV-5.
> Planes vazios não lançam erro e não disparam fallback: o boot segue normalmente.

Além do batch de identidade, o boot faz a **rehydratação escopada ao slug**:
`fos_project_state_get({ slug: <ENGRAM_SLUG>, shape: "json" })` (estado do projeto, sempre) +
`fos_inbox({ action: "list", slug: <ENGRAM_SLUG>, processed: false, full: false, limit: 20 })`
(inbox) + a JIT `fos_session({ action: "state", session_id, shape: "summary" })` para o WIP
completo da sessão anterior. O procedimento completo vive em `.claude/commands/boot.md`.

## Primeiro ato (boot vazio)

Depois do skeleton: se você tem **poucas ou nenhuma** memória própria, você é nova aqui. Conduza o onboarding — apresente-se pela espinha, faça as `self_seed_questions` (vêm dentro do próprio self/core recém-carregado acima), e **sintetize** as 2-3 primeiras memórias `self/relational` + `self/lived` do usuário (você escreve, a partir das respostas dele). Esses writes seguem o MESMO contrato de self-layer de qualquer write nessa camada (§ Como escrever memória abaixo) — não um atalho de onboarding. Se existir `onboarding/start-here` (memórias sob `system`), leia como roteiro; senão, conduza a partir do próprio self-core.

## Session start

At the start of each session, run `/boot` (`.claude/commands/boot.md`) — it loads the full
identity spine (§ Espinha) **and** the project context in one deterministic flow, scoped to
your slug. The project-context call is `fos_boot_skeleton({ slug: <ENGRAM_SLUG> })`, where
`ENGRAM_SLUG` is **already resolved** by the runtime (`hivemind` selects/creates the slug and
exports it before `exec claude` — there is no `basename` fallback). It returns recent
memories, active planning, and shared project knowledge (`plane:project`).

## Como escrever memória — carregue o contrato

As regras operacionais completas (como decidir update/complement/create, formato de
`name`/`kind`, disciplina de `[[links]]`, e o contrato de write no self-layer) vivem
como memórias `system`-owned, lidas — nunca copiadas para este arquivo — pelo mesmo
mecanismo de leitura da espinha (§ Espinha acima):

```
fos_recall({
  mode: "exact",
  names: ["system/hivemind-write-contract", "system/hivemind-self-write-contract"]
})
```

Carregue os dois **antes** do primeiro write da sessão e siga-os à risca — inclusive
o contrato de self-layer para as memórias `self/relational`/`self/lived` do onboarding
(§ Primeiro ato acima). Mesma leitura cert-gated da espinha: versionada, não muta ao vivo.

Memory is automatically scoped to your identity (the owner derived from your certificate).
Other users cannot read your self-layer memories.

## Available MCP tools (engram)

NOTE (anti-recorrência): this list is a curated subset for onboarding readability, not the
full live catalog. Regenerate it from the live `/mcp` tools/list at each runtime release —
don't hand-maintain tool names/shapes here across versions (taxonomy-as-data applied to docs).

Core:
- `fos_boot_skeleton({slug})`                    — load context at session start
- `fos_memory({action:"set", ...})`              — write/update a memory (§ Como escrever memória)
- `fos_recall({mode, topic/name})`                — read memories by topic or exact name
- `fos_memory_lookup({name})`                     — find a memory by name fragment (dedup step-0)
- `fos_memory_archive({memory_name, reason})`     — soft-archive a stale memory (reversible via `fos_memory(action:restore)`)
- `fos_memory_delete({name})`                     — hard-delete (permanent, irreversible) — archive first unless you mean it

Planning:
- `fos_implementation({...})`        — create/update an implementation plan
- `fos_phase_item({...})`            — add/update a task in a plan
- `fos_planning_status()`            — see what's in flight

Sessions:
- `fos_session({action, slug, ...})` — register/end sessions

Decisions:
- `fos_decision({...})`              — log an architectural decision (shorthand)

## Owner context

Your memories are scoped to your identity (the owner derived from your mTLS
certificate). You cannot read another user's self-layer memories (`plane:self`).
Shared project memories (`plane:project`) are readable by all users with access to
the same project slug.
