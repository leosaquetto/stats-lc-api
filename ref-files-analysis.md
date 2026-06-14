# Análise técnica de `/ref-files` (stats.fm)

## Resumo executivo

- Os arquivos em `/ref-files` são **chunks JavaScript minificados do frontend** (Next.js), não dumps puros de payload JSON.
- Mesmo assim, há sinais claros dos objetos retornados pela API consumida no frontend (ex.: `track.durationMs`, `track.externalIds.spotify`, `track.externalIds.appleMusic`, `stream.endTime`, `stream.playedMs`, `users.trackStreams(...)`, etc.).
- O campo mais forte observado para identificar **catálogo/disponibilidade por serviço** é `externalIds` (com arrays para Spotify e Apple Music), mas isso **não identifica sozinho** a plataforma real de reprodução.
- O melhor sinal de plataforma do usuário encontrado neste conjunto é o uso/estado de **`OrderBySetting.PLATFORM`** + enums `Platform.SPOTIFY` / `Platform.APPLEMUSIC` + recursos de `hasImported`, porém isso aponta preferência/configuração/integração, não necessariamente origem exata de cada stream.
- Há evidências de duração (`durationMs`) e de progresso agregado por stream (`playedMs`), mas **não foram encontrados** campos explícitos de progresso em tempo real (`progressMs`, `position` temporal, `elapsed`, `playback`) no sentido de player ativo.

---

## 1) Arquivos lidos e classificação

| Arquivo | Tipo principal identificado | Justificativa técnica curta |
|---|---|---|
| `ref-files/%5Bid%5D-56c03c362b1b719f.js` | entity stats (track) + recent streams | Página de track, uso de `track`, `users.trackStreams`, `externalIds`, `durationMs`, `playedMs`. |
| `ref-files/%5Bid%5D-72fec3c6d9e39244.js` | entity stats (artist) + recent streams | Página de artist, uso de `users.artistStreams`, `artistStats`, `externalIds`, `durationMs`. |
| `ref-files/%5Bid%5D-df35130b01625ec7.js` | entity stats (album) + recent streams | Página de album, uso de `users.albumStreams`, `externalIds`, `durationMs`, `playedMs`. |
| `ref-files/2440-60489c4455698d0d.js` | outro | Biblioteca de chart/renderização (eventos de canvas), sem payload útil de API musical. |
| `ref-files/3361-095525150afe65b1.js` | recent streams (componentes compartilhados) | Componentes de lista com `endTime`, `playedMs`, `track.durationMs`, `position`, `streams`. |
| `ref-files/3fff1979-c08aee61ed074320.js` | outro | Bundle de gráficos/utilitários; ocorrências de `platform/source` não ligadas a serviço musical. |
| `ref-files/5590-e936311d2db93da9.js` | outro | Biblioteca de interação/UI; ocorrências de `client` relacionadas a mouse/touch. |
| `ref-files/7201-25f94f07d539f7cf.js` | outro | Componentes de carousel/scope; sem campos de API de música relevantes. |
| `ref-files/_app-f125f048dd2bbaee.js` | user profile + connected services + imports | SDK/app shell com métodos `/me/imports/*`, `/me/service/*/settings`, enums `Platform.*`, `OrderBySetting.*`. |
| `ref-files/_buildManifest.js` | outro | Manifest de rotas; sem payload de domínio musical. |

---

## 2) Estruturas e campos úteis por arquivo (com exemplos reais)

> Observação: exemplos abaixo vêm de trechos literais dos chunks (nomes de propriedades e valores string/enum visíveis).

### A) `ref-files/%5Bid%5D-56c03c362b1b719f.js` (track)

- **Estrutura raiz inferida**: objeto `track` + arrays de `streams` + stats de usuário para track.
- **Campos principais**:
  - `track.id`, `track.name`, `track.durationMs`, `track.spotifyPopularity`
  - `track.externalIds.spotify[]`, `track.externalIds.appleMusic[]`
  - stream/lista: `endTime`, `playedMs`, `streams`, `position`, `trackId`, `trackName`
- **Campos aninhados importantes**:
  - `track.albums[0].image`
  - `track.artists[].id`, `track.artists[].name`
- **Exemplos reais de valores (literalmente visíveis)**:
  - `OrderBySetting.PLATFORM`
  - `externalIds.spotify[0]`, `externalIds.appleMusic[0]`
  - formato de duração: `duration(..., "milliseconds").format("m:ss")`

### B) `ref-files/%5Bid%5D-72fec3c6d9e39244.js` (artist)

- **Estrutura raiz inferida**: objeto `artist` + stats + streams por usuário.
- **Campos principais**:
  - `artist.id`, `artist.name`, `artist.externalIds.spotify[]`, `artist.externalIds.appleMusic[]`
  - estatísticas agregadas: `durationMs`, `count`
  - condições de importação: `user.isPlus`, `user.hasImported`, `user.orderBy`
- **Campos aninhados importantes**:
  - chamadas para `users.artistStreams(...)`, `users.artistStats(...)`
- **Exemplos reais**:
  - `OrderBySetting.PLATFORM`
  - links com `music.apple.com/.../artist/...` e `open.spotify.com/artist/...`

### C) `ref-files/%5Bid%5D-df35130b01625ec7.js` (album)

- **Estrutura raiz inferida**: objeto `album` + stats + streams.
- **Campos principais**:
  - `album.id`, `album.type`, `album.totalTracks`, `album.spotifyPopularity`
  - `album.externalIds.spotify[]`, `album.externalIds.appleMusic[]`
  - stream/lista: `playedMs`, `position`, `streams`
  - stats: `durationMs`, `count`
- **Campos aninhados importantes**:
  - gating por `hasImported` para rota de streams do álbum
- **Exemplos reais**:
  - `label:"type of album"`
  - `durationMs` convertido para minutos

### D) `ref-files/3361-095525150afe65b1.js` (componentes de recent streams)

- **Estrutura raiz inferida**: lista de streams recebida por props `streams`.
- **Campos principais**:
  - `endTime`
  - `playedMs`
  - `position` (ranking/ordem exibida)
  - `track.durationMs`
- **Campos aninhados importantes**:
  - fallback: quando não há stream, usa `track.durationMs` para exibir duração.
- **Exemplos reais**:
  - texto UI: `Looks like you don't have any recent streams`
  - concatenação de metadados: `minutes • streams`

### E) `ref-files/_app-f125f048dd2bbaee.js` (app shell / SDK)

- **Estrutura raiz inferida**: cliente API + enums + métodos de conexão/import.
- **Campos principais**:
  - métodos: `setConnectedServiceSettings`, `spotifyPlaylists`, endpoints `/me/imports/*`, `/me/service/*/settings`
  - enums: `Platform.SPOTIFY`, `Platform.APPLEMUSIC`
  - enums: `OrderBySetting.PLATFORM`, `OrderBySetting.SPOTIFY`, `OrderBySetting.APPLEMUSIC`
- **Campos aninhados importantes**:
  - estados de usuário: `isPlus`, `hasImported`, `orderBy`
- **Exemplos reais**:
  - string endpoint: ``/me/service/${e}/settings``
  - enum literal: `SPOTIFY`, `APPLEMUSIC`

### F) Demais arquivos (`2440`, `3fff`, `5590`, `7201`, `_buildManifest`)

- Classificados como **outro**: infraestrutura de UI, gráficos, manifesto de rotas.
- Ocorrências como `platform`, `source`, `client`, `provider` nesses arquivos não indicam plataforma musical do usuário.

---

## 3) Busca específica de campos relacionados a plataforma/origem

### Ocorrências encontradas (úteis)

| Campo (ou família) | Arquivo(s) | Caminho/cenário exato | Valor real observado | Indica plataforma do usuário? | Indica catálogo da faixa? | Indica origem real da reprodução? |
|---|---|---|---|---|---|---|
| `externalIds.spotify[]` | `%5Bid%5D-56...`, `%5Bid%5D-72...`, `%5Bid%5D-df...` | `track/artist/album.externalIds.spotify[0]` | IDs usados em links `open.spotify.com/...` | Parcial/indireto | **Sim** | Não confiável |
| `externalIds.appleMusic[]` | mesmos acima | `track/artist/album.externalIds.appleMusic[0]` | IDs usados em links `music.apple.com/...` | Parcial/indireto | **Sim** | Não confiável |
| `Platform.SPOTIFY|APPLEMUSIC` | `_app-...` | enum de plataforma no SDK | `SPOTIFY`, `APPLEMUSIC` | **Potencial** (modelo de domínio) | Não | Não por si só |
| `OrderBySetting.PLATFORM` | `_app-...` e páginas entity | configuração/ordenação de usuário | `PLATFORM` | **Potencial** (preferência/visão) | Não | Não por si só |
| `hasImported` + `/me/imports/*` | `_app-...` e páginas entity | estado/rotas de importação | `hasImported` | Potencial (há integração) | Não | Não por si só |
| `/me/service/${e}/settings` | `_app-...` | configuração de serviço conectado | endpoint literal | **Potencial forte** (serviço conectado) | Não | Ainda indireto |

### Ocorrências encontradas (não úteis para objetivo)

- `platform` em `2440`/`3fff`: contexto de renderização de gráficos/canvas.
- `source` em `_buildManifest` e `3fff`: rotas/escala de gráfico, não origem de stream.
- `client`, `provider` em UI/carousel/bibliotecas.

---

## 4) Separação pedida

### 4.1 Campos que indicam apenas catálogo/disponibilidade da música

- `externalIds.spotify[]`
- `externalIds.appleMusic[]`
- URLs derivadas para `open.spotify.com` / `music.apple.com`

**Motivo**: sinalizam que a entidade existe no catálogo daquela plataforma, não quem tocou via qual app.

### 4.2 Campos que podem indicar plataforma usada pelo usuário (nível conta/config)

- `Platform.SPOTIFY`, `Platform.APPLEMUSIC` (enum de domínio)
- `OrderBySetting.PLATFORM` (preferência de ordenação por plataforma)
- `setConnectedServiceSettings(...)` + endpoint `/me/service/{service}/settings`
- `hasImported` + endpoints de import

**Motivo**: apontam conexão/configuração/import do usuário; podem inferir contexto da conta.

### 4.3 Campos que podem indicar origem real da reprodução recente

- Neste conjunto, **não apareceu campo explícito e inequívoco por stream** como `stream.platform`, `stream.service`, `stream.source`.
- O que existe diretamente por stream: `endTime`, `playedMs`, `streams`, `track`.

**Conclusão parcial**: origem real por reprodução ainda não está claramente exposta nestes chunks.

---

## 5) Diferenciar Apple Music vs Spotify com confiabilidade

### Achado

- **Confiável para catálogo**: sim (`externalIds.spotify` vs `externalIds.appleMusic`).
- **Confiável para plataforma real de reprodução por stream**: **não comprovado** nos arquivos analisados.

### Nível de confiança

- Catálogo: alto.
- Conta/conexão: médio (depende de endpoints `/me/service/*` não inspecionados como payload real aqui).
- Origem de cada stream: baixo (falta campo explícito no stream exibido).

---

## 6) Duração e progresso

### Duração

- Encontrado:
  - `durationMs`
  - `track.durationMs`
- Não encontrado:
  - `duration_ms`
  - `duration` (como campo principal de API; só como método de biblioteca para formatar tempo)

### Progresso real

- Encontrado:
  - `playedMs` (tempo tocado/agregado por stream/lista)
- Não encontrado explicitamente:
  - `progressMs`
  - `progress`
  - `position` como progresso temporal (o `position` observado é ranking/ordem)
  - `elapsed`
  - `playback`

---

## 7) Candidatos de campo para decisão de plataforma

| Candidato | Escopo | Força | Risco |
|---|---|---|---|
| `stream.platform` / `stream.service` (se existir em endpoint real) | por reprodução | Muito alta | **Não apareceu** nos chunks; precisa validar payload bruto. |
| `connection/service settings` (`/me/service/*`) | por usuário | Alta | Pode refletir conta conectada, não stream específico. |
| `hasImported` | por usuário | Média | Só indica importação habilitada/histórica. |
| `externalIds.*` | por entidade | Baixa para origem de stream | Confunde catálogo com origem real do play. |

---

## 8) Fallback recomendado (sem alterar endpoints por enquanto)

1. **Prioridade 1**: ao integrar backend, buscar campo explícito de origem no payload de streams (se existir no endpoint real).
2. **Prioridade 2**: se não existir, usar metadados de conexão do usuário (`/me/service/*`, imports) apenas como **heurística de conta**, não de stream.
3. **Último fallback**: `externalIds` somente para identificar disponibilidade da faixa/entidade em cada plataforma.

---

## 9) Campos para normalização no backend (proposta)

- `catalog.spotifyId` <- `externalIds.spotify[0]`
- `catalog.appleMusicId` <- `externalIds.appleMusic[0]`
- `track.durationMs`
- `stream.playedMs`
- `stream.endTime`
- `user.integration.hasImported`
- `user.integration.connectedServices[]` (quando disponível em endpoint real)
- `stream.sourcePlatform` (**somente se endpoint real trouxer campo explícito**)

---

## 10) Riscos e limitações

- Fonte analisada é bundle minificado, não resposta JSON bruta de API.
- Nomes de campos inferidos a partir de consumo em UI podem omitir partes do payload real.
- Possível existência de campo de origem real em endpoints não incluídos em `/ref-files`.
- `externalIds` pode induzir falso positivo de plataforma usada.

---

## Conclusão objetiva (qual campo usar)

- **Para plataforma real de reprodução (Apple vs Spotify), neste material não há campo explícito comprovado por stream.**
- **Não usar URL de imagem como sinal de plataforma.**
- **Usar `externalIds` apenas para catálogo/disponibilidade.**
- **Próxima etapa técnica (quando liberar mudança de endpoint): validar payload bruto de endpoints de streams e de serviços conectados para encontrar campo explícito de origem por reprodução.**
