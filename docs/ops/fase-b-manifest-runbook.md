# Fase B — RUNBOOK (founder): manifesto `LATEST_SHA` (PRODUTO + LAB)

**Escopo desta autoria:** o repo `hivemind-runtime` (B3 —
`.github/workflows/publish-latest-sha.yml`, DUAL-TARGET, já escrito e commitável) + autoria de
patch/runbook para os DOIS hosts que servem o manifesto — **produto** e o **edge do lab**
(`silken-ops/edge/Caddyfile`, já editado no working tree desse repo, também NÃO commitado).
**NADA foi aplicado em nenhum dos dois hosts, nenhum push/commit foi feito em nenhum repo.**
Quem aplica é o founder.

**REWORK (2026-07-13, founder-aprovado):** o auto-update precisa espelhar o manifesto TAMBÉM
no lab, porque o cliente de dogfood (notebook) aponta
`HIVEMIND_ENDPOINT=kernel.silken.ia.br:4443`, e `_verify_commit_integrity` busca o
`LATEST_SHA` em `https://kernel.silken.ia.br/hivemind/LATEST_SHA` (porta 443, o edge do lab)
— não no host de produto. Mesma base (HEAD de `main`) publica os dois, os manifestos batem
por construção.

Plano-mãe: `docs/wip/hivemind-cicd-produto-plan.md` § Fase B (impl `996b07c7-...`, fase
`a5bfa823-40db-4829-a6d9-28267d79db2a`). Gate B4 já decidido: **usuário SSH restrito com
forced-command** (não root — repo público, blast-radius mínimo), replicado nos DOIS hosts.

---

# PARTE 1 — PRODUTO

## (a) Usuário SSH restrito + forced-command no host de produto

### a.1 — criar o usuário (sem shell de login interativo real; forced-command sempre vence)

```bash
useradd --create-home --shell /bin/bash hivemind-publish
mkdir -p /home/hivemind-publish/.ssh
chmod 700 /home/hivemind-publish/.ssh
```

### a.2 — script receptor (grava o manifesto, valida formato, escrita atômica)

**RELOCATE (opção B, decidida pelo founder):** o manifesto e o script receptor NÃO vivem em
`/root/...` — o usuário restrito `hivemind-publish` é non-root e não atravessa um `/root`
`0700` sem contorno adicional de permissões no diretório home de root (essa alternativa foi
avaliada e DESCARTADA). Relocar para `/srv/hivemind/` mata esse footgun de raiz: `/srv` é o
path convencional para dado servido por um daemon, dono e permissão ficam simples e diretos,
sem precisar tocar em `/root` nem em nenhum mecanismo extra de permissão.

Criar `/srv/hivemind/bin/receive-latest-sha.sh` — dono **`hivemind-publish`** desde a
criação (não root; o SSHd executa o forced-command com o UID do usuário `hivemind-publish`
via `command=` do `authorized_keys` abaixo, então o script e o diretório do manifesto
precisam ser **graváveis por esse usuário**):

```bash
#!/bin/bash
# /srv/hivemind/bin/receive-latest-sha.sh
# Forced-command receptor do workflow publish-latest-sha.yml (hivemind-runtime).
# O SHA chega por STDIN (não por argumento de comando — com forced-command,
# o "comando" que o cliente ssh manda vira apenas $SSH_ORIGINAL_COMMAND e é
# ignorado aqui; usamos stdin de propósito, ver comentário no workflow).
set -euo pipefail

MANIFEST_DIR="/srv/hivemind/manifest"
MANIFEST_FILE="${MANIFEST_DIR}/LATEST_SHA"

mkdir -p "${MANIFEST_DIR}"

sha="$(cat -)"
sha="$(printf '%s' "${sha}" | tr -d '[:space:]')"

# Defensivo: só aceita 40 hex chars (formato de um git SHA-1 completo).
if ! printf '%s' "${sha}" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "reject: not a 40-char hex sha" >&2
  exit 1
fi

# Escrita atômica (tmp + mv no MESMO filesystem) — nunca deixa o manifesto
# num estado parcial se o processo morrer no meio da escrita.
tmp="$(mktemp "${MANIFEST_DIR}/.LATEST_SHA.XXXXXX")"
printf '%s' "${sha}" > "${tmp}"
mv -f "${tmp}" "${MANIFEST_FILE}"
echo "ok: wrote ${sha}"
```

```bash
# Setup completo sob /srv (RELOCATE — não mais duas opções concorrentes de
# permissão como na versão anterior deste runbook sob /root: com o dado fora
# de /root, dono direto do usuário restrito é simplesmente a forma certa,
# sem precisar de sudoers/wrapper nem de ACL).
mkdir -p /srv/hivemind/{manifest,bin}
chown -R hivemind-publish:hivemind-publish /srv/hivemind
chmod +x /srv/hivemind/bin/receive-latest-sha.sh
```

### a.3 — a linha EXATA de `authorized_keys` (forced-command)

Gerar o par de chaves dedicado (rodar localmente, NUNCA no host):

```bash
ssh-keygen -t ed25519 -C "hivemind-runtime-publish-latest-sha" -f ./hivemind_publish_key -N ""
```

Colar a **pública** em `/home/hivemind-publish/.ssh/authorized_keys` no host, com o prefixo
`command=` (forced-command) e as restrições abaixo — troque `AAAA...` pelo conteúdo real
gerado acima:

```
command="/srv/hivemind/bin/receive-latest-sha.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,no-user-rc ssh-ed25519 AAAA...SUBSTITUA... hivemind-runtime-publish-latest-sha
```

```bash
chmod 600 /home/hivemind-publish/.ssh/authorized_keys
chown -R hivemind-publish:hivemind-publish /home/hivemind-publish/.ssh
```

**Por que isso é seguro mesmo com repo público:** qualquer sessão SSH aberta com essa chave —
não importa o comando que o cliente tente mandar — sempre executa
`receive-latest-sha.sh`, nunca um shell. `no-pty`/`no-port-forwarding`/`no-agent-forwarding`
fecham os desvios usuais de forced-command (proxy reverso via -R, alocação de pty, etc). O
pior caso de vazamento da chave privada é: um atacante escreve um SHA arbitrário (mas
válido em formato) no manifesto — não obtém shell, não lê arquivos, não escreve fora do
diretório do manifesto.

A privada (`hivemind_publish_key`, sem passphrase — GH Actions não interage) vai para o GH
secret `PROD_MANIFEST_SSH_KEY` (§ b). **Apagar o arquivo local após colar no GH.**

---

## (b) Os 3 GH secrets de PRODUTO no repo `hivemind-runtime`

```bash
gh secret set PROD_MANIFEST_SSH_HOST --repo <org>/hivemind-runtime   # IP/hostname do host de produto
gh secret set PROD_MANIFEST_SSH_USER --repo <org>/hivemind-runtime   # hivemind-publish
gh secret set PROD_MANIFEST_SSH_KEY  --repo <org>/hivemind-runtime < ./hivemind_publish_key
```

Também é preciso um `environment: production` no repo `hivemind-runtime` (o job `publish-prod`
referencia `environment: production` — GH Actions cria automaticamente ao primeiro uso, mas
confirme que não há required reviewers configurados nele que bloqueariam o push-trigger
automático; isso quebraria o "publica a cada merge, sem curadoria" — decisão #2 do founder).
**Ver § LAB abaixo para os outros 3 secrets (`LAB_MANIFEST_SSH_*`) e o `environment: lab`.**

---

## (c) Rota Caddy `/hivemind/*` + volume + reload

### c.1 — bloco Caddy (inserir ANTES do catch-all `handle {}` do site `hivemind.silken.ia.br`)

**Ordem importa** (Caddy casa `handle` do mais específico pro mais genérico na ORDEM em que
aparecem no arquivo — o catch-all tem que vir DEPOIS, senão engole tudo antes do Caddy
avaliar `/hivemind/*`). Preservar as rotas já verdes hoje (`/ca/*`, `/healthz`) — só
ADICIONAR o bloco novo, não reordenar as existentes:

```caddyfile
hivemind.silken.ia.br {
	# ... blocos já existentes preservados (ex: /ca/*, /healthz) ...

	# NOVO (Fase B) — manifesto de auto-update do cliente hivemind-runtime.
	# Serve APENAS /hivemind/LATEST_SHA (e qualquer outro arquivo estático que
	# for colocado no mesmo diretório no futuro) — read-only, sem exec.
	handle /hivemind/* {
		root * /etc/caddy/manifest
		file_server
	}

	# ... catch-all existente por ÚLTIMO, sem mudança ...
	handle {
		# comportamento já existente, preservado
	}
}
```

O path servido é `/etc/caddy/manifest/hivemind/LATEST_SHA` a menos que o `root` acima seja
ajustado — **atenção**: como o `handle /hivemind/*` já casa o prefixo `/hivemind/`, e
`file_server` serve relativo ao `root`, a requisição `GET /hivemind/LATEST_SHA` com
`root * /etc/caddy/manifest` busca `/etc/caddy/manifest/hivemind/LATEST_SHA` no filesystem
DENTRO do container Caddy. Duas formas de resolver, escolha uma e seja consistente com o
volume do passo c.2:
  - **(recomendado)** montar o volume do host em `/etc/caddy/manifest/hivemind/` (um nível a
    mais), OU
  - usar `handle_path /hivemind/*` (que STRIPA o prefixo antes de servir) em vez de `handle`
    — aí `root * /etc/caddy/manifest` + volume plano funciona sem o nível extra.

Recomendo `handle_path` (mais simples, um nível a menos de diretório para gerenciar):

```caddyfile
handle_path /hivemind/* {
	root * /etc/caddy/manifest
	file_server
}
```

Com isso, `GET /hivemind/LATEST_SHA` → serve `/etc/caddy/manifest/LATEST_SHA` no container.

### c.2 — volume no compose (adicionar ao serviço Caddy em `compose.hivemind.yml` ou
equivalente que sobe o container `hivemind-caddy`)

```yaml
services:
  caddy: # nome real do serviço pode diferir — confirmar no compose real do host
    volumes:
      - /srv/hivemind/manifest:/etc/caddy/manifest:ro # NOVO — read-only, Caddy só lê
      # ... volumes já existentes preservados ...
```

`:ro` é importante — Caddy nunca precisa escrever ali; só o
`receive-latest-sha.sh` (rodando como `hivemind-publish` no HOST, fora do container) escreve.

### c.3 — aplicar (validar ANTES de reload — não pular)

```bash
# 1. Editar o Caddyfile real no host com os blocos acima.
# 2. Validar ANTES de qualquer reload:
docker exec hivemind-caddy caddy validate --config /etc/caddy/Caddyfile
# 3. Só se validate passar:
docker compose -f <compose-file-do-host> up -d caddy   # recria com o volume novo
# ou, se só mudou o Caddyfile (sem novo volume ainda):
docker exec hivemind-caddy caddy reload --config /etc/caddy/Caddyfile
# 4. Confirmar as rotas JÁ verdes continuam verdes (não regredir):
curl -sf https://hivemind.silken.ia.br/healthz
curl -sf https://hivemind.silken.ia.br/ca/... # (ajustar path real de /ca/*)
```

---

## (d) Semear o `LATEST_SHA` uma vez (manifesto vazio = fail-closed persiste)

Sem isso, mesmo com Caddy servindo a rota, `curl .../LATEST_SHA` devolve vazio/404 (arquivo
inexistente) até o primeiro push em `main` disparar o workflow B3 — e enquanto isso o
cliente continua falhando fechado. Semear manualmente ANTES ou LOGO APÓS aplicar (c):

```bash
mkdir -p /srv/hivemind/manifest
git -C <checkout-local-do-hivemind-runtime> rev-parse HEAD | tr -d '\n' > /srv/hivemind/manifest/LATEST_SHA
# confirmar sem newline final:
xxd /srv/hivemind/manifest/LATEST_SHA | tail -3
chown hivemind-publish:hivemind-publish /srv/hivemind/manifest/LATEST_SHA
```

Depois de aplicar (c) + (d), validar ponta-a-ponta:

```bash
curl -sf https://hivemind.silken.ia.br/hivemind/LATEST_SHA
# deve devolver o sha atual de main, 40 hex chars, sem newline.
```

---

# PARTE 2 — LAB (NOVO, REWORK 2026-07-13)

**Por que existe:** o cliente de dogfood do lab (notebook do founder) roda com
`HIVEMIND_ENDPOINT=kernel.silken.ia.br:4443` (ver `env.template` / `.hivemind/.env` real do
notebook). `bin/hivemind:_verify_commit_integrity` deriva o host do manifesto de
`HIVEMIND_ENDPOINT` (`_host="${HIVEMIND_ENDPOINT%%:*}"`) e busca
`https://${_host}/hivemind/LATEST_SHA` — ou seja, para ESSE cliente o manifesto tem que
existir em `https://kernel.silken.ia.br/hivemind/LATEST_SHA`, servido pelo **edge do lab**
(`edge-caddy`, repo `silken-ops`), não pelo host de produto. Medido: essa rota hoje NÃO
conflita com nada existente no lab (`kernel.silken.ia.br` só tem o `reverse_proxy
engram:3000` — sem catch-all concorrente na mesma posição, sem `/hivemind/*` já em uso).

## (e) Usuário SSH restrito + forced-command no edge do lab

Mesmo padrão do § (a), aplicado ao HOST do lab que roda o container `edge-caddy`
(repo `silken-ops/edge/`, NÃO o `hivemind-runtime`):

```bash
useradd --create-home --shell /bin/bash hivemind-publish-lab
mkdir -p /home/hivemind-publish-lab/.ssh
chmod 700 /home/hivemind-publish-lab/.ssh
```

Script receptor — **path sugerido** `/srv/hivemind-lab/bin/receive-latest-sha.sh` (nome
diferente do path de produto, `/srv/hivemind/...`, para não colidir se algum dia o mesmo
host acumular os dois papéis — hoje são hosts distintos, mas o path já nasce sem ambiguidade):

```bash
#!/bin/bash
# /srv/hivemind-lab/bin/receive-latest-sha.sh
# Forced-command receptor do job publish-lab (publish-latest-sha.yml, hivemind-runtime).
# Idêntico em lógica ao receptor de produto (§ a.2) — só o path do manifesto muda.
set -euo pipefail

MANIFEST_DIR="/srv/hivemind-lab/manifest"
MANIFEST_FILE="${MANIFEST_DIR}/LATEST_SHA"

mkdir -p "${MANIFEST_DIR}"

sha="$(cat -)"
sha="$(printf '%s' "${sha}" | tr -d '[:space:]')"

if ! printf '%s' "${sha}" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "reject: not a 40-char hex sha" >&2
  exit 1
fi

tmp="$(mktemp "${MANIFEST_DIR}/.LATEST_SHA.XXXXXX")"
printf '%s' "${sha}" > "${tmp}"
mv -f "${tmp}" "${MANIFEST_FILE}"
echo "ok: wrote ${sha}"
```

```bash
# Setup completo sob /srv (RELOCATE — mesmo padrão do § a.2 no lado produto).
mkdir -p /srv/hivemind-lab/{manifest,bin}
chown -R hivemind-publish-lab:hivemind-publish-lab /srv/hivemind-lab
chmod +x /srv/hivemind-lab/bin/receive-latest-sha.sh
```

`authorized_keys` (chave DEDICADA, diferente da de produto):

```bash
ssh-keygen -t ed25519 -C "hivemind-runtime-publish-latest-sha-lab" -f ./hivemind_publish_lab_key -N ""
```

```
command="/srv/hivemind-lab/bin/receive-latest-sha.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,no-user-rc ssh-ed25519 AAAA...SUBSTITUA... hivemind-runtime-publish-latest-sha-lab
```

```bash
chmod 600 /home/hivemind-publish-lab/.ssh/authorized_keys
chown -R hivemind-publish-lab:hivemind-publish-lab /home/hivemind-publish-lab/.ssh
```

Mesma garantia de blast-radius do § (a): vazamento da chave = escreve um SHA válido no
manifesto do lab, nada além disso.

## (f) Os 3 GH secrets de LAB no repo `hivemind-runtime`

```bash
gh secret set LAB_MANIFEST_SSH_HOST --repo <org>/hivemind-runtime   # IP/hostname do edge do lab
gh secret set LAB_MANIFEST_SSH_USER --repo <org>/hivemind-runtime   # hivemind-publish-lab
gh secret set LAB_MANIFEST_SSH_KEY  --repo <org>/hivemind-runtime < ./hivemind_publish_lab_key
```

O job `publish-lab` referencia `environment: lab` — GH Actions cria automaticamente ao
primeiro uso (mesmo comportamento do `environment: production` em § b). Confirmar que não há
required reviewers ali por engano (bloquearia o auto-publish sem curadoria).

## (g) Caddyfile do lab + volume do manifesto — JÁ AUTORADO, não aplicado

**`silken-ops/edge/Caddyfile` já foi editado no working tree** deste builder (repo
`/home/desktop/projetos/silken-ops`, arquivo `edge/Caddyfile`) — **não commitado, não
pushado**. Duas mudanças, ambas com comentário inline explicando o motivo:

1. Bloco `kernel.silken.ia.br` — o `reverse_proxy engram:3000` foi envolvido num `handle {}`
   e um `handle_path /hivemind/* { root * /etc/caddy/manifest \n file_server }` foi
   adicionado ANTES dele (Caddy casa mais-específico-antes-do-genérico). `handle_path` (não
   `handle`) strippa o prefixo `/hivemind/` antes de servir — consistente com o formato
   usado no manifesto de produto (§ c.1, também migrado para `handle_path` na revisão final).
2. O bloco stale `hivemind.silken.ia.br { root * /srv/placeholder/silken-site/hivemind \n
   file_server }` foi REMOVIDO (era um placeholder inerte, nunca populado, e o host
   `hivemind.silken.ia.br` vivo aponta para PRODUTO — mantê-lo no lab seria um segundo
   caminho morto/confuso). Substituído por um comentário explicando a remoção.

**Volume do manifesto no compose do edge do lab — PATCH SUGERIDO, NÃO aplicado neste
working tree** (medido diretamente em `silken-ops/edge/docker-compose.yml`, então isto é
uma leitura real do arquivo, não uma suposição — mas a MUDANÇA em si não foi escrita no
arquivo, só documentada aqui, porque o escopo desta rodada listou apenas o `Caddyfile` para
edição):

```diff
   volumes:
     - ./Caddyfile:/etc/caddy/Caddyfile:ro
     - ./placeholder:/srv/placeholder:ro
+    - /srv/hivemind-lab/manifest:/etc/caddy/manifest:ro   # absoluto — casa com o MANIFEST_DIR do receptor (§ e)
     - caddy_data:/data       # ACME account + certs (CRITICAL to persist)
     - caddy_config:/config
```

**FIX aplicado (revisão pós-defeito, 2026-07-14):** o mount é **absoluto**
(`/srv/hivemind-lab/manifest`), não relativo (`./manifest`). O `MANIFEST_DIR` do script
receptor (§ e, `/srv/hivemind-lab/manifest`) e o `source` do mount do compose DEVEM ser o
MESMO path absoluto no host — não versionar no checkout do `silken-ops` (o conteúdo muda a
cada push, e um mount relativo ao dir do checkout nunca bateria com o que o receptor grava
fora dele; um `./manifest` relativo montaria um diretório vazio no host, o Caddy serviria
404 sempre, e o cliente do lab recusaria o update — exatamente o mesmo padrão que o produto
já acerta com `/srv/hivemind/manifest` nos dois lados, ver § a.2 + § c.2).

**Ressalva honesta (medida, não flagada por ignorância):** eu LI o
`silken-ops/edge/docker-compose.yml` real deste repo — o mount acima é preciso quanto à
sintaxe e ao path (`/etc/caddy/manifest`, mesmo padrão do produto). O que eu NÃO verifiquei:
(i) se o container `edge-caddy` já está rodando com uma versão do compose que diverge do
que está no repo (o próprio arquivo tem um comentário histórico avisando que isso já
aconteceu uma vez — "NEVER recreate manually off a stale compose"); (ii) se
`docker compose up -d edge` vai RECRIAR o container (necessário para pegar o volume novo) ou
só fazer reload — recriar em produção do lab tem o mesmo risco de janela de indisponibilidade
que qualquer redeploy do edge. O founder deve confirmar o estado AO VIVO do container antes
de aplicar, exatamente como a ressalva já registrada para o produto (§ c.3).

### Aplicar (mesma disciplina do produto — validar antes de reload)

```bash
# No host do lab, após aplicar o patch acima no compose + Caddyfile:
docker exec edge-caddy caddy validate --config /etc/caddy/Caddyfile
# Só se validate passar:
docker compose -f edge/docker-compose.yml up -d edge   # ou o nome real do serviço/arquivo no host
# Confirmar rotas já verdes continuam verdes:
curl -sf https://kernel.silken.ia.br/healthz    # se existir; senão, checar um endpoint real do engram
curl -sf https://cerebro.silken.ia.br/          # smoke de outro host no mesmo edge, não deve regredir
```

## (h) Semear o `LATEST_SHA` do lab uma vez

Mesmo motivo do § (d) — sem seed, `curl .../LATEST_SHA` no lab fica vazio/404 até o primeiro
push em `main` disparar o job `publish-lab`:

```bash
mkdir -p /srv/hivemind-lab/manifest   # ou o path real escolhido no host do lab
git -C <checkout-local-do-hivemind-runtime> rev-parse HEAD | tr -d '\n' > /srv/hivemind-lab/manifest/LATEST_SHA
xxd /srv/hivemind-lab/manifest/LATEST_SHA | tail -3   # confirmar sem newline final
chown hivemind-publish-lab:hivemind-publish-lab /srv/hivemind-lab/manifest/LATEST_SHA
```

Validar ponta-a-ponta:

```bash
curl -sf https://kernel.silken.ia.br/hivemind/LATEST_SHA
# deve devolver o sha atual de main, 40 hex chars, sem newline — e deve BATER
# com o valor de https://hivemind.silken.ia.br/hivemind/LATEST_SHA (produto),
# já que o mesmo workflow publica o mesmo sha nos dois.
```

---

## Débito explícito registrado (não bloqueia B, mas deve ser rastreado)

- **Sem canal de alerta externo:** `publish-latest-sha.yml` (B3) fica vermelho no GitHub e
  gera step-summary em caso de falha, mas nenhum Slack/Discord/PagerDuty está integrado —
  ninguém recebe um ping ativo se a falha acontecer fora do horário em que alguém olha o
  repo. Se isso importar, é trabalho adicional fora do escopo desta autoria (precisaria de
  um secret de webhook, não fornecido).
- **Ordem dos blocos Caddy** (c.1) é crítico e MANUAL — nenhum teste automatizado neste
  repo valida a ordem; `caddy validate` (c.3) pega erro de sintaxe, mas NÃO pega "bloco na
  ordem errada" (isso é lógica de roteamento, não sintaxe). Revisão humana obrigatória antes
  do reload.
- **`hivemind_publish_key` local** (§ a.3): apagar do disco do operador após colar no GH
  secret — não deixar em `~/Downloads` ou histórico de shell sem limpar. Mesma disciplina
  para `hivemind_publish_lab_key` (§ e).
- **Volume do compose do lab NÃO foi escrito no arquivo real** (§ g) — só documentado como
  patch sugerido neste runbook, mesmo eu tendo lido o `docker-compose.yml` real (não é uma
  suposição sobre a sintaxe, mas a edição em si ficou de fora do escopo autorizado desta
  rodada). Se o founder quiser o patch já escrito no working tree (como o Caddyfile), é um
  pedido de escopo adicional, não uma correção de erro.
- **Recriação do container `edge-caddy` no lab** (§ g, "Aplicar"): `docker compose up -d`
  pode recriar o container para pegar o volume novo — mesma janela de risco de qualquer
  redeploy do edge do lab (o próprio `docker-compose.yml` do lab documenta um incidente
  anterior de recreate com compose desatualizado derrubando TODOS os vhosts, não só
  `kernel.silken.ia.br`). Confirmar o estado ao vivo do container antes de aplicar — não
  presumir que o repo bate com o que está rodando.
- **6 chaves SSH, zero reuso** — confirmar na hora de gerar que nenhuma das
  `PROD_MANIFEST_SSH_KEY` / `LAB_MANIFEST_SSH_KEY` / `GHA_VPS_SSH_KEY` (lab, deploy do
  backend) / `PROD_GHA_VPS_SSH_KEY` (produto, deploy do backend, ver plano § A6) é a mesma
  chave colada duas vezes por atalho operacional — cada uma tem um blast-radius desenhado
  para o seu próprio escopo, misturar reduz a garantia de todas.
