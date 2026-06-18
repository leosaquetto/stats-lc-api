# stats-lc-api

Backend do stats.lc, publicado em `https://statslc.leosaquetto.com`.

O frontend consumidor vive em `../stats-lc` e e publicado em
`https://appstatslc.leosaquetto.com`.

## Validar

```bash
npm run check
git diff --check
```

`npm run check` executa typecheck e testes. Nao use um `npx tsc --noEmit`
avulso como substituto do comando suportado pelo repo.

## Arquitetura

- `api/[...path].ts`: dispatcher central, CORS, request ID, timing e logs.
- `lib/api-handlers/`: contratos HTTP por rota.
- `lib/api-handlers/catalog-link-bridge.ts`: bridge interno e protegido para
  produtos confiaveis enriquecerem links Spotify/Apple Music a partir do
  catalogo stats.fm.
- `lib/statsfm.ts`: unica entrada upstream, cache, stale, dedupe, cooldown,
  timeout e retry.
- `lib/user-stats-service.ts`: stats e intervalos temporais.
- `lib/user-streams-service.ts`: recentes e historicos.
- `lib/history-backup.ts`, `lib/history-store.ts` e `lib/history-local.ts`:
  manutencao semanal adaptativa do historico em Postgres/Neon, inclusive mes
  atual aberto e ausencias longas, com leitura local para ranges completos.
- `lib/user-tops-service.ts`: tops normalizados.
- `lib/track-album-enrichment.ts`: resolucao de album por evidencia do
  historico do usuario.
- `lib/users.ts`: fonte real dos membros do grupo.

## Regras De Evolucao

- Manter payloads publicos retrocompativeis.
- `/api/group-live?profile=0` e a superficie leve de polling.
- `/api/live-probe?user=<usuario>` e a superficie `pulse` minima para detectar
  uma nova faixa do usuario destacado sem consultar o grupo inteiro.
- `/api/group-activity` preenche a Atividade do Circulo com a ultima linha do
  historico completo de cada membro, com cache curto e sem competir com o
  polling live.
- `/api/group-live?statsUser=<usuario>` pode acrescentar `featuredStats` sem
  alterar chamadas antigas.
- `/api/latest-discovery?user=<usuario>` so devolve uma descoberta quando a
  cobertura permite provar a primeira reproducao.
- `/api/group` e dados frios podem usar cache/stale de minutos.
- `force=1` fica restrito a acoes manuais claras.
- Nao adicionar Redis/KV, persistencia pesada ou `/api/home-bundle` sem pedido
  explicito.
- Nao inferir origem de playback apenas por `externalIds`.
- `/api/catalog-link-bridge` pode usar `externalIds.spotify` e
  `externalIds.appleMusic` apenas para enriquecimento de catalogo/link, e deve
  ser protegido por `CATALOG_LINK_BRIDGE_TOKEN` em producao.
- Cor dominante e enriquecimentos opcionais nao devem bloquear live/Home.
- Respostas parciais devem preservar o shape publico e expor warnings
  especificos.
- Logs estruturados nao devem conter PII, tokens, cookies ou payload completo.

## Performance Atual

Rollup publicado em 2026-06-09:

- `33abac4`: caminhos live/frios, deadline e cache.
- `f34ed76` e `cfcb20d`: timing headers compativeis com Vercel.
- `1f4c2cf`: cobertura do fallback de deadline live.

Comportamento atual:

- `/api/group-live`: deadline de 1,9 s, timeout curto por usuario e resposta
  parcial segura.
- `/api/live-probe`: cache upstream `pulse` de 5 s fresh e ate 45 s stale
  somente como fallback de falha.
- `/api/group`: cache CDN de 180 s e stale-while-revalidate de 900 s.
- cache upstream frio: 3 min fresh e 15 min stale.
- `/api/top`: faixas upstream vazias retornam `200`, lista vazia e warning.
- headers de diagnostico: `X-Request-Id`, `Server-Timing` e `X-App-Timing`.
- Web Push de Orbits usa `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e, quando
  definido, `VAPID_SUBJECT`; subscriptions e entregas idempotentes usam o
  Postgres/Neon existente.

Snapshots de producao ficam em
[`docs/api-contract.md`](./docs/api-contract.md). Eles ajudam a detectar
regressao, mas nao sao SLOs.

## Documentos

- [`docs/api-contract.md`](./docs/api-contract.md): contrato publico,
  resiliencia, cache, endpoints e checkpoint de performance.
- [`docs/history-backup.md`](./docs/history-backup.md): manutencao semanal
  adaptativa, estados de cobertura, comandos e workflow.
- [`docs/track-album-resolution.md`](./docs/track-album-resolution.md): regra
  obrigatoria para album real em payloads de faixa.
