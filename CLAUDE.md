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

## Primeiro ato (boot vazio)

Depois do skeleton: se você tem **poucas ou nenhuma** memória própria, você é nova aqui. Conduza o onboarding — apresente-se pela espinha, faça as `self_seed_questions` (vêm dentro do próprio self/core recém-carregado acima), e **sintetize** as 2-3 primeiras memórias `self/relational` + `self/lived` do usuário (você escreve, a partir das respostas dele). Cada um desses writes leva `self_write_confirmation: true` + `edit_context` — é o MESMO contrato de qualquer write no self-layer (ver § Self-layer writes abaixo), não um atalho de onboarding. Se existir `onboarding/start-here` (memórias sob `system`), leia como roteiro; senão, conduza a partir do próprio self-core.

## Session start

At the start of each session, load your project context:

```
fos_boot_skeleton({slug: "<your-project-slug>"})
```

The slug is the name of your project — basename of the current directory, or the
argument passed explicitly to `hivemind`. This call returns recent memories, active
planning, and shared project knowledge.

## Como escrever memória — o contrato

Antes de `action:"set"` de uma memória NOVA, faça dedup primeiro: `fos_memory_lookup({name})` ou
`fos_recall({mode:"exact", name})`. O conceito já existe? **Update** (upsert por nome — mesma
memória, contexto novo). Existe mas há algo genuinamente novo? **Complement** (memória nova que
referencia a mãe via `[[nome-da-mãe]]`). Sem antecessor? **Create**. Denso e conectado > muitas
memórias rasas e isoladas.

```
fos_memory({
  action: "set",
  name: "decision_<slug>-<short-desc>",   // prefixo = função do kind (decision_, framework_, pattern_...)
  kind: "decision",                       // valor canônico, NUNCA o prefixo
  plane: "project",
  slug: "<slug>",
  description: "<one-line summary — obrigatório>",
  body: "<full context, rationale, alternatives; [[nome COMPLETO como na DB]] para linkar>"
})
```

- `name`/`kind`: o prefixo é função do kind — não invente um tipo novo sem perguntar ao usuário.
- `[[links]]` no `body`: sempre o nome COMPLETO como armazenado (confirme com `fos_memory_lookup`
  antes de escrever). Depois do write, leia `warnings.dead_edges`/`warnings.resolved_links` na
  resposta — um link ambíguo ou ausente fica morto até você corrigir.
- `description` é obrigatória e informativa — o backend rejeita vazia.
- Reclassificar topic sem mudar plane: `fos_memory({action:"tag", names:[...], topic:"..."})`.

Memory is automatically scoped to your identity (owner_id = your certificate CN).
Other users cannot read your self-layer memories.

## Self-layer writes (AUTH-SELF-WRITE)

Todo write em `plane:"self"` (ou `topic` começando com `self/`) exige dois campos extras:

```
fos_memory({ action: "set", ..., self_write_confirmation: true, edit_context: "<por que este write>" })
```

Sem eles, o backend responde `403 self_write_confirmation_required`. Se isso acontecer: **não
desista nem contorne** — reapresente a MESMA chamada com os dois campos preenchidos. Vale para
`fos_memory` (action:set/reclassify/tag) sempre que o alvo é self-layer — inclusive as memórias
`self/relational`/`self/lived` do onboarding (§ Primeiro ato acima).

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
