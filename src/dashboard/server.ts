import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { DashboardConfig } from "./config.js";
import type { DashboardSnapshot } from "./domain.js";

export interface DashboardDataSource {
  snapshot(): Promise<DashboardSnapshot>;
}

const STATIC_FILES = new Map([
  ["/", { contentType: "text/html; charset=utf-8", file: "index.html" }],
  ["/app.js", { contentType: "text/javascript; charset=utf-8", file: "app.js" }],
  ["/styles.css", { contentType: "text/css; charset=utf-8", file: "styles.css" }],
  ["/preview", { contentType: "text/html; charset=utf-8", file: "preview/index.html" }],
  ["/preview/", { contentType: "text/html; charset=utf-8", file: "preview/index.html" }],
  ["/preview/app.js", { contentType: "text/javascript; charset=utf-8", file: "preview/app.js" }],
  ["/preview/styles.css", { contentType: "text/css; charset=utf-8", file: "preview/styles.css" }],
]);

function securityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

async function sendStatic(
  request: IncomingMessage,
  response: ServerResponse,
  file: string,
  contentType: string,
): Promise<void> {
  const body = await readFile(resolve(process.cwd(), "dashboard", file));
  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", body.byteLength);
  response.end(request.method === "HEAD" ? undefined : body);
}

export function createDashboardServer(
  dataSource: DashboardDataSource,
  config: DashboardConfig,
) {
  return createServer(async (request, response) => {
    securityHeaders(response);
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (pathname === "/api/dashboard") {
        if (request.method === "HEAD") {
          response.statusCode = 200;
          response.setHeader("Cache-Control", "no-store");
          response.end();
          return;
        }
        sendJson(response, 200, await dataSource.snapshot());
        return;
      }
      if (pathname === "/api/live-pilot") {
        // Fixed, sanitized exporter output. This endpoint has no ledger or signer access.
        const path=process.env.PILOT_STATUS_PATH;
        let pilot:unknown=null;
        if(path)try{pilot=JSON.parse(await readFile(path,"utf8"));}catch{/* No active exporter yet. */}
        sendJson(response,200,{available:pilot!==null,pilot});
        return;
      }
      const asset = STATIC_FILES.get(pathname);
      if (asset === undefined) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      await sendStatic(request, response, asset.file, asset.contentType);
    } catch {
      if (!response.headersSent) {
        sendJson(response, 500, { error: "dashboard_query_failed" });
      } else {
        response.destroy();
      }
    }
  }).listen(config.port, config.host);
}
