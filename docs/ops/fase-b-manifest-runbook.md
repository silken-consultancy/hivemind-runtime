# Fase B — manifesto `LATEST_SHA` (canal de auto-update sem GPG)

Estado real, medido em 2026-08-08 contra `main @ 97a830d` — este documento
descreve o que **já está em produção**, não um plano futuro. O header do
workflow (`.github/workflows/publish-latest-sha.yml`) referenciava este
arquivo antes dele existir; esta é a correção desse link pendurado.

## O que é

`bin/hivemind` (`_verify_commit_integrity`, linhas ~786-809) confia num
commit de duas formas, qualquer uma bastando: (a) assinatura GPG válida via
`git verify-commit`, ou (b) o hash do commit local bate com um manifesto
`LATEST_SHA` publicado num canal HTTPS separado do próprio git — o fallback
usado quando nenhum signer está configurado. O manifesto é lido em
`https://<host>/hivemind/LATEST_SHA`, onde `<host>` é o host (sem porta) de
`HIVEMIND_ENDPOINT`.

Se o fetch falhar ou o manifesto estiver vazio/desatualizado, a verificação
falha **fechada** para commits não assinados (`_maybe_auto_update` não
aplica a atualização) — esse é o comportamento correto, não um bug.

## Estado medido (2026-08-08) — CANAL FUNCIONANDO, não quebrado

Premissa anterior (histórica) descrevia este canal como pendente de
provisionamento. Medição direta neste ciclo mostra o oposto:

- `curl -sf https://hivemind.ia.br/hivemind/LATEST_SHA` → `97a830d71baa...`
  (== HEAD de `main` no momento da medição).
- `curl -sf https://kernel.silken.ia.br/hivemind/LATEST_SHA` → mesmo valor.
- Os 6 GitHub Secrets (ver § Secrets) existem desde 2026-07-14.
- `publish-latest-sha.yml` roda verde em ~18s a cada push em `main`
  (`publish-prod` + `publish-lab`, ambos obrigatórios — se qualquer um
  falhar o job fica vermelho, ver § Falha).

Não há trabalho de "provisionar receptor" ou "criar secrets" pendente —
já está feito e em operação. O único gap real era este runbook não existir
(o link do header do workflow apontava para um arquivo inexistente) e a
ausência de um passo de verificação pós-publish com leitura real de volta
(ver § Verify step, adicionado neste ciclo).

## Arquitetura — dual-target

Um único push em `main` publica o MESMO sha em dois destinos independentes,
cada um servindo um HIVEMIND_ENDPOINT diferente:

| Alvo    | Host                     | Quem lê                                              |
|---------|--------------------------|-------------------------------------------------------|
| PRODUTO | `hivemind.ia.br`         | clientes de produto (`HIVEMIND_ENDPOINT` default)     |
| LAB     | `kernel.silken.ia.br`    | cliente de dogfood do lab (`HIVEMIND_ENDPOINT=kernel.silken.ia.br:4443`) |

Os dois jobs (`publish-prod`, `publish-lab`) rodam em paralelo após
`validate-sha` (valida que `github.sha` é 40 hex chars) e são
**ambos obrigatórios**: uma falha em qualquer um deixa aquele lado do
manifesto STALE — clientes daquele lado, sem GPG configurado, passam a
falhar-fechado e param de receber updates silenciosamente (do lado do
cliente; o workflow torna a falha barulhenta do lado do publisher via
`::error::` + job vermelho + `GITHUB_STEP_SUMMARY`).

## Transporte — SSH forced-command, sha por stdin

Cada job faz SSH para o host alvo com uma chave ED25519 dedicada e escreve o
sha via **stdin** (não como argumento de comando):

```
printf '%s' "${trimmed_sha}" | ssh -i "${key_file}" \
  -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes \
  "${SSH_USER}@${SSH_HOST}"
```

Motivo (do próprio header do workflow): com um usuário SSH configurado com
**forced-command** (`command="..."` em `authorized_keys`), o argumento de
comando do cliente SSH é ignorado pelo host — só chega como
`SSH_ORIGINAL_COMMAND`, que o script forçado no host nem precisa olhar.
Passar o dado por stdin evita qualquer questão de quoting/injeção do lado
cliente, e o receptor no host valida o formato (40 caracteres hex) antes de
escrever o arquivo do manifesto — defesa em profundidade mesmo com a chave
já escopada a um usuário restrito, não-root.

Cada host tem seu próprio usuário SSH restrito + par de chaves — nenhuma das
6 chaves é reusada entre si nem com a chave de deploy do backend
(`GHA_VPS_SSH_KEY` / `PROD_GHA_VPS_SSH_KEY`). Blast-radius de um vazamento
de qualquer uma das chaves de manifesto: escrever o arquivo `LATEST_SHA`
daquele host via o forced-command, nada além disso (sem shell, sem acesso a
outros arquivos).

**Nota de escopo:** os scripts receptores (o forced-command em si, do lado
do host) vivem na configuração dos dois VPS, fora deste repositório — este
runbook documenta o contrato (formato esperado via stdin, validação de 40
hex chars) do lado do publisher (o que este repo controla e testa), não o
conteúdo exato do script remoto.

## Secrets (GitHub Actions), existentes desde 2026-07-14

| Secret                    | Ambiente     | Uso                                  |
|----------------------------|--------------|---------------------------------------|
| `PROD_MANIFEST_SSH_HOST`   | `production` | host/IP do host de produto            |
| `PROD_MANIFEST_SSH_USER`   | `production` | usuário SSH restrito (forced-command) |
| `PROD_MANIFEST_SSH_KEY`    | `production` | chave privada ED25519 dedicada        |
| `LAB_MANIFEST_SSH_HOST`    | `lab`        | host/IP do edge do lab                |
| `LAB_MANIFEST_SSH_USER`    | `lab`        | usuário SSH restrito (forced-command) |
| `LAB_MANIFEST_SSH_KEY`     | `lab`        | chave privada ED25519 dedicada        |

## Verify step (adicionado neste ciclo)

O workflow já tinha retry 3x por job para absorver a flakiness transitória
medida no hop SSH:22 GHA→VPS, mas confiava só no exit code do `ssh` como
prova de sucesso. Cada job (`publish-prod`, `publish-lab`) agora tem um passo
adicional **depois** do push SSH bem-sucedido: um `curl` de volta no
endpoint público do manifesto, comparando o conteúdo lido com `github.sha`.
Isso fecha o loop com uma leitura real em vez de confiar cegamente no `ssh`
ter retornado 0 (que não garante que o receptor escreveu o arquivo
corretamente). Falha do verify-step também deixa o job vermelho com
`::error::`.

## Débito explícito — aceito, não construído

Não há canal de alerta fora do GitHub (Slack/Discord/PagerDuty) — nenhum
secret de webhook foi fornecido a este builder. A única sinalização de
falha hoje é: job vermelho no Actions + `::error::` annotation +
`GITHUB_STEP_SUMMARY` + notificação padrão do GitHub para quem tem "watch"
no repositório. Ficando fora deste ciclo por decisão explícita (item B1 do
board) — não um esquecimento.

## Troubleshooting rápido

- **Job vermelho em `publish-prod` ou `publish-lab`:** olhar o
  `GITHUB_STEP_SUMMARY` do run — ele já diz qual lado (produto/lab) ficou
  stale. Re-rodar o workflow (ou fazer um novo push trivial em `main`)
  resolve na maioria dos casos, dado que a causa medida é flakiness
  transitória do hop SSH:22.
- **Verificar manualmente se um host está servindo o sha certo:**
  `curl -sf https://<host>/hivemind/LATEST_SHA` e comparar com
  `git rev-parse HEAD` de `main`.
- **Um cliente parou de receber updates silenciosamente:** provavelmente o
  manifesto do host que aquele cliente usa (`HIVEMIND_ENDPOINT`) ficou stale
  por um job vermelho não notado (ver débito de alerta acima) — checar o
  Actions do repo.
