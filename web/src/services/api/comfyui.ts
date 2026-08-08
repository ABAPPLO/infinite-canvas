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

export type WorkflowFormat = "prompt" | "graph";

/** ComfyUI saves two JSON shapes. Prompt/API format is directly submittable; graph format must be converted. */
export function detectWorkflowFormat(json: unknown): WorkflowFormat {
    if (json && typeof json === "object" && Array.isArray((json as any).nodes)) return "graph";
    if (json && typeof json === "object") {
        const values = Object.values(json as Record<string, unknown>);
        if (values.length && values.every((v) => v && typeof v === "object" && "class_type" in (v as object) && "inputs" in (v as object))) return "prompt";
    }
    throw new Error(i18n.t("config.comfyui.invalidWorkflowJson"));
}

type GraphNode = { id: number; type: string; inputs?: Array<{ name: string; link: number | null }>; widgets_values?: unknown[] };
type GraphJson = { nodes?: GraphNode[]; links?: Array<[number, number, number, number, number, string]> };

/** Names of widget (non-connection) inputs for a node type, in object_info order (required then optional). */
function widgetInputNames(def: ComfyuiObjectInfo[string] | undefined, slotNames: Set<string>): string[] {
    const names: string[] = [];
    for (const group of [def?.input?.required, def?.input?.optional]) {
        if (!group) continue;
        for (const name of Object.keys(group)) {
            if (!slotNames.has(name)) names.push(name); // slots are connection inputs; the rest are widgets
        }
    }
    return names;
}

export type ConvertResult = { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>; errors: string[] };

/**
 * Convert a ComfyUI graph-format workflow to prompt/API format using object_info.
 * Best-effort: exotic/custom nodes whose widget order we can't determine are reported in `errors`
 * (the caller then falls back to manual API-format import).
 */
export function convertGraphToPrompt(graph: GraphJson, objectInfo: ComfyuiObjectInfo): ConvertResult {
    const linkMap = new Map<number, [number, number]>();
    for (const link of graph.links || []) linkMap.set(link[0], [link[1], link[2]]); // linkId -> [originNodeId, originSlot]

    const prompt: ConvertResult["prompt"] = {};
    const errors: string[] = [];

    for (const node of graph.nodes || []) {
        const def = objectInfo[node.type];
        if (!def) {
            errors.push(i18n.t("config.comfyui.unknownNodeType", { id: node.id, type: node.type }));
            continue;
        }
        const inputs: Record<string, unknown> = {};
        const slotNames = new Set((node.inputs || []).map((slot) => slot.name));

        // Connection inputs: resolve each wired slot to [originNodeId, originSlot].
        for (const slot of node.inputs || []) {
            if (slot.link == null) continue;
            const origin = linkMap.get(slot.link);
            if (origin) inputs[slot.name] = [String(origin[0]), origin[1]];
        }

        // Widget inputs: map widgets_values positionally onto widget input names (object_info order).
        const widgetNames = widgetInputNames(def, slotNames);
        const widgetValues = Array.isArray(node.widgets_values) ? node.widgets_values : [];
        if (widgetValues.length < widgetNames.length) {
            errors.push(i18n.t("config.comfyui.widgetCountMismatch", { id: node.id, type: node.type }));
        }
        widgetNames.forEach((name, index) => {
            if (index < widgetValues.length && !(name in inputs)) inputs[name] = widgetValues[index];
        });

        prompt[String(node.id)] = { class_type: node.type, inputs };
    }
    return { prompt, errors };
}
