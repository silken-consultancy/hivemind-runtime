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
git clone https://github.com/silken-consultancy/hivemind-runtime.git
cd hivemind-runtime && bash install.sh
```

No Windows nativo (PowerShell):

```powershell
git clone https://github.com/silken-consultancy/hivemind-runtime.git
cd hivemind-runtime; powershell -ExecutionPolicy Bypass -File install.ps1
```

O instalador coloca o binário `hivemind` no PATH, copia o runtime para
`~/.hivemind` e instala dependências (`bun` e `openssl`, se faltarem).

**Dois componentes.** O **proxy** (a conexão mTLS com a memória) é sempre instalado;
o **harness** do Claude Code (`~/.hivemind/.claude`: CLAUDE.md, settings, comandos,
hooks e o estado isolado do Claude Code) vem por padrão e é opcional:

```bash
bash install.sh               # proxy + harness (o padrão)
bash install.sh --proxy-only  # só o proxy — conecte o cliente MCP que você quiser
```

O que está instalado fica registrado em `~/.hivemind/.components`. Uma instalação
anterior a isso (sem o arquivo) é proxy + harness e continua igual. Para acrescentar o
harness depois, rode `bash install.sh` de novo, sem `--proxy-only`.

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

Numa instalação só-proxy, `hivemind` sobe apenas o proxy e mostra como conectar o
seu cliente — o Claude Code não é aberto:

```bash
# Claude Code
claude mcp add --transport http --scope user engram https://127.0.0.1:7779/v1/mcp
# Codex (~/.codex/config.toml)
[mcp_servers.engram]
url = "https://127.0.0.1:7779/v1/mcp"
# Cursor, Antigravity, Cowork ou outro
hivemind install [cursor|antigravity|cowork|manual]
```

A porta real aparece na saída do `hivemind` (padrão 7779). O certificado do proxy é
emitido por uma CA local (`~/.engram/mtls/local-https/ca.cert.pem`) que o `hivemind`
confia no sistema; um cliente que ainda o rejeite deve apontar para esse arquivo
(clientes Node: `NODE_EXTRA_CA_CERTS`).

**Alternativa sem o proxy local:** um cliente que não consegue usar o proxy pode se
conectar direto ao MCP do engram por HTTPS com uma chave bearer (onde o seu plano
permitir) — URL `https://api.hivemind.ia.br/v1/mcp`, header
`Authorization: Bearer fospb_…`, chave criada no app web do HiveMind (acesso por API
Key). O `hivemind` só mostra essa URL numa instalação apontada para o endpoint padrão;
com outro endpoint, defina `HIVEMIND_DIRECT_MCP_URL` no ambiente.

Comandos úteis do dia a dia:

```
hivemind status     # saúde do runtime + validade do certificado
hivemind update     # atualização verificada, com rollback automático
hivemind resume <slug>   # recuperação explícita após crash de sessão
```

**De onde vêm as atualizações.** Uma atualização faz `git reset --hard` na fonte, por
isso ela só roda numa fonte que pode ser resetada — **nunca** num clone de
desenvolvimento (um clone que versiona `.github/`):

- **Instalação a partir do repositório de distribuição** (o clone do `git clone` acima,
  que não versiona `.github/`): atualiza direto desse clone, como sempre.
- **Instalação a partir de um clone de desenvolvimento, Linux/WSL:** no próximo
  `hivemind` / `hivemind update` a fonte passa, uma vez, para um clone gerenciado em
  `~/.hivemind.src` (só o `hivemind` escreve nele) e o branch de atualização vira
  `main`. O clone antigo não é tocado; o `.env` anterior fica em
  `~/.engram/env.pre-managed-source` (modo 0600, sobrevive às atualizações). Enquanto
  essa troca não acontece — sem rede (nova tentativa no máximo a cada 24h;
  `hivemind update` tenta na hora), `~/.hivemind.src` ocupado por outra coisa, `.env`
  sem permissão de escrita, sem `timeout` —, a atualização é **recusada**:
  `hivemind update` diz por quê e sai com erro; o lançamento segue sem atualizar
  (`hivemind --verbose` mostra o motivo).
- **Windows nativo:** não há clone gerenciado. Instale a partir do repositório de
  distribuição; uma instalação feita de um clone de desenvolvimento não se atualiza
  (`hivemind update` recusa com mensagem; `hivemind --verbose` mostra o motivo no
  lançamento).

**Quando a checagem automática roda.** Linux/WSL: a cada `hivemind` (o lançamento, com
ou sem harness); `hivemind start` — e portanto o autostart no login — só sobe o proxy,
sem checar atualização. Windows: `hivemind` e `hivemind start` são o mesmo comando (não
há lançamento de harness no Windows), então a checagem roda a cada start, inclusive o
do autostart no logon. Em todos os casos ela é silenciosa e nunca impede o start.

### Desinstalar

```bash
hivemind uninstall               # lista tudo o que vai sair e pede confirmação [y/N]
hivemind uninstall --yes         # sem confirmação (scripts)
hivemind uninstall --keep-certs  # mantém os certificados (~/.engram/mtls + device-id)
hivemind uninstall harness       # remove só o harness do Claude Code; o proxy continua
```

`hivemind uninstall harness` remove `~/.hivemind/.claude` inteiro (incluindo o estado
isolado do Claude Code, listado antes) e o statusline, e marca a instalação como
só-proxy (também apaga inteiras as cópias de atualização `~/.hivemind.staging` e
`~/.hivemind.last-good` — nenhum backup fica). O daemon, o runtime, o `.env`, `~/.engram`, os clientes
conectados e o binário ficam; `hivemind update` não traz o harness de volta — desde que
rode com um binário desta versão ou posterior (um `hivemind` antigo mais cedo no PATH
reinstalaria o harness).

Remove o que o HiveMind instalou nesta máquina: o harness (`~/.hivemind/.claude`,
**incluindo o estado isolado do Claude Code** — histórico, projetos, sessões,
credenciais), a entrada `mcpServers.engram` em cada cliente conectado por
`hivemind install` (só se ainda aponta para a porta do HiveMind; os outros
servidores do arquivo ficam), as skills do Cowork, `~/.hivemind`, o clone de atualização `~/.hivemind.src`, `~/.engram`, a CA
local confiada no sistema (via `sudo`) e o binário `hivemind`. Não toca em `~/.bun`,
no seu `~/.claude` pessoal, `~/.claude.json`, `~/.mcp.json`, nos seus clones nem nos
arquivos do shell. Não revoga o dispositivo no servidor. Do clone, `bash
uninstall.sh` faz o mesmo (é um wrapper fino sobre `hivemind uninstall`).

### Outros clientes locais (Cursor, Antigravity, Cowork)

`hivemind install [<target>]` faz o guiado de conectar OUTRO cliente MCP local
(além do próprio Claude Code) à mesma memória — detecta candidatos, pergunta o
escopo, e confirma o caminho exato antes de escrever qualquer coisa (nunca um
caminho padrão silencioso).

**Clientes Windows-nativos sob WSL2 (Cursor, Cowork, Antigravity) já funcionam
hoje, sem ponte/relay manual.** O runtime escreve uma URL de loopback
(`https://127.0.0.1:<porta>/v1/mcp`) do lado Linux/WSL; um cliente rodando
nativo no Windows alcança essa mesma URL porque o WSL2 já encaminha, por
padrão, portas de loopback do lado Linux para o `localhost` do Windows
(*localhost-forwarding*, comportamento padrão do WSL2, sem necessidade de
`.wslconfig` ou configuração extra). Confirmado em teste real (Cursor e Claude
Cowork, a partir do Windows, contra o proxy hospedado no WSL — founder,
2026-08-08).

Para rodar o proxy direto no Windows, sem WSL, use o `install.ps1` (só o proxy —
ver "No Windows nativo" acima).

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
primeira sessão (no seu primeiro projeto, criado na web), o assistente conduz um onboarding curto e escreve as primeiras
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
