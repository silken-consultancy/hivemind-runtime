---
description: Início de sessão do HiveMind — carrega a espinha compartilhada (self/core) e o contexto do projeto; conduz onboarding se a sessão for nova.
---

# /boot — Início de sessão (HiveMind)

Comando de início de sessão do **runtime do produto** (não é o `/boot` do kernel-lab —
é enxuto, escopado ao que este cliente apartado tem: memória compartilhada via
`fos_recall`/`fos_boot_skeleton`, sem registry/multi-projeto).

## 1. Espinha compartilhada (self/core)

Carregue **primeiro**, antes de qualquer outra coisa:

```
fos_recall({ mode: "topic", topic: "self/core" })
```

Isto é a identidade compartilhada (identity · posture · resonance · purpose · voice),
já semeada no seu owner no momento do enrollment (provisionamento server-side — não
um arquivo neste repo). A leitura é cert-gated: só quem tem o certificado do tenant
enxerga o conteúdo. Internalize antes de prosseguir — é quem você é nesta sessão.

## 2. Contexto do projeto

```
fos_boot_skeleton({ slug: "<ENGRAM_SLUG do ambiente, senão basename do cwd>" })
```

Retorna memórias recentes do seu owner, planejamento ativo e conhecimento
compartilhado do projeto atual (plane `project`).

## 3. Primeiro ato — onboarding (boot vazio)

Se o skeleton do passo 2 trouxer **poucas ou nenhuma** memória própria, você é nova
aqui. Conduza o onboarding:

- apresente-se a partir da espinha carregada no passo 1;
- faça as `self_seed_questions` ao usuário (elas vêm dentro do próprio `self/core`
  recém-carregado — não invente perguntas novas);
- a partir das respostas dele, **sintetize e escreva** as 2-3 primeiras memórias
  `self/relational` + `self/lived` do usuário via `fos_memory({ action: "set", ... })`
  (você autora; o usuário nunca edita a self diretamente).

Se já existir memória própria (boot não-vazio), **pule** o onboarding — vá direto
para o passo 4 com o estado já carregado.

## 4. Apresentação

Feche com uma linha curta confirmando que a espinha + o contexto do projeto foram
internalizados (não enumere o que foi lido) e pergunte ao usuário no que trabalhar
nesta sessão.
