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
- `lib/statsfm.ts`: unica entrada upstream, cache, stale, dedupe, cooldown,
  timeout e retry.
- `lib/user-stats-service.ts`: stats e intervalos temporais.
- `lib/user-streams-service.ts`: recentes e historicos.
- `lib/user-tops-service.ts`: tops normalizados.
- `lib/track-album-enrichment.ts`: resolucao de album por evidencia do
  historico do usuario.
- `lib/users.ts`: fonte real dos membros do grupo.

## Regras De Evolucao

- Manter payloads publicos retrocompativeis.
- `/api/group-live?profile=0` e a superficie leve de polling.
- `/api/group` e dados frios podem usar cache/stale de minutos.
- `force=1` fica restrito a acoes manuais claras.
- Nao adicionar Redis/KV, persistencia pesada ou `/api/home-bundle` sem pedido
  explicito.
- Nao inferir origem de playback apenas por `externalIds`.
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
- `/api/group`: cache CDN de 180 s e stale-while-revalidate de 900 s.
- cache upstream frio: 3 min fresh e 15 min stale.
- `/api/top`: faixas upstream vazias retornam `200`, lista vazia e warning.
- headers de diagnostico: `X-Request-Id`, `Server-Timing` e `X-App-Timing`.

Snapshots de producao ficam em
[`docs/api-contract.md`](./docs/api-contract.md). Eles ajudam a detectar
regressao, mas nao sao SLOs.

## Documentos

- [`docs/api-contract.md`](./docs/api-contract.md): contrato publico,
  resiliencia, cache, endpoints e checkpoint de performance.
- [`docs/track-album-resolution.md`](./docs/track-album-resolution.md): regra
  obrigatoria para album real em payloads de faixa.
