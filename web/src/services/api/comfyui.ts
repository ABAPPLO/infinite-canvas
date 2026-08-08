import axios from "axios";

import i18n from "@/i18n";
import type { ComfyuiIoMapping, ComfyuiModelMeta } from "@/stores/use-config-store";

/** Same-origin ComfyUI call: route through the Vite dev proxy with the real address in a header. */
async function comfyuiRequest<T = unknown>(target: string, method: "get" | "post", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const url = path.startsWith("http") ? path : `/comfyui${path.startsWith("/") ? path : `/${path}`}`;
    const response = await axios.request<T>({
        method,
        url,
        data: method === "post" ? body : undefined,
        headers: { "x-comfyui-target": target, ...(body !== undefined && !(typeof FormData !== "undefined" && body instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
        responseType: method === "get" && path.includes("/view") ? "blob" : "json",
        signal,
    });
    return response.data;
}

export type ComfyuiObjectInfo = Record<string, { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>;

const objectInfoCache = new Map<string, ComfyuiObjectInfo>();

/** Fetch and cache /object_info for a target. Cache is keyed by the real ComfyUI address. */
export async function getObjectInfo(target: string, signal?: AbortSignal): Promise<ComfyuiObjectInfo> {
    const key = target.trim();
    const cached = objectInfoCache.get(key);
    if (cached) return cached;
    const data = await comfyuiRequest<ComfyuiObjectInfo>(target, "get", "/object_info", undefined, signal);
    objectInfoCache.set(key, data);
    return data;
}

// Re-exported so the IO modal and callers share one type source.
export type { ComfyuiIoMapping, ComfyuiModelMeta };
