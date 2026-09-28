# outline-embedding-mcp

A one-tool [MCP](https://modelcontextprotocol.io) server over the internal
knowledge-base embedding search API. Give it the text of a support ticket, get
back the most semantically similar KB articles.

## Tool

### `search_knowledge_base`

| Input | Type | Description |
| --- | --- | --- |
| `ticket` | string, required | Full ticket text, verbatim and in its original language. |

It calls `POST $KB_API_URL/search` with an `X-API-Key` header and a
`{"ticket": "..."}` body, then renders the response — `match`, `threshold` and
each hit's title, score, link, `article_id` and snippet — as text. Hits are
marked "above threshold" individually, and when nothing clears the threshold the
closest matches are still returned, labelled as such, so the caller can judge
for itself.

Relative article URLs (`/doc/...`) are turned into absolute links using the
origin of `KB_API_URL`, or `KB_DOC_BASE_URL` if set.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `KB_API_URL` | yes | KB base including the tenant segment, e.g. `https://kb.ruintech.net/sculkinternal`. The `/search` suffix is appended automatically; passing the full `.../search` URL also works. |
| `KB_API_KEY` | yes | Sent as the `X-API-Key` header. |
| `KB_DOC_BASE_URL` | no | Base for article links. Defaults to the origin of `KB_API_URL`. |
| `KB_TIMEOUT_MS` | no | Request timeout, default `30000`. |
| `MCP_TRANSPORT` | no | `stdio` (default) or `http`. |
| `PORT` | no | HTTP port, default `3000`. |
| `MCP_AUTH_TOKEN` | http only | Bearer token clients must send on `/mcp`. **Required** when `MCP_TRANSPORT=http`. |

## Run with Docker

```bash
cp .env.example .env   # then fill in KB_API_KEY
docker build -t outline-embedding-mcp .
docker run -i --rm --env-file .env outline-embedding-mcp
```

Client config:

```json
{
  "mcpServers": {
    "kb-search": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "KB_API_URL", "-e", "KB_API_KEY", "outline-embedding-mcp"],
      "env": {
        "KB_API_URL": "https://kb.ruintech.net/sculkinternal",
        "KB_API_KEY": "..."
      }
    }
  }
}
```

As a long-running HTTP service (`POST /mcp`, bearer auth, `GET /healthz` open
for probes):

```bash
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose up -d --build
```

## CI / publishing

`.github/workflows/publish.yml` typechecks, builds, smoke-tests and pushes to
`docker.sculk.ltd/public-mcps/outline-embedding-mcp` — same setup as the other
MCP servers. It needs two repository secrets, `HARBOR_USERNAME` (the Harbor
robot name, e.g. `robot$public-mcps+github`) and `HARBOR_PASSWORD`, added under
**Settings → Secrets and variables → Actions → Secrets**. PR runs build and
smoke-test without pushing; `main` pushes `main` + `sha-<short>`; a `v1.2.3` tag
pushes `1.2.3`, `1.2`, `1`, `latest`.

## Run without Docker

```bash
npm install
npm run build
KB_API_URL=... KB_API_KEY=... npm start
```

Requires Node.js 20+.
