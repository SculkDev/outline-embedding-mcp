#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { startHttpServer } from "./http.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/**
 * Accepts the KB base (`https://kb.example.net/tenant`) or the full search
 * endpoint (`https://kb.example.net/tenant/search`) and normalises to the
 * latter.
 */
function searchEndpoint(raw: string): string {
  const base = raw.replace(/\/+$/, "");
  return base.endsWith("/search") ? base : `${base}/search`;
}

function loadConfig() {
  const apiUrl = required("KB_API_URL");
  let origin: string;
  try {
    origin = new URL(apiUrl).origin;
  } catch {
    throw new Error(`KB_API_URL is not a valid URL: ${apiUrl}`);
  }
  const timeoutMs = Number.parseInt(process.env.KB_TIMEOUT_MS?.trim() || "30000", 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("KB_TIMEOUT_MS must be a positive integer");
  }
  return {
    searchUrl: searchEndpoint(apiUrl),
    apiKey: required("KB_API_KEY"),
    /** Base used to turn the relative `url` of a hit into a clickable link. */
    docBaseUrl: (process.env.KB_DOC_BASE_URL?.trim() || origin).replace(/\/+$/, ""),
    timeoutMs,
    authToken: process.env.MCP_AUTH_TOKEN?.trim() || undefined,
  };
}

// Misconfiguration should read as a one-line message, not a stack trace.
const config = ((): ReturnType<typeof loadConfig> => {
  try {
    return loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})();

interface SearchHit {
  article_id: string;
  title: string;
  url: string;
  score: number;
  snippet: string;
}

interface SearchResponse {
  match: boolean;
  threshold: number;
  results: SearchHit[];
}

async function search(ticket: string): Promise<SearchResponse> {
  let response: Response;
  try {
    response = await fetch(config.searchUrl, {
      method: "POST",
      headers: {
        "X-API-Key": config.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ ticket }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new Error(`Knowledge base request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Knowledge base returned HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }

  try {
    return JSON.parse(raw) as SearchResponse;
  } catch {
    throw new Error(`Knowledge base returned non-JSON response: ${raw.slice(0, 300)}`);
  }
}

function formatResults(result: SearchResponse): string {
  const { match, threshold, results = [] } = result;

  if (results.length === 0) {
    return `No knowledge base articles found (threshold ${threshold}).`;
  }

  const header = match
    ? `Match found — ${results.length} article(s), best score ${results[0]?.score?.toFixed(4)} (threshold ${threshold}):`
    : `No article passed the threshold of ${threshold}; showing ${results.length} closest match(es) for reference:`;

  const body = results.map((hit) => {
    const link = hit.url?.startsWith("http") ? hit.url : `${config.docBaseUrl}${hit.url ?? ""}`;
    const aboveThreshold = hit.score >= threshold ? " (above threshold)" : "";
    // Snippets are raw Markdown and often start with their own `##` heading, so
    // quote them to keep them visually distinct from the article heading.
    const snippet = (hit.snippet ?? "")
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return [
      `## ${hit.title}`,
      `score: ${hit.score.toFixed(4)}${aboveThreshold}`,
      `url: ${link}`,
      `article_id: ${hit.article_id}`,
      "",
      snippet,
    ].join("\n");
  });

  return [header, ...body].join("\n\n");
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "outline-embedding-mcp", version: "1.0.0" },
    {
      instructions:
        "Semantic search over the internal support knowledge base. Pass the customer's ticket text to " +
        "search_knowledge_base to get the most relevant articles, each with a similarity score and snippet.",
    },
  );

  server.registerTool(
    "search_knowledge_base",
    {
      title: "Search knowledge base",
      description:
        "Semantically search the internal support knowledge base with the text of a customer ticket. " +
        "Returns the closest articles with a similarity score, a snippet and a link, plus whether any " +
        "article passed the relevance threshold. Pass the ticket text verbatim — it is embedded as a " +
        "whole, so do not summarise or translate it first.",
      inputSchema: {
        ticket: z.string().min(1).describe("Full text of the customer ticket, verbatim and in its original language."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ ticket }) => {
      try {
        return { content: [{ type: "text" as const, text: formatResults(await search(ticket)) }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

  if (transport === "http") {
    const port = Number.parseInt(process.env.PORT ?? "3000", 10);
    if (!Number.isFinite(port) || port <= 0) throw new Error("PORT must be a positive integer");
    if (!config.authToken) {
      throw new Error(
        "MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http; clients must send it as `Authorization: Bearer <token>`",
      );
    }
    await startHttpServer(createServer, port, config.authToken);
    console.error(`outline-embedding-mcp listening on http://0.0.0.0:${port}/mcp (bearer auth required)`);
    return;
  }

  if (transport !== "stdio") {
    throw new Error(`Unsupported MCP_TRANSPORT "${transport}" (expected "stdio" or "http")`);
  }

  await createServer().connect(new StdioServerTransport());
  console.error("outline-embedding-mcp running on stdio");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
