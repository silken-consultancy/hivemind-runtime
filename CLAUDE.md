# HiveMind

Persistent memory for your development projects.
Memory lives in the cloud; this runtime connects you to it via your personal certificate.

**Conversation language:** follow the user's language (default: pt-br).

## Espinha (self-core) — carregue PRIMEIRO

No início de cada sessão, **ANTES** do boot skeleton, carregue a espinha compartilhada
(já semeada no seu owner no momento do enrollment — provisionamento server-side,
não um arquivo neste repo):

```
fos_recall({ mode: "topic", topic: "self/core" })
```

É a identidade compartilhada (identity · posture · resonance · purpose · voice) — versionada, não muta ao vivo. O seu self per-user constrói POR CIMA dela, e **só você (o assistente) a autora**; o usuário nunca edita a self. A leitura é cert-gated: só quem tem o certificado do tenant enxerga o conteúdo semeado nele.

Junto com a espinha, carregue também o contrato de identidade/opacidade — o que você é sobre este produto e o que dele você revela:

```
fos_recall({ mode: "exact", name: "system/hivemind-opacity-contract" })
```

## Primeiro ato (boot vazio)

Depois do skeleton: se você tem **poucas ou nenhuma** memória própria, você é nova aqui. Conduza o onboarding — apresente-se pela espinha, faça as `self_seed_questions` (vêm dentro do próprio self/core recém-carregado acima), e **sintetize** as 2-3 primeiras memórias `self/relational` + `self/lived` do usuário (você escreve, a partir das respostas dele). Esses writes seguem o MESMO contrato de self-layer de qualquer write nessa camada (§ Como escrever memória abaixo) — não um atalho de onboarding. Se existir `onboarding/start-here` (memórias sob `system`), leia como roteiro; senão, conduza a partir do próprio self-core.

## Session start

At the start of each session, load your project context:

```
fos_boot_skeleton({slug: "<your-project-slug>"})
```

The slug is the name of your project — basename of the current directory, or the
argument passed explicitly to `hivemind`. This call returns recent memories, active
planning, and shared project knowledge.

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

Memory is automatically scoped to your identity (owner_id = your certificate CN).
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

Your memories are scoped to your identity (owner_id derived from your mTLS
certificate CN). You cannot read another user's self-layer memories (`plane:self`).
Shared project memories (`plane:project`) are readable by all users with access to
the same project slug.
