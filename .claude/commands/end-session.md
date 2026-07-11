---
description: Fecha a sessão do HiveMind — consolida memórias relevantes da sessão e fecha com um next_note de handoff para a próxima sessão.
---

# /end-session — Fim de sessão (HiveMind)

Comando de fim de sessão do **runtime do produto** (não é o `/end-session` do
kernel-lab — sem drain de reports, sem sync de registry/multi-projeto, sem staging
de commit; apenas o que este cliente apartado precisa: memória + handoff).

## 1. Consolidar memórias da sessão

Para cada decisão, aprendizado ou contexto desta sessão que deva persistir além dela,
escreva-o agora — uma memória por decisão/aprendizado:

```
fos_memory({
  action: "set",
  name: "<nome descritivo>",
  kind: "<decision|framework|pattern|... conforme o conteúdo>",
  plane: "project" | "self",
  description: "<resumo de uma linha>",
  body: "<contexto completo>",
  topic: "<topic apropriado>"
})
```

Não crie arquivo local — a memória nasce diretamente na DB via este tool. Se nada de
novo surgiu na sessão, este passo é um no-op (não invente conteúdo para preencher).

## 2. Fechar a sessão com handoff

```
fos_session({
  action: "close",
  session_id: "<SESSION_ID desta sessão>",
  next_note: "WIP: <resumo do que estava sendo feito>\nNEXT: <próximo passo concreto>"
})
```

`next_note` é **obrigatório** (`WIP:` + `NEXT:`) — sem ele, o próximo `/boot` não tem
handoff de continuidade. Se não houver WIP em aberto no momento do fechamento, escreva
explicitamente `WIP: nenhum` / `NEXT: nenhum` (não omita o campo).

## Regras

- Este comando é o produto (cliente apartado) — **não** replica o epílogo pesado do
  kernel-lab: sem drain de reports, sem finalização de project-state multi-projeto,
  sem inbox, sem staging de commit. O contrato aqui é só: consolidar memórias + fechar
  com handoff.
- **Nunca commita nada** — este runtime não tem essa responsabilidade.
