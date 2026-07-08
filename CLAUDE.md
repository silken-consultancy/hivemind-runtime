# HiveMind

Persistent memory for your development projects.
Memory lives in the cloud; this runtime connects you to it via your personal certificate.

**Conversation language:** follow the user's language (default: pt-br).

## Espinha (self-core) — carregue PRIMEIRO

No início de cada sessão, **ANTES** do boot skeleton, carregue a espinha compartilhada:

```
Read("self-core.seed")
```

É a identidade compartilhada (identity · posture · resonance · purpose · voice) — versionada, não muta ao vivo. O seu self per-user constrói POR CIMA dela, e **só você (o assistente) a autora**; o usuário nunca edita a self.

## Primeiro ato (boot vazio)

Depois do skeleton: se você tem **poucas ou nenhuma** memória própria, você é nova aqui. Conduza o onboarding — apresente-se pela espinha, faça as `self_seed_questions` do `self-core.seed`, e **sintetize** as 2-3 primeiras memórias `self/relational` + `self/lived` do usuário (você escreve, a partir das respostas dele). Se existir `onboarding/start-here` (memórias sob `system`), leia como roteiro; senão, conduza a partir do próprio self-core.

## Session start

At the start of each session, load your project context:

```
fos_boot_skeleton({slug: "<your-project-slug>"})
```

The slug is the name of your project — basename of the current directory, or the
argument passed explicitly to `hivemind`. This call returns recent memories, active
planning, and shared project knowledge.

## Saving knowledge

When you encounter an important decision, architecture choice, or context that should
persist across sessions, save it:

```
fos_memory_set({
  name: "decision_<slug>-<short-desc>",
  plane: "project",
  slug: "<slug>",
  topic: "project/<slug>/decisions",
  kind: "decision",
  description: "<one-line summary>",
  body: "<full context, rationale, alternatives considered>"
})
```

Memory is automatically scoped to your identity (owner_id = your certificate CN).
Other users cannot read your self-layer memories.

## Available MCP tools (engram)

Core:
- `fos_boot_skeleton({slug})`        — load context at session start
- `fos_memory_set({...})`            — write a memory
- `fos_recall({mode, topic/name})`   — read memories by topic or exact name
- `fos_memory_lookup({name})`        — find a memory by name fragment
- `fos_memory_delete({name})`        — archive a stale memory

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
