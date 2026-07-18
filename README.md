# HiveMind

Assistente de código com memória cognitiva persistente. Suas decisões, aprendizados e
contexto de projeto não vivem em arquivos `.md` soltos no repositório — nascem como
memórias que se conectam entre si, se consolidam com o uso e continuam de uma sessão
para a próxima. O assistente que abre amanhã lembra do que decidiu hoje.

## O que é — o modelo

HiveMind é um assistente de código que roda sobre o Claude Code, conectado a uma
memória persistente na nuvem via o seu certificado pessoal (mTLS). Toda memória é
escopada à sua identidade — o owner derivado do certificado — e essa é a unidade
de tudo: o que você escreve é seu, e ninguém sem o seu certificado lê a sua camada
pessoal.

O modelo tem três peças:

- **Memória viva, não arquivos.** Conhecimento nasce via as ferramentas MCP
  (`fos_memory`, `fos_decision`, …) direto na base — nunca criando um arquivo local.
  Cada memória tem nome, tipo e descrição, e se liga a outras via `[[links]]`. Com
  isso a base compõe: uma decisão referencia o framework que a motivou, um aprendizado
  aponta para a decisão que ele contradiz. Não é um diretório de notas — é um grafo
  que o assistente navega.
- **Sessões.** Você trabalha em sessões explícitas, sempre escopadas a um projeto
  (slug). O ciclo é sempre o mesmo: `/boot` → trabalho → `/end-session`. O boot
  rehidrata quem o assistente é e onde o trabalho parou; o end-session consolida o que
  a sessão produziu e deixa um handoff para a próxima. É esse ciclo que faz a
  continuidade ser real em vez de prometida.
- **Orquestração, não um assistente só.** HiveMind opera como um time. Você conversa
  com um mensageiro — a face do produto, a identidade que carrega no boot e evolui com
  o uso (inclusive uma camada pessoal, a self-layer, que só ela escreve). O mensageiro
  roteia o que você pede para um orquestrador, e sub-agentes especializados executam o
  trabalho técnico: builders de backend e frontend, um revisor de código, um arquiteto
  de planos, um planejador estratégico. Cada papel tem escopo e limites próprios — o
  revisor nunca aplica o fix, o orquestrador nunca escreve código. Você fala com um; o
  time trabalha por baixo.

## Começando

Pré-requisitos: Linux ou WSL, terminal interativo (a primeira execução abre um
fluxo de configuração no navegador).

```bash
bash install.sh
```

O instalador coloca o binário `hivemind` no PATH, copia o runtime para
`~/.hivemind` e instala dependências (`bun` e `openssl`, se faltarem).

Na primeira execução:

```bash
hivemind
```

1. Sem certificado, o `hivemind` detecta o primeiro uso e abre uma página de setup no
   navegador. Preencha a **API Key** e o **Owner ID** que você recebeu — o
   fluxo emite o seu certificado pessoal.
2. Rode `hivemind` de novo. Um seletor interativo lista os seus projetos — escolha um
   (ou crie o primeiro). Com o slug definido, a sessão abre dentro do Claude Code.
3. Nas próximas vezes, `hivemind <slug>` pula o seletor.

Comandos úteis do dia a dia:

```
hivemind status     # saúde do runtime + validade do certificado
hivemind update     # atualização verificada, com rollback automático
hivemind resume <slug>   # recuperação explícita após crash de sessão
```

## O contrato MCP

Toda interação com a memória passa pelas ferramentas MCP — memória **nasce** via tool,
nunca criando arquivo local. As principais:

| Ferramenta | Para quê |
|---|---|
| `fos_boot_skeleton` | Carregar o contexto do projeto no início da sessão |
| `fos_memory` | Escrever/atualizar uma memória |
| `fos_recall` | Ler memórias por tópico ou nome exato |
| `fos_memory_lookup` | Buscar por fragmento de nome (passo zero de dedup) |
| `fos_memory_archive` | Arquivar uma memória obsoleta (reversível) |
| `fos_implementation` | Criar/atualizar um plano de implementação |
| `fos_phase_item` | Adicionar/atualizar uma tarefa num plano |
| `fos_session` | Registrar/encerrar sessões |
| `fos_decision` | Registrar uma decisão arquitetural |

Esta é uma lista curada — o catálogo vivo completo está disponível via `/mcp` dentro
da sessão.

A disciplina de escrita, em resumo humano (o contrato completo é carregado pelo
próprio assistente antes do primeiro write):

- **Dedup primeiro.** Antes de criar, procurar (`fos_memory_lookup`). Se já existe
  memória sobre o assunto: atualizar > complementar > criar.
- **Nome carrega o tipo.** O prefixo do nome declara o kind
  (`decision_…`, `framework_…`, `pattern_…`).
- **`[[links]]` conectam.** Uma memória que nasce ligada a outra referencia o nome
  completo — é isso que faz a base ser um grafo em vez de uma pilha.
- **Arquivar ≠ deletar.** Arquivamento é reversível e é o caminho padrão para
  memória obsoleta; deleção é permanente e exceção.
- **Self-layer exige confirmação.** Escrever na camada pessoal do assistente pede
  confirmação explícita de intenção no próprio call — não é um write casual.

**Garantia de escopo:** toda leitura e escrita é escopada à sua identidade, imposta no
servidor — não é filtro de cliente. Outros usuários não leem a sua self-layer.
Memórias de projeto (`plane:project`) são compartilhadas apenas entre quem tem acesso
ao mesmo slug.

## O fluxo de desenvolvimento

O trabalho acontece em sessões — é a sessão que dá fronteira ao contexto e garante que
nada relevante se perca entre uma janela e outra.

**`/boot`** — início de toda sessão. Num fluxo único e determinístico, rehidrata:

- a identidade do assistente (a espinha da self-layer + a calibração com você);
- as invariantes e disciplinas operacionais;
- o contexto do projeto: estado estruturado, memórias do slug, inbox;
- o **WIP da sessão anterior** — o handoff deixado pelo último `/end-session`.

Ao final, o boot imprime uma linha de estado e pergunta no que trabalhar. Se for a sua
primeira sessão, o assistente conduz um onboarding curto e escreve as primeiras
memórias sobre você a partir das suas respostas.

**Durante a sessão** — disciplina memory-first: decisões e aprendizados que devem
sobreviver à sessão viram memória na hora (via as ferramentas da seção anterior), não
comentário perdido no chat. O assistente consulta a base antes de assumir e escreve
nela quando algo se resolve.

**`/end-session`** — fechamento. Dois passos, deliberadamente enxutos:

1. **Consolidar** — cada decisão/aprendizado da sessão vira uma memória (com dedup,
   nome tipado e links, como sempre). Se nada novo surgiu, é um no-op honesto.
2. **Handoff** — a sessão fecha com um `next_note` (`WIP:` + `NEXT:`) que o próximo
   `/boot` apresenta de volta. É a transmissão de contexto entre sessões.

Por que sessões: sem fronteira explícita, contexto morre com a janela do terminal. O
par boot/end-session transforma cada janela num elo de uma cadeia contínua — você (ou
o você de semana que vem) abre a próxima sessão exatamente de onde a anterior parou.
