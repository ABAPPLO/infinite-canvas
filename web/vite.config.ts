import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import httpProxy from "http-proxy";
import { defineConfig, loadEnv, type Plugin } from "vite";

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

// Forwards same-origin /comfyui/* to the real ComfyUI address taken from the
// x-comfyui-target request header (= the channel baseUrl filled in the UI), so the
// browser never makes a cross-origin call to ComfyUI. Changing the address in the UI
// takes effect immediately — no dev-server restart. COMFYUI_URL is only a fallback.
function comfyuiDynamicProxy(fallbackTarget: string): Plugin {
    const proxy = httpProxy.createProxyServer();
    return {
        name: "comfyui-dynamic-proxy",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = req.url || "";
                if (!url.startsWith("/comfyui")) return next();
                const target = String(req.headers["x-comfyui-target"] || fallbackTarget || "http://localhost:8188").trim();
                if (!/^https?:\/\//i.test(target)) {
                    res.statusCode = 400;
                    res.end("Missing or invalid x-comfyui-target header");
                    return;
                }
                req.url = url.replace(/^\/comfyui/, "") || "/";
                proxy.web(req, res, { target, changeOrigin: true }, (error) => {
                    res.statusCode = 502;
                    res.end(`ComfyUI proxy error: ${error.message}`);
                });
            });
        },
    };
}

export default defineConfig(({ mode }) => {
    // ComfyUI address is configured in web/.env.local as COMFYUI_URL (never hardcoded here).
    // The browser calls same-origin /comfyui/*; Vite forwards each request to COMFYUI_URL,
    // which sidesteps the browser CORS restriction entirely.
    const env = loadEnv(mode, webDir, "");
    const comfyuiUrl = (env.COMFYUI_URL || "http://localhost:8188").trim();

    return {
        base: process.env.VITE_BASE || "/",
        plugins: [react(), localPluginsManifest(), comfyuiDynamicProxy(comfyuiUrl)],
        resolve: {
            alias: {
                "@": resolve(webDir, "src"),
            },
        },
        define: {
            __APP_VERSION__: JSON.stringify(localVersion),
            __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
        },
    };
});
