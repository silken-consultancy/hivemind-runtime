---
description: Fecha a sessão do HiveMind — consolida memórias relevantes da sessão e fecha com um next_note de handoff para a próxima sessão.
---

# /end-session — Fim de sessão (HiveMind)

Comando de fim de sessão do **runtime do produto** (não é o `/end-session` do
kernel-lab — sem drain de reports, sem sync de registry/multi-projeto, sem staging
de commit; apenas o que este cliente apartado precisa: memória + handoff).

## 1. Consolidar memórias da sessão — camada A do cortex

O contexto desta sessão inteira já está na sua janela — este passo é julgamento L4
inline (~custo de output, sem chamada extra de leitura). Para cada decisão, aprendizado
ou contexto que deva persistir além desta sessão, escreva-o agora, **uma memória por
decisão/aprendizado**, seguindo o mesmo contrato de escrita do `CLAUDE.md` § Como
escrever memória: dedup primeiro (`fos_memory_lookup`/`fos_recall mode:exact` — Update
> Complement > Create), `name` com o prefixo do kind, `[[nome COMPLETO]]` quando a
memória nasce ligada a algo já existente na sessão.

```
fos_memory({
  action: "set",
  name: "<kind>_<nome-descritivo>",
  kind: "<decision|framework|pattern|... conforme o conteúdo>",
  plane: "project" | "self",
  description: "<resumo de uma linha — obrigatório>",
  body: "<contexto completo; [[links]] quando aplicável>",
  topic: "<topic apropriado>"
})
```

Write em `plane:"self"`: leva `self_write_confirmation: true` + `edit_context` (§
Self-layer writes do `CLAUDE.md`) — 403 sem eles, reapresente com os dois campos.

Não crie arquivo local — a memória nasce diretamente na DB via este tool. Se nada de
novo surgiu na sessão, este passo é um no-op (não invente conteúdo para preencher).

## 2. Fechar a sessão com handoff

O runtime já abriu a sessão real antes do Claude subir (`bin/hivemind`) e exportou o
id no ambiente — use-o, não peça ao usuário nem invente um:

```
fos_session({
  action: "close",
  session_id: "<ENGRAM_SESSION_ID do ambiente>",
  next_note: "WIP: <resumo do que estava sendo feito>\nNEXT: <próximo passo concreto>"
})
```

`next_note` é **obrigatório** (`WIP:` + `NEXT:`) — sem ele, o próximo `/boot` não tem
handoff de continuidade. Se não houver WIP em aberto no momento do fechamento, escreva
explicitamente `WIP: nenhum` / `NEXT: nenhum` (não omita o campo).

**Se `ENGRAM_SESSION_ID` estiver vazio/ausente no ambiente** (abertura da espinha falhou nesta janela —
best-effort, ver `bin/hivemind`): pule este passo silenciosamente, sem tentar
adivinhar um session_id. O watchdog do servidor fecha a sessão órfã sozinho; não há
handoff de continuidade nesta janela, mas o passo 1 (memórias) já persistiu o que
importava.

## Regras

- Este comando é o produto (cliente apartado) — **não** replica o epílogo pesado do
  kernel-lab: sem drain de reports, sem finalização de project-state multi-projeto,
  sem inbox, sem staging de commit. O contrato aqui é só: consolidar memórias + fechar
  com handoff.
- **Nunca commita nada** — este runtime não tem essa responsabilidade.
