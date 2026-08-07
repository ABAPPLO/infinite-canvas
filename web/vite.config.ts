import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

const readBody = (req: IncomingMessage) =>
    new Promise<Buffer>((resolveBody, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolveBody(Buffer.concat(chunks)));
        req.on("error", reject);
    });

// 开发服务器同源 API 代理的转发目标校验：只放行公网 http(s)。
// 拦截 loopback / 链路本地(含云元数据 169.254.169.254)；保留 RFC1918 私网段，
// 因为本应用可能把 baseUrl 指向局域网自建中转站。
// 不转发的请求头：hop-by-hop 头，以及 accept-encoding —— 让 undici 自行协商并解压，否则会原样透传压缩字节。
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "host", "content-length", "expect", "accept-encoding"]);
function aiProxyTarget(raw: string): URL | null {
    if (!/^https?:\/\//i.test(raw)) return null;
    let target: URL;
    try {
        target = new URL(raw);
    } catch {
        return null;
    }
    const host = target.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1") return null;
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const [a, b] = ipv4.slice(1, 3).map(Number);
        if (a === 0 || a === 127 || (a === 169 && b === 254)) return null;
    }
    return target;
}

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

// Same-origin fetch proxy for the dev server: lets the browser fetch remote
// http(s) URLs (e.g. hosted generation results) without being blocked by CORS,
// so image persistence works even when the local canvas-agent is not connected.
// POST /api/fetch-blob { url } -> streams the remote body back to the browser.
function localFetchProxy(): Plugin {
    const handler = async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") {
            res.statusCode = 405;
            return res.end();
        }
        try {
            const { url } = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { url?: unknown };
            if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
                res.statusCode = 400;
                return res.end("bad url");
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30_000);
            try {
                const upstream = await fetch(url, { signal: controller.signal });
                const buf = Buffer.from(await upstream.arrayBuffer());
                if (buf.byteLength > 30 * 1024 * 1024) {
                    res.statusCode = 413;
                    return res.end("too large");
                }
                res.statusCode = upstream.status;
                res.setHeader("content-type", upstream.headers.get("content-type") || "application/octet-stream");
                res.end(buf);
            } finally {
                clearTimeout(timer);
            }
        } catch {
            res.statusCode = 502;
            res.end("proxy error");
        }
    };
    return {
        name: "local-fetch-proxy",
        configureServer(server) {
            server.middlewares.use("/api/fetch-blob", handler);
        },
        configurePreviewServer(server) {
            server.middlewares.use("/api/fetch-blob", handler);
        },
    };
}

// General-purpose AI API proxy for the dev server. The browser calls
// /api/ai-proxy?target=<url> with the original method/headers/body; the dev
// server forwards them to the upstream provider and streams the response back
// (status + headers + body, SSE included). Lets providers that don't set CORS
// headers (e.g. Volcengine Ark) work from the browser without canvas-agent.
function aiProxy(): Plugin {
    const handler = async (req: IncomingMessage, res: ServerResponse) => {
        const target = aiProxyTarget(String(new URL(req.url || "", "http://x").searchParams.get("target") || ""));
        if (!target) {
            res.statusCode = 400;
            return res.end("bad target");
        }
        const method = (req.method || "GET").toUpperCase();
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
            if (!value || HOP_BY_HOP.has(key)) continue;
            headers[key] = Array.isArray(value) ? value.join(", ") : value;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300_000);
        try {
            const body = ["GET", "HEAD"].includes(method) ? undefined : await readBody(req);
            const upstream = await fetch(target, { method, headers, body, redirect: "follow", signal: controller.signal });
            res.statusCode = upstream.status;
            const contentType = upstream.headers.get("content-type");
            if (contentType) res.setHeader("content-type", contentType);
            const contentDisposition = upstream.headers.get("content-disposition");
            if (contentDisposition) res.setHeader("content-disposition", contentDisposition);
            if (upstream.body) {
                for await (const chunk of upstream.body) res.write(chunk);
            }
            res.end();
        } catch (error) {
            if (!res.headersSent) {
                res.statusCode = 502;
                res.end("proxy error");
            } else {
                res.destroy(error instanceof Error ? error : undefined);
            }
        } finally {
            clearTimeout(timer);
        }
    };
    return {
        name: "ai-proxy",
        configureServer(server) {
            server.middlewares.use("/api/ai-proxy", handler);
        },
        configurePreviewServer(server) {
            server.middlewares.use("/api/ai-proxy", handler);
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), localFetchProxy(), aiProxy()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
