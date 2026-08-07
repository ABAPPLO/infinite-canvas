import axios from "axios";

const AI_PROXY_PATH = "/api/ai-proxy";

/**
 * 开发环境下把绝对 http(s) 地址改走 Vite 开发服务器的同源代理
 * （vite.config.ts 的 aiProxy），避免浏览器直连命中提供商未开 CORS 的接口。
 * 生产构建（import.meta.env.DEV 为 false）下原样返回。
 */
export function aiProxyUrl(url: string): string {
    if (!import.meta.env.DEV) return url;
    if (!/^https?:/i.test(url)) return url;
    return `${AI_PROXY_PATH}?target=${encodeURIComponent(url)}`;
}

let installed = false;

/** 注册 axios 全局拦截器：dev 下把 AI 请求 URL 改走同源代理，params 合并进目标 URL。 */
export function installAiProxy() {
    if (installed) return;
    installed = true;
    axios.interceptors.request.use((config) => {
        if (typeof config.url !== "string" || !/^https?:/i.test(config.url)) return config;
        let target = config.url;
        if (config.params && typeof config.params === "object") {
            const merged = new URL(target);
            for (const [key, value] of Object.entries(config.params)) {
                if (value === undefined) continue;
                if (Array.isArray(value)) value.forEach((item) => merged.searchParams.append(key, String(item)));
                else merged.searchParams.set(key, String(value));
            }
            target = merged.toString();
            config.params = undefined;
        }
        config.url = aiProxyUrl(target);
        return config;
    });
}

/** 原生 fetch（SSE 流式等）同样走开发代理。 */
export function aiFetch(input: string, init?: RequestInit) {
    return fetch(aiProxyUrl(input), init);
}
