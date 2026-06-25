<h1 align="center">
  TAMS Gateway
</h1>

<div align="center">
  The Time-addressable Media Store (TAMS) stores segmented media flows by combining a media store that holds the individual media flow segments with a service that provides a database index for these segments.
</div>

<p align="center">
  <img src="./src/assets/flow.png" width="350" title="Flow">
</p>

## Requirements

Node.js >= 20 ( LTS )  
A couchDB database (https://app.osaas.io/dashboard/service/apache-couchdb)  
An S3 Storage (https://app.osaas.io/dashboard/service/minio-minio)

## Deploy on Open Source Cloud

TAMS Gateway is available as a managed service on
[Eyevinn Open Source Cloud](https://app.osaas.io/dashboard/service/eyevinn-tams-gateway),
so you can run it without setting up a local environment.

It needs two backing services, which you also run on Open Source Cloud:

- A CouchDB database (https://app.osaas.io/dashboard/service/apache-couchdb) for the segment index.
- An S3-compatible bucket on MinIO (https://app.osaas.io/dashboard/service/minio-minio) for the media segments. The `S3_BUCKET` must already exist.

Create those two first, then deploy the gateway and point it at them with the
same environment variables shown below. When the gateway runs behind the OSC
ingress gate, leave `API_TOKEN` unset and let the gate authenticate callers (see
[Authentication](#authentication)).

## Installation / Usage

Install dependencies

```
pnpm install
```

Create an .env file based on the .env.sample file in the root of the project. Add to it:

```
DB_URL=<DB_URL>
DB_USERNAME=<DB_USERNAME>
DB_PASSWORD=<DB_PASSWORD>
S3_ENDPOINT_URL=<S3_ENDPOINT_URL>
S3_BUCKET=<S3_BUCKET>
AWS_ACCESS_KEY_ID=<ACCESS_KEY_ID>
AWS_SECRET_ACCESS_KEY=<SECRET_ACCESS_KEY>
API_TOKEN=<API_TOKEN>
```

`S3_BUCKET` must already exist; the gateway allocates object keys within it and
never creates buckets.

Optional variables: `PORT` (default `8000`), `AWS_REGION` (default
`eu-north-1`), `CORS_ORIGIN` (comma-separated allowlist), `LOG_LEVEL`,
`ENABLE_UI` (default `true`, serves the inspector UI at `/ui`), `HLS_URL_TTL`
(default `21600`, presigned segment-URL lifetime in seconds for HLS output),
`LIVE_RECENCY_WINDOW` (default `30`, seconds within which the latest segment marks
a flow live), `LIVE_WINDOW_SEC` (default `300`, span in seconds of the live
HLS playlist DVR window ending at the live edge) and `WEBHOOK_TIMEOUT_MS` (default
`5000`, per-webhook delivery timeout in milliseconds for outbound event POSTs).

If you are using the couchDB and Minio services from OSC then this file will look like:

```
DB_URL=<LINK TO OSC COUCHDB SERVICE>
DB_USERNAME=admin
DB_PASSWORD=<AdminPassword>
S3_ENDPOINT_URL=<LINK TO OSC MINIO SERVICES>
AWS_ACCESS_KEY_ID=<RootUSer> //Set when creating OSC Minio Service
AWS_SECRET_ACCESS_KEY=<RootPassword> //Set when creating OSC Minio Service
```

To start TAMS-Gateway

```
pnpm start
```

The API is then running on http://localhost:8000

## Development

To start TAMS-Gateway in development mode

```
pnpm dev
```

The API is then running on http://localhost:8000

## API

Once the server is running, interactive API documentation (Swagger UI) is
available at `http://localhost:8000/docs`.

The gateway exposes the TAMS resources:

| Method & path                                       | Description                                               |
| --------------------------------------------------- | --------------------------------------------------------- |
| `GET /`                                             | Healthcheck (browser is redirected to `/ui` when enabled) |
| `PUT /flows/{id}`                                   | Create or update a flow (and its source)                  |
| `GET /flows`                                        | List flows                                                |
| `GET /flows/{id}`                                   | Get a flow                                                |
| `DELETE /flows/{id}`                                | Delete a flow and its segments                            |
| `GET /sources`                                      | List sources                                              |
| `GET /sources/{id}`                                 | Get a source                                              |
| `POST /flows/{id}/storage`                          | Allocate storage and get presigned PUT URLs               |
| `POST /flows/{id}/segments`                         | Register a segment for a flow                             |
| `GET /flows/{id}/segments?timerange=[start_end)`    | List a flow's segments, optionally filtered by range      |
| `DELETE /flows/{id}/segments?timerange=[start_end)` | Delete segments completely covered by the timerange       |
| `GET /flow-delete-requests`                         | List flow segment deletion requests                       |
| `GET /flow-delete-requests/{requestId}`             | Get a deletion request                                    |
| `GET /flows/{id}/output.m3u8?type=live\|vod`        | Playable HLS media playlist for a flow's TS segments      |
| `GET /service`                                      | Service descriptor (advertises supported event streams)   |
| `GET /service/storage-backends`                     | List the object-store backends available                  |
| `POST /service/webhooks`                            | Register a webhook for event notifications                |
| `GET /service/webhooks`                             | List registered webhooks                                  |
| `GET /service/webhooks/{webhookId}`                 | Get a webhook                                             |
| `PUT /service/webhooks/{webhookId}`                 | Update a webhook                                          |
| `DELETE /service/webhooks/{webhookId}`              | Delete a webhook                                          |

Segments are time-addressed using the TAMS timerange format
`[<seconds>:<nanoseconds>_<seconds>:<nanoseconds>)` (TAI). On startup the
gateway creates the required CouchDB databases and the segment index
automatically.

`GET /flows/{id}/segments` is paged: pass `limit` to cap the page size, and follow
the `Link: <...>; rel="next"` response header (or pass the `X-Paging-NextKey` value
back as the `page` query parameter) to read the next page. Responses also carry
`X-Paging-Limit`, `X-Paging-Count`, `X-Paging-Reverse-Order` and `X-Paging-Timerange`.

Individual flow and source properties can be read and edited without a full
`PUT`: `GET`/`PUT`/`DELETE /flows/{id}/{property}` for `description`, `label`,
`max_bit_rate`, `avg_bit_rate`, `flow_collection` (and `GET`/`PUT
/flows/{id}/read_only`), and `description` / `label` for sources. Tags are
managed at `GET /{resource}/{id}/tags` (the whole map) and
`GET`/`PUT`/`DELETE /{resource}/{id}/tags/{name}` (one tag). Writes to a
read-only flow return `403`.

## HLS output

`GET /flows/{id}/output.m3u8` synthesises an HLS media playlist on the fly from a
flow's MPEG-TS segments, so any TS flow is directly playable in a standard HLS
client (hls.js, Safari, Omakase Player, ...). Segment URIs are presigned object
URLs served straight from the store.

- `?type=vod`: a complete playlist ending with `#EXT-X-ENDLIST`.
- `?type=live`: the latest segments at the live edge, no end tag, advancing on
  reload. When `type` is omitted the gateway picks live/VOD heuristically; pass it
  explicitly for predictable behaviour.
- `?timerange=[start_end)` restricts to a window; `?limit=N` caps the segment count.

Only MPEG-TS (H.264/AAC) flows are playable; others return `415`. Browser playback
also needs a CORS policy on the object store allowing `GET` + `Range` from the
player origin.

## Webhooks (event notifications)

The gateway can notify external services of changes via webhooks (TAMS event
notifications). Register a webhook with `POST /service/webhooks`:

```json
{
  "url": "https://hook.example.com",
  "api_key_name": "Authorization",
  "api_key_value": "Bearer <token>",
  "events": ["flows/created", "flows/segments_added"]
}
```

The gateway then POSTs a JSON body `{ event_timestamp, event_type, event }` to the
registered `url` for each subscribed event, setting the `api_key_name` header to
`api_key_value` when both are given. Supported event types: `flows/created`,
`flows/updated`, `flows/deleted`, `flows/segments_added`,
`flows/segments_deleted`, `sources/created`, `sources/updated` (and
`sources/deleted` once source deletion lands). Delivery can be scoped with the
`flow_ids` / `source_ids` filters. The `api_key_value` secret is stored but never returned by
any `GET`. Whether webhooks are supported is advertised in
`event_stream_mechanisms` on `GET /service`.

Delivery is best-effort with a per-webhook timeout (`WEBHOOK_TIMEOUT_MS`); a slow
or failing subscriber never blocks or fails the API request that triggered the
event. As a basic SSRF mitigation, delivery to non-HTTP(S) URLs and the cloud
metadata address is refused.

## Inspector UI

A built-in, read-only inspector is served at `/ui` (enabled by default; set
`ENABLE_UI=false` to disable). It browses sources, flows and segments with native
local timestamps, and plays a flow with an embedded HLS player (`-10s`/`+10s`
jumps, a local wall-clock readout, and a "behind live" indicator). It only ever
issues `GET` requests. When the UI is enabled, a browser hitting the root `/` is
redirected to it, while API clients (JSON `Accept`) still get the root-paths
response. The inspector inherits the deployment's auth (it is not public), so it is
directly reachable when the gateway runs standalone or behind a browser-friendly
gate.

## Authentication

When `API_TOKEN` is set, every route except the liveness (`/`), readiness
(`/readiness`) and docs (`/docs`) endpoints requires a bearer token:

```
Authorization: Bearer <API_TOKEN>
```

`API_TOKEN` is **optional**. When it is set, the gateway enforces the bearer
token itself. When it is unset, the gateway does not enforce its own auth and
expects authentication to be handled by an upstream authenticating proxy / access
gate in front of it. To avoid an accidentally unprotected deployment, the gateway
logs a warning at startup when it runs with `NODE_ENV=production` and no
`API_TOKEN` set; make sure a gate is in front in that case.

### Which layer authenticates

- **Behind an access gate (e.g. on OSC): leave `API_TOKEN` unset.** The OSC ingress
  gate authenticates callers by validating a Service Access Token (SAT) on the
  `Authorization` header before the request reaches the gateway, so the gateway's
  own bearer check is redundant. Importantly, if `API_TOKEN` _is_ set in this
  setup, the gateway would reject SAT-carrying requests (the SAT value is not the
  `API_TOKEN`), so it must be left unset and the gate is the enforcing layer.
- **Standalone (no gate): set `API_TOKEN`** (or use another auth mode). Here the
  gateway's own bearer is the primary, enforcing layer.

## Scripts

| Command              | Description                    |
| -------------------- | ------------------------------ |
| `pnpm dev`           | Start in watch mode            |
| `pnpm start`         | Start the server               |
| `pnpm test`          | Run the test suite (Vitest)    |
| `pnpm run lint`      | Lint with ESLint               |
| `pnpm run pretty`    | Check formatting with Prettier |
| `pnpm run typecheck` | Type-check with TypeScript     |

## Additional Resources

[BBC TAMS REPO](https://github.com/bbc/tams/blob/main/api/TimeAddressableMediaStore.yaml)  
[BBC TAMS API DOCS](https://bbc.github.io/tams/main/index.html#/)

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md)

## License

This project is licensed under the MIT License, see [LICENSE](LICENSE).

# Support

Join our [community on Slack](http://slack.streamingtech.se) where you can post any questions regarding any of our open source projects. Eyevinn's consulting business can also offer you:

- Further development of this component
- Customization and integration of this component into your platform
- Support and maintenance agreement

Contact [sales@eyevinn.se](mailto:sales@eyevinn.se) if you are interested.

# About Eyevinn Technology

[Eyevinn Technology](https://www.eyevinntechnology.se) help companies in the TV, media, and entertainment sectors optimize costs and boost profitability through enhanced media solutions.
We are independent in a way that we are not commercially tied to any platform or technology vendor. As our way to innovate and push the industry forward, we develop proof-of-concepts and tools. We share things we have learn and code as open-source.

With Eyevinn Open Source Cloud we enable to build solutions and applications based on Open Web Services and avoid being locked in with a single web service vendor. Our open-source solutions offer full flexibility with a revenue share model that supports the creators.

Read our blogs and articles here:

- [Developer blogs](https://dev.to/video)
- [Medium](https://eyevinntechnology.medium.com)
- [OSC](https://www.osaas.io)
- [LinkedIn](https://www.linkedin.com/company/eyevinn/)

Want to know more about Eyevinn, contact us at info@eyevinn.se!
