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
    const readBody = (req: IncomingMessage) =>
        new Promise<Buffer>((resolveBody, reject) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk) => chunks.push(chunk));
            req.on("end", () => resolveBody(Buffer.concat(chunks)));
            req.on("error", reject);
        });
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

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), localFetchProxy()],
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
