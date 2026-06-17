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
`eu-north-1`), `CORS_ORIGIN` (comma-separated allowlist), `LOG_LEVEL`.

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

| Method & path                                    | Description                                          |
| ------------------------------------------------ | ---------------------------------------------------- |
| `GET /`                                          | Healthcheck                                          |
| `PUT /flows/{id}`                                | Create or update a flow (and its source)             |
| `GET /flows`                                     | List flows                                           |
| `GET /flows/{id}`                                | Get a flow                                           |
| `DELETE /flows/{id}`                             | Delete a flow and its segments                       |
| `GET /sources`                                   | List sources                                         |
| `POST /flows/{id}/storage`                       | Allocate storage and get presigned PUT URLs          |
| `POST /flows/{id}/segments`                      | Register a segment for a flow                        |
| `GET /flows/{id}/segments?timerange=[start_end)` | List a flow's segments, optionally filtered by range |

Segments are time-addressed using the TAMS timerange format
`[<seconds>:<nanoseconds>_<seconds>:<nanoseconds>)` (TAI). On startup the
gateway creates the required CouchDB databases and the segment index
automatically.

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
