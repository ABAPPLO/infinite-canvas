import { useAgentStore } from "@/stores/use-agent-store";

/**
 * 把 string/Blob 输入统一解析成 Blob。
 * 远程 http(s) URL 在 canvas-agent 已连接时走本地代理 `/agent/fetch`，
 * 避免浏览器直连命中 CORS；代理不可用时退回直连（跨域时可能失败，保持旧行为）。
 * `data:` / `blob:` 与 Blob 直接 fetch/原样返回。
 */
export async function fetchBlob(input: string | Blob): Promise<Blob> {
    if (input instanceof Blob) return input;
    if (input.startsWith("data:") || input.startsWith("blob:")) return (await fetch(input)).blob();
    if (/^https?:/i.test(input)) {
        const { url, token, connected } = useAgentStore.getState();
        if (connected && token && url) {
            const endpoint = url.trim().replace(/\/$/, "");
            try {
                const res = await fetch(`${endpoint}/agent/fetch?token=${encodeURIComponent(token)}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ url: input }),
                });
                if (res.ok) return await res.blob();
            } catch {
                /* 代理不可用，落到直连 */
            }
        }
        return (await fetch(input)).blob();
    }
    return (await fetch(input)).blob();
}
