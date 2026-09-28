import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Constant-time compare that does not leak the expected token's length. */
function secretsMatch(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Stateless Streamable HTTP transport: every POST /mcp gets a fresh server and
 * transport, so the container can serve concurrent clients without sticky
 * sessions. Useful when running the image as a long-lived service; the default
 * stdio transport is used when MCP_TRANSPORT is unset.
 */
export async function startHttpServer(
  factory: () => McpServer,
  port: number,
  expectedToken: string,
): Promise<void> {
  const httpServer = createHttpServer((req, res) => {
    void handle(factory, req, res, expectedToken).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32700, message: `Bad request: ${message}` },
          id: null,
        });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "0.0.0.0", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
}

async function handle(
  factory: () => McpServer,
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: string,
): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  // Unauthenticated so container/orchestrator probes work; leaks nothing.
  if (req.method === "GET" && (path === "/healthz" || path === "/")) {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (path !== "/mcp") {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const presented = bearerToken(req);
  if (presented === undefined || !secretsMatch(presented, expectedToken)) {
    res
      .writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="outline-embedding-mcp", error="invalid_token"',
      })
      .end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: a valid Bearer token is required" },
          id: null,
        }),
      );
    return;
  }

  if (req.method !== "POST") {
    // Stateless mode has no server-initiated streams or sessions to resume.
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed: this server is stateless, use POST /mcp" },
        id: null,
      }),
    );
    return;
  }

  const body = await readBody(req);
  const server = factory();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
