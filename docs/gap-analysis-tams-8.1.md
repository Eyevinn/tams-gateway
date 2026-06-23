# TAMS Gateway, gap analysis against BBC TAMS 8.1

- **Originally analysed:** 2026-06-23 at revision `650eb4c`
- **Updated:** 2026-06-23 after the P0a/P1 implementation work (see "Progress" below)
- **Specification:** vendored BBC TAMS **8.1** (`spec/`, commit `bfefbbcdfea9bcd8ee532281c60564bb57842619`)
- **Coverage source:** `pnpm run interop` (gateway's generated OpenAPI vs the vendored spec).

## Progress since the original analysis

The original analysis found 9 of the spec's operations implemented. The webhooks
(P0a) and the P1 conformance work have since landed:

- **P0a, webhooks + service descriptor** (#67): full CRUD on `/service/webhooks`,
  event emission (flow/source created/updated/deleted, segments added/deleted),
  delivery filters, an SSRF guard, and `GET /service` advertising the webhooks
  event stream.
- **P1.1, segment paging** (#68): `Link` + `X-Paging-*` headers and a `page`
  cursor on `GET /flows/{id}/segments`.
- **P1.2, segment deletion** (#69): `DELETE /flows/{id}/segments` (timerange
  containment) plus `GET /flow-delete-requests[/{id}]`.
- **P1.3, source detail + properties** (#72): `GET /sources/{id}` and the flow and
  source property/tag endpoints.
- **HLS TAI/UTC fix** (#67): `PROGRAM-DATE-TIME` is now emitted as civil UTC
  (TAI - 37s), closing limitation 2 below.

**Interop coverage rose from 9 to 50 of 80 spec operations (11% to 62.5%).** The
remaining gaps are P2 (objects API, `POST /service`, `/service/storage-backends`,
HEAD methods) and the parked **P0b** (multivariant HLS for separate audio/video
flows, blocked on a remux path, tracked in issue #66 and ADR-008).

## 1. Summary

The gateway is a high-value subset of a TAMS server: segment ingest, indexing,
playback (presigned S3 URLs plus on-the-fly HLS), event notifications, and the
flow/source metadata surface. After the P0a/P1 work it is a conformant TAMS server
for the meaningful surface, covering **50 of 80 spec operations (62.5%)**, with the
conformance harness (Schemathesis against the implemented subset) green.

The one genuine capability gap left is playback of sources whose audio and video
are separate flows, which needs a remux to fMP4 the gateway does not have (P0b,
parked). The other gaps are conformance-completeness (P2) with diminishing returns.

## 2. Implemented surface

Verified against `src/api/api.ts` and `spec/interop-baseline.json`.

| Area                    | Operations                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Service                 | `GET /service`                                                                                                                        |
| Flows                   | `GET /flows`, `GET`/`PUT`/`DELETE /flows/{id}`                                                                                        |
| Flow properties         | `GET`/`PUT`/`DELETE` for `description`, `label`, `max_bit_rate`, `avg_bit_rate`, `flow_collection`; `GET`/`PUT /flows/{id}/read_only` |
| Flow tags               | `GET /flows/{id}/tags`; `GET`/`PUT`/`DELETE /flows/{id}/tags/{name}`                                                                  |
| Sources                 | `GET /sources`, `GET /sources/{id}`                                                                                                   |
| Source properties       | `GET`/`PUT`/`DELETE` for `description`, `label`; tags collection + `tags/{name}`                                                      |
| Storage & segments      | `POST /flows/{id}/storage`; `GET`/`POST`/`DELETE /flows/{id}/segments` (paged; delete by timerange containment)                       |
| Flow delete requests    | `GET /flow-delete-requests`, `GET /flow-delete-requests/{id}`                                                                         |
| Webhooks                | `POST`/`GET /service/webhooks`; `GET`/`PUT`/`DELETE /service/webhooks/{id}`                                                           |
| Output (extension)      | `GET /flows/{id}/output.m3u8` (HLS, not in TAMS spec)                                                                                 |
| Operational (extension) | `GET /`, `GET /readiness`, `GET /ui`                                                                                                  |

## 3. Remaining gaps (against TAMS 8.1)

### Genuine capability gap

- **Multivariant HLS for separate audio+video flows (P0b, parked).** TAMS commonly
  models audio and video as separate flows under one source. HLS cannot combine two
  single-track MPEG-TS renditions without a remux to fMP4, which the gateway does
  not have (it only presigns already-ingested bytes). Phase-1 labelling of muxed
  multi flows is low value because those already play. The real unblock is a remux
  path (in-gateway ffmpeg vs an OSC media service), a stack decision tracked in
  issue #66 and ADR-008.

### Conformance completeness (P2, lower value)

- **Objects API** (`GET`/`HEAD /objects/{id}`, `POST`/`DELETE
/objects/{id}/instances`). No object introspection or multi-instance handling.
- **`POST /service`** (update the service descriptor) and
  **`GET /service/storage-backends`** (backend catalogue).
- **`HEAD` methods** throughout. Fastify auto-exposes HEAD for GET routes at
  runtime, but they are not declared in the generated OpenAPI, so they do not count
  toward interop coverage.

### Minor within implemented endpoints

- `GET /flows/{id}/segments` omits some spec query params (`object_id`,
  `presigned`, `accept_get_urls`, `accept_storage_ids`, `verbose_storage`,
  `include_object_timerange`) and the `get_urls` items omit `presigned`/`label`.
- The segment object omits `ts_offset`, `last_duration`, `key_frame_count`.

## 4. HLS output assessment

Core logic: `src/api/utils/hlsManifest.ts` (pure builder) plus
`src/api/endpoints/output/getHlsPlaylist.ts`. Structurally correct for a
single-rendition muxed MPEG-TS.

### Correct

- `#EXTM3U`, `#EXT-X-VERSION:3`, `TARGETDURATION = ceil(max EXTINF)` (floor 1),
  `MEDIA-SEQUENCE`; BigInt nanosecond math throughout.
- `EXT-X-DISCONTINUITY` on a timeline gap. VOD: `PLAYLIST-TYPE:VOD` + `ENDLIST`.
  Live: open playlist, `Cache-Control: no-store`, a DVR window at the live edge.
- Signing date pinned to the hour so segments presign to stable URLs across
  reloads (no manifest churn). A `?timerange` request is always closed with
  `ENDLIST`.
- `PROGRAM-DATE-TIME` is now emitted as civil UTC (TAI - 37s), fixed in #67.

### Remaining limitations / risks

1. **No multivariant (master) playlist / separate audio+video flows.** The largest
   limitation, see P0b above (blocked on remux).
2. **`MEDIA-SEQUENCE` is derived from `ts_start / segment_duration`**, not a count of
   removed segments. Monotonic and stable (sufficient for HLS), but non-standard.
3. **No `EXT-X-DISCONTINUITY-SEQUENCE`** when the live window slides past a
   discontinuity. Minor for the DVR case.
4. **VOD build loads up to `VOD_MAX_SEGMENTS` (50000) segments and presigns each.**
   Heavy on very long flows; a segment proxy would remove that cost (follow-up).

## 5. Code quality and conformance strategy

- The conformance strategy remains strong: `scripts/interop-coverage.ts` diffs the
  gateway's generated OpenAPI against the vendored spec and emits a subset;
  `scripts/interop-conformance.sh` runs Schemathesis against that subset (response
  schema, status code and content-type checks), with the Flow resource read/write
  on relaxed checks (the known flat-Flow-schema gap, ADR-001 OQ2) and the
  `filter_too_much` data-generation health check suppressed.
- `spec/interop-baseline.json` is a regression guard (a baselined operation that
  disappears fails CI). Tests sit beside essentially every endpoint.
- The auth model (gateway bearer OR an OSC access gate / SAT in front, never both)
  is documented, with a production warning when run without `API_TOKEN`.

## 6. Prioritised gaps (current)

- **P0a, webhooks + event notifications.** DONE (#67).
- **P0b, multivariant HLS for separate audio+video flows.** PARKED, needs a remux
  path (issue #66, ADR-008). The genuine remaining capability gap.
- **P1, conformance and data volume.** DONE: segment paging (#68), segment deletion
  - flow-delete-requests (#69), source detail + flow/source property/tag endpoints
    (#72).
- **P2, full spec surface and HLS polish.** REMAINING, lower value: objects API,
  `POST /service`, `GET /service/storage-backends`, declared HEAD methods; HLS
  `EXT-X-DISCONTINUITY-SEQUENCE` and a segment proxy for long VOD manifests. The
  HLS TAI/UTC item is DONE (#67).

## 7. Recommendation

The gateway is now a conformant TAMS server for the meaningful surface and a usable
single-click media backend: deploy on OSC with CouchDB and object storage, ingest
TS segments, manage flows/sources and their metadata, subscribe to events, and play
via `output.m3u8`. The highest-value remaining work is the parked P0b remux path
(real separate audio/video playback), which is a stack decision rather than a pure
code task. P2 raises interop coverage toward full conformance but with diminishing
real-world value; pursue it if full BBC TAMS conformance is an explicit goal.
