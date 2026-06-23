# TAMS Gateway, gap analysis against BBC TAMS 8.1

- **Date:** 2026-06-23
- **Gateway revision analysed:** `650eb4c` (main)
- **Specification:** vendored BBC TAMS **8.1** (`spec/`, commit `bfefbbcdfea9bcd8ee532281c60564bb57842619`)
- **Method:** read of the registered routes (`src/api/api.ts`), the interop baseline
  (`spec/interop-baseline.json`), the segment/storage/HLS handlers, and the vendored
  OpenAPI document. No claim here depends on memory; each is grounded in the source
  referenced inline.

## 1. Summary

The gateway is, by design, a narrow high-value subset of a TAMS server: **segment
ingest, indexing, and playback** (presigned S3 URLs plus on-the-fly HLS). Within
that subset the implementation is solid: clean handlers, unit tests beside each
endpoint, and a conformance harness that runs Schemathesis against a _subset_ of
the real BBC spec so it validates real responses without flagging the
intentionally unimplemented endpoints.

Measured on operation surface it covers roughly **9 of ~53 non-HEAD operations
(~17%)**, but that figure understates it: the 9 are exactly the chain that makes a
flow recordable and playable. The HLS output is a non-spec extension and is
**structurally correct** for self-contained muxed MPEG-TS, with real limitations
(no multivariant / separate audio+video flows, a TAI/UTC skew on
`PROGRAM-DATE-TIME`).

The gap is the **feature surface**, not code quality or conformance tooling.

## 2. Implemented surface

Verified against `src/api/api.ts` and `spec/interop-baseline.json`.

| Operation                     | Notes                                                        |
| ----------------------------- | ------------------------------------------------------------ |
| `GET /`                       | Service root paths; redirects a browser to `/ui`.            |
| `GET /flows`                  | List flows.                                                  |
| `GET /flows/{id}`             | Get a flow.                                                  |
| `PUT /flows/{id}`             | Create/update a flow, and auto-creates its source.           |
| `DELETE /flows/{id}`          | Delete a flow and its segments.                              |
| `GET /sources`                | List sources only.                                           |
| `POST /flows/{id}/storage`    | Allocate objects, return presigned PUT URLs.                 |
| `POST /flows/{id}/segments`   | Single or array, idempotent upsert, partial-failure 200/201. |
| `GET /flows/{id}/segments`    | `timerange` + `reverse_order` + `limit`.                     |
| `GET /flows/{id}/output.m3u8` | **Extension, not in TAMS spec** (HLS playlist).              |
| `/ui`, `/readiness`, `/docs`  | Inspector UI, readiness, Swagger UI.                         |

## 3. Missing surface (against TAMS 8.1)

Grouped by impact. Operation paths are from the vendored
`spec/TimeAddressableMediaStore.yaml`.

### Core capabilities absent

- **Webhooks / event notifications** (`/service/webhooks`, `/service/webhooks/{webhookId}`,
  full CRUD). A core TAMS feature: 8 notification types (flow and source
  created/updated/deleted, segments added/deleted). A consumer cannot currently
  subscribe to "new segments exist" and must poll.
- **`/flow-delete-requests`** (asynchronous deletion workflow) and
  **`DELETE /flows/{id}/segments`** (timerange-scoped segment deletion). Today
  deletion is whole-flow only, with no time-window deletion and no async job model.
- **Objects API** (`GET`/`HEAD /objects/{objectId}`, `POST`/`DELETE
/objects/{objectId}/instances`). No object introspection or multi-instance
  handling.

### Read/metadata surface absent

- **Source detail** (`GET /sources/{sourceId}` plus `tags`, `description`, `label`).
  Only listing exists; a single source cannot be fetched.
- **Flow property endpoints** (`tags`, `description`, `label`, `read_only`,
  `flow_collection`, `max_bit_rate`, `avg_bit_rate`, each with GET/PUT/DELETE).
  Properties can only be set via a whole-flow PUT, not mutated individually.
- **`GET`/`POST /service`** and **`GET /service/storage-backends`** (service
  descriptor and backend catalogue).
- **`HEAD` methods** throughout (the spec mirrors every GET with a HEAD).

### Conformance deviations within implemented endpoints

- **Paging on `GET /flows/{id}/segments`**: the spec requires a `Link` header,
  `X-Paging-*` headers, and a `page`/`key` cursor. The gateway returns a bare
  array with `limit` only, no paging headers, no cursor. This is the one
  conformance deviation inside an implemented endpoint (the rest are honestly
  omitted) and it bites on very large flows.
- `GET /flows/{id}/segments` omits the spec query params `object_id`, `presigned`,
  `accept_get_urls`, `accept_storage_ids`, `verbose_storage`,
  `include_object_timerange`, and the `get_urls` items omit `presigned`/`label`.
- The segment object omits `ts_offset`, `last_duration`, `key_frame_count`
  (a subset of the spec schema).

## 4. HLS output assessment

Core logic: `src/api/utils/hlsManifest.ts` (pure builder) plus
`src/api/endpoints/output/getHlsPlaylist.ts` (DB/S3/heuristics). Structurally
correct for a single-rendition muxed MPEG-TS.

### Correct

- Correct media playlist: `#EXTM3U`, `#EXT-X-VERSION:3`,
  `TARGETDURATION = ceil(max EXTINF)` (floor 1), `MEDIA-SEQUENCE`.
- BigInt nanosecond math throughout, so precision is never lost through a JS
  `Number`.
- `EXT-X-DISCONTINUITY` is emitted on a timeline gap
  (`segment.ts_start !== previous.ts_end`).
- VOD: `PLAYLIST-TYPE:VOD` + `ENDLIST`. Live: open playlist,
  `Cache-Control: no-store`.
- A DVR window for live (default 300s at the live edge) rather than the whole flow.
- The signing date is pinned to the current hour so a segment presigns to the same
  URL across reloads, which stops hls.js treating a live playlist as constantly
  changing and hammering the manifest.
- A `?timerange` request is always closed with `ENDLIST` even while the flow keeps
  producing, otherwise hls.js sits on an edge that never advances (gray screen).

### Real limitations / risks

1. **No multivariant (master) playlist, and no separate audio+video flows.** This is
   the largest limitation. TAMS typically models audio and video as separate flows
   under one source. The gateway can only play a self-contained muxed TS
   (H.264+AAC in one TS); anything else returns `415`. There is no bitrate ladder
   and no way to combine a video flow with an audio flow into one playable HLS
   presentation.
2. **`PROGRAM-DATE-TIME` carries a TAI vs UTC skew (~37s in 2026).** Accepted for
   "Phase 1" and documented in the code. The live wall-clock readout and any
   PDT-based seek are off by ~37s. Fine for relative scrub, wrong for exact
   wall-clock sync.
3. **`MEDIA-SEQUENCE` is derived from `ts_start / segment_duration unit`**, not as a
   count of removed segments. Monotonic and stable (all an HLS client requires), so
   functionally fine, but non-standard and dependent on `segment_duration` being
   sensible.
4. **No `EXT-X-DISCONTINUITY-SEQUENCE`.** When the live window slides and a
   discontinuity scrolls out of the window it is not tracked. Minor for the DVR
   case, formally a gap.
5. **VOD build loads up to `VOD_MAX_SEGMENTS` (50000) segments into memory and
   presigns each.** On very long flows the manifest build is heavy. The code already
   flags that a segment proxy would remove that cost (follow-up).

Verdict: the HLS is honestly and correctly built for its bounded case
(single-rendition muxed TS). It is not yet a general TAMS-to-HLS bridge while
separate audio/video flows and multivariant output are absent.

## 5. Code quality and conformance strategy

- The conformance strategy is genuinely good: `scripts/interop-coverage.ts` builds
  the Fastify app in-process, diffs its generated OpenAPI against the vendored spec,
  writes a subset, and runs Schemathesis against only the implemented operations.
  `spec/interop-baseline.json` is a regression guard (a baselined operation that
  disappears fails CI).
- Tests sit beside essentially every endpoint and util. CI: lint, prettier,
  typecheck, unit tests, e2e, interop, audit.
- Clean separation: pure builders (`hlsManifest`, `timerange`) are DB/HTTP-free and
  trivially unit-testable.
- The auth model is well thought through and documented (gateway bearer OR an OSC
  access gate / SAT in front, never both), with a production warning when
  `NODE_ENV=production` runs without `API_TOKEN`.

## 6. Prioritised gaps

### P0, blocks real TAMS interop / playback of real sources

- Separate audio+video flows to multivariant HLS (master playlist). Today only a
  muxed TS is playable.
- Webhooks / event notifications. Without them no consumer can react to new
  segments (poll-only).

### P1, conformance and data volume

- Paging headers (`Link`, `X-Paging-*`, `page`/`key` cursor) on
  `GET /flows/{id}/segments`.
- `DELETE /flows/{id}/segments` (timerange deletion) plus `/flow-delete-requests`
  (async model).
- `GET /sources/{sourceId}` and the flow/source property endpoints
  (tags/description/label/...).

### P2, full spec surface and HLS polish

- Objects API, `GET`/`POST /service`, `GET /service/storage-backends`, HEAD methods.
- HLS: TAI to UTC correction on `PROGRAM-DATE-TIME`, `EXT-X-DISCONTINUITY-SEQUENCE`,
  a segment proxy for long VOD manifests.

## 7. Recommendation

As a single-click runnable media backend the gateway is already functional: deploy
on OSC with CouchDB and object storage, ingest TS segments, play directly via
`output.m3u8`. For that purpose P0 playback (multivariant + separate flows) is the
most valuable investment because it determines how many real TAMS sources are
actually playable. To call it a conformant TAMS server requires webhooks, paging,
and delete-requests (P0/P1). The conformance tooling and code hygiene are not the
gap; the feature surface is.
