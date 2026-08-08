# ComfyUI Protocol Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ComfyUI a first-class `apiFormat` ("comfyui") in infinite-canvas, so a user can point a channel at a ComfyUI instance, pick a workflow as a "model", map its IO nodes, and generate images through it.

**Architecture:** A dynamic Vite dev-proxy middleware forwards same-origin `/comfyui/*` requests to the real ComfyUI address (read from the `x-comfyui-target` header = the channel's `baseUrl`), bypassing browser CORS. Workflows are normalized to ComfyUI **Prompt/API format** (Graph format is converted via `/object_info`). Each comfyui model stores its `promptJson` + an IO-node mapping; generation injects the prompt/reference into the mapped nodes, POSTs `/prompt`, polls `/history`, and fetches results via `/view`.

**Tech Stack:** React 19, Vite 7, TypeScript 5 (strict), Ant Design 6, lucide-react, axios, Zustand (persisted), react-i18next. ComfyUI 0.30.2.

## Global Constraints

Copied verbatim/inferred from the approved spec (`docs/superpowers/specs/2026-08-09-comfyui-protocol-design.md`):

- The ComfyUI real address is supplied at runtime via the UI (channel `baseUrl`); it is **never hardcoded** in source. It travels in the `x-comfyui-target` request header.
- The browser **never** calls ComfyUI directly (no CORS headers). Every ComfyUI call goes through same-origin `/comfyui/*` + `x-comfyui-target` header.
- Internal workflow format is **Prompt/API format** (`{ nodeId: { class_type, inputs } }`). Graph-format workflows are converted before use; conversion is best-effort and failures fall back to manual API-format import.
- `apiKey` is **optional** for comfyui channels (ComfyUI commonly has no auth). Channel readiness for comfyui = model + baseUrl present.
- **Dev-only**: the proxy exists only under `bun run dev`. Production static builds are not required to support ComfyUI.
- **No test framework exists.** Verify each task with `bun run typecheck` (run `bun install` in `web/` first — missing deps create fake type errors) and, where behavior is involved, `bun run build` plus a manual browser check against the running dev server (http://localhost:3001) and ComfyUI (http://10.168.1.109:8188). There are no unit-test steps.
- Follow existing patterns: Ant Design components, `lucide-react` icons, `useTranslation()` (`t(...)`) for all strings, and add every new i18n key to **both** `web/src/i18n/locales/zh-CN.ts` and `web/src/i18n/locales/en-US.ts`.
- One commit per task, on `main` (this repo's working branch; user commits directly to main).

---

## File Structure

| File | Responsibility | Status |
|------|----------------|--------|
| `web/src/services/api/comfyui.ts` | All ComfyUI transport + logic: same-origin request layer, `/object_info` cache, format detect, Graph→Prompt conversion, IO-node parsing, workflow fetch/import, `runComfyui` (inject→/prompt→poll→/view). Pure module, no React. | NEW |
| `web/src/stores/use-config-store.ts` | Add `"comfyui"` to `ApiCallFormat`; add `ComfyuiIoSlot`/`ComfyuiIoMapping`/`ComfyuiModelMeta` and `ChannelModel.comfyui`; extend `defaultBaseUrlForApiFormat`/`normalizeApiFormat`; relax `isAiConfigReady` for comfyui; export `resolveChannelModelEntry`. | MODIFY |
| `web/vite.config.ts` | Replace static `/comfyui` proxy with a `comfyuiDynamicProxy()` middleware plugin that reads `x-comfyui-target` per request. | MODIFY |
| `web/package.json` | Add runtime dep `http-proxy` and devDep `@types/http-proxy`. | MODIFY |
| `web/src/services/api/image.ts` | Add `apiFormat === "comfyui"` branches to `requestGeneration` and `requestEdit`. | MODIFY |
| `web/src/components/layout/comfyui-io-modal.tsx` | IO-node selection Modal: parse `promptJson`, let user map prompt/negative/reference/size/seed/output, save `ComfyuiIoMapping`. | NEW |
| `web/src/components/layout/channel-editor-drawer.tsx` | Add comfyui protocol option; hide apiKey requirement; replace per-model "脚本" button with "输入输出节点" for comfyui; wire comfyui model meta through selection. | MODIFY |
| `web/src/components/layout/model-select-modal.tsx` | Comfyui branch: fetch workflow list (carry `promptJson`), offer JSON import, confirm with full `ChannelModel[]`. | MODIFY |
| `web/src/i18n/locales/zh-CN.ts`, `en-US.ts` | New keys for comfyui protocol, IO modal, import/fetch. | MODIFY |
| `web/.env.example`, `web/.env.local` | Update `COMFYUI_URL` comment to "header fallback default". | MODIFY |

---

### Task 1: Config-store types and helpers

**Files:**
- Modify: `web/src/stores/use-config-store.ts`

**Interfaces:**
- Produces: `ApiCallFormat` now includes `"comfyui"`; `ComfyuiIoSlot`, `ComfyuiIoMapping`, `ComfyuiModelMeta` types; `ChannelModel.comfyui?`; `defaultBaseUrlForApiFormat("comfyui") === "http://localhost:8188"`; `normalizeApiFormat` accepts `"comfyui"`; `isAiConfigReady` returns true for comfyui without apiKey; `resolveChannelModelEntry(config, value)` exported.

- [ ] **Step 1: Extend `ApiCallFormat` and add comfyui types**

In `web/src/stores/use-config-store.ts`, change line 8 and add types after `ChannelModel` (around line 16):

```ts
export type ApiCallFormat = "openai" | "gemini" | "ark" | "comfyui";
```

```ts
// An IO injection point: which node, and which input on that node.
export type ComfyuiIoSlot = { node: string; input: string };

export type ComfyuiIoMapping = {
    promptText: ComfyuiIoSlot;        // positive prompt, e.g. { node: "<CLIPTextEncode id>", input: "text" }
    negativeText?: ComfyuiIoSlot;     // optional negative prompt
    referenceImage?: ComfyuiIoSlot;   // image-to-image source, e.g. { node: "<LoadImage id>", input: "image" }
    width?: ComfyuiIoSlot;            // e.g. { node: "<EmptyLatentImage id>", input: "width" }
    height?: ComfyuiIoSlot;
    seed?: ComfyuiIoSlot;             // e.g. { node: "<KSampler id>", input: "seed" }
    outputNode: string;               // bare node id to read results from, e.g. "<SaveImage id>"
};

export type ComfyuiModelMeta = {
    promptJson: Record<string, any>;  // Prompt/API-format workflow
    io: Partial<ComfyuiIoMapping>;    // filled by the IO modal; partial until configured
    source?: "server" | "import";
};
```

Extend `ChannelModel`:

```ts
export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    script?: string;
    comfyui?: ComfyuiModelMeta;       // present only for comfyui channels
};
```

- [ ] **Step 2: Make comfyui a recognized format in defaults/normalize**

Edit `defaultBaseUrlForApiFormat` (line ~373):

```ts
const COMFYUI_BASE_URL = "http://localhost:8188";

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return GEMINI_BASE_URL;
    if (apiFormat === "ark") return ARK_BASE_URL;
    if (apiFormat === "comfyui") return COMFYUI_BASE_URL;
    return OPENAI_BASE_URL;
}
```

Edit `normalizeApiFormat` (line ~379) to preserve comfyui:

```ts
function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" || apiFormat === "ark" || apiFormat === "comfyui" ? apiFormat : "openai";
}
```

- [ ] **Step 3: Relax readiness for comfyui (apiKey optional)**

Edit `isAiConfigReady` (line ~184):

```ts
function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    const hasBaseUrl = Boolean(channel.baseUrl.trim());
    if (channel.apiFormat === "comfyui") return Boolean(model.trim()) && hasBaseUrl;
    return Boolean(model.trim() && hasBaseUrl && channel.apiKey.trim());
}
```

- [ ] **Step 4: Export a helper to fetch a model entry (with comfyui meta)**

Add near the other `resolve*` exports (after `resolveModelRequestConfig`, line ~346):

```ts
/** Resolve the channel + ChannelModel (including comfyui meta) for a `channelId::model` value. */
export function resolveChannelModelEntry(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    return findChannelModel(config, value);
}
```

(`findChannelModel` already exists as a private function at line ~149; this just exposes it.)

- [ ] **Step 5: Typecheck**

Run: `cd web && bun install && bun run typecheck`
Expected: PASS (no errors). The new `"comfyui"` literal will not create errors elsewhere: the `apiFormat` switches in `image.ts` use default fallthroughs rather than exhaustive checks, so adding a union member is type-safe.

- [ ] **Step 6: Commit**

```bash
git add web/src/stores/use-config-store.ts
git commit -m "feat(config): add comfyui apiFormat, model meta types, and relaxed readiness"
```

---

### Task 2: Dynamic Vite proxy middleware

**Files:**
- Modify: `web/package.json`
- Modify: `web/vite.config.ts`

**Interfaces:**
- Produces: dev server forwards same-origin `/comfyui/*` (path stripped) to the URL in the `x-comfyui-target` request header (falling back to `COMFYUI_URL` env, then `http://localhost:8188`), with `changeOrigin: true`. No restart needed when the UI address changes.

- [ ] **Step 1: Add the http-proxy dependency**

Run: `cd web && bun add http-proxy && bun add -d @types/http-proxy`

Expected: `web/package.json` gains `"http-proxy"` under dependencies and `"@types/http-proxy"` under devDependencies.

- [ ] **Step 2: Replace the static proxy with a dynamic middleware plugin**

In `web/vite.config.ts`, add the import at the top (after the `vite` import, line 5):

```ts
import httpProxy from "http-proxy";
```

Add this function below `localPluginsManifest()` (before `export default defineConfig`):

```ts
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
```

In the returned config object, add `comfyuiDynamicProxy(comfyuiUrl)` to the `plugins` array and **delete** the entire `server: { proxy: {...} }` block. Keep the `loadEnv`/`comfyuiUrl` lines above — `comfyuiUrl` is now the fallback target passed into the plugin. The returned object keeps `base`, `plugins` (now `[react(), localPluginsManifest(), comfyuiDynamicProxy(comfyuiUrl)]`), `resolve`, `define`.

- [ ] **Step 3: Verify the dev server picks up the change**

The dev server (running in background) auto-restarts on config change. Check its log shows `[vite] server restarted` with no `loadConfig` error.

- [ ] **Step 4: Manually verify the proxy forwards + reads the header**

In a terminal:

```bash
curl -si -H "x-comfyui-target: http://10.168.1.109:8188" http://localhost:3001/comfyui/system_stats | head -20
```

Expected: HTTP 200 and a JSON body with `system` info from ComfyUI. If you get 502, ComfyUI isn't reachable from this machine; if you get the Vite HTML page, the middleware didn't intercept (check the `/comfyui` prefix match).

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/vite.config.ts
git commit -m "feat(proxy): dynamic ComfyUI dev proxy reading x-comfyui-target header"
```

---

### Task 3: ComfyUI request layer + `/object_info` cache

**Files:**
- Create: `web/src/services/api/comfyui.ts`

**Interfaces:**
- Produces: `comfyuiRequest(target, method, path, body?, signal?)` (same-origin `/comfyui` + header), `getObjectInfo(target, signal?)` (cached per target), and the module-level type re-exports needed by later tasks.

- [ ] **Step 1: Create the module with the request layer and object_info cache**

Create `web/src/services/api/comfyui.ts`:

```ts
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
```

- [ ] **Step 2: Typecheck**

Run: `cd web && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/services/api/comfyui.ts
git commit -m "feat(comfyui): add same-origin request layer and object_info cache"
```

---

### Task 4: Format detection + Graph→Prompt conversion

**Files:**
- Modify: `web/src/services/api/comfyui.ts`

**Interfaces:**
- Consumes: `getObjectInfo` (Task 3).
- Produces: `detectWorkflowFormat(json)`, `convertGraphToPrompt(graph, objectInfo)`.

- [ ] **Step 1: Add format detection**

Append to `web/src/services/api/comfyui.ts`:

```ts
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
```

- [ ] **Step 2: Add Graph→Prompt conversion**

Append:

```ts
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
        widgetNames.forEach((name, index) => {
            if (index < widgetValues.length && !(name in inputs)) inputs[name] = widgetValues[index];
        });

        prompt[String(node.id)] = { class_type: node.type, inputs };
    }
    return { prompt, errors };
}
```

- [ ] **Step 3: Typecheck**

Run: `cd web && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/services/api/comfyui.ts
git commit -m "feat(comfyui): workflow format detection and graph-to-prompt conversion"
```

---

### Task 5: IO-node candidate parsing

**Files:**
- Modify: `web/src/services/api/comfyui.ts`

**Interfaces:**
- Produces: `parseComfyuiPromptNodes(promptJson)` → candidates object + a sensible default `Partial<ComfyuiIoMapping>`.

- [ ] **Step 1: Add node parsing**

Append to `web/src/services/api/comfyui.ts`:

```ts
export type ComfyuiNodeCandidates = {
    textInputs: Array<{ id: string; classType: string; input: string }>;   // candidate prompt slots (string-literal inputs)
    referenceImages: Array<{ id: string; input: string }>;                 // LoadImage nodes
    width: Array<{ id: string; input: string }>;
    height: Array<{ id: string; input: string }>;
    seed: Array<{ id: string; input: string }>;
    outputs: Array<{ id: string; classType: string; capability: "image" | "video" | "audio" }>;
};

const IMAGE_OUTPUT_TYPES = new Set(["SaveImage", "PreviewImage"]);
const VIDEO_OUTPUT_TYPES = new Set(["SaveAnimatedPNG", "VHS_VideoCombine", "SaveWEBM"]);
const AUDIO_OUTPUT_TYPES = new Set(["SaveAudio", "PreviewAudio"]);
const LATENT_TYPES = new Set(["EmptyLatentImage", "EmptySD3LatentImage", "EmptyHunyuanLatentVideo"]);

function capabilityForOutput(classType: string): "image" | "video" | "audio" | undefined {
    if (IMAGE_OUTPUT_TYPES.has(classType)) return "image";
    if (VIDEO_OUTPUT_TYPES.has(classType)) return "video";
    if (AUDIO_OUTPUT_TYPES.has(classType)) return "audio";
    return undefined;
}

/** Extract IO candidates from a prompt-format workflow and suggest a default mapping. */
export function parseComfyuiPromptNodes(promptJson: Record<string, { class_type: string; inputs: Record<string, unknown> }>): { candidates: ComfyuiNodeCandidates; defaults: Partial<ComfyuiIoMapping> } {
    const candidates: ComfyuiNodeCandidates = { textInputs: [], referenceImages: [], width: [], height: [], seed: [], outputs: [] };
    const textById: Record<string, { id: string; classType: string; input: string }> = {};

    for (const [id, node] of Object.entries(promptJson)) {
        const classType = node.class_type;
        const inputs = node.inputs || {};
        // String-literal inputs are prompt candidates (CLIPTextEncode.text is the common case).
        for (const [input, value] of Object.entries(inputs)) {
            if (typeof value === "string") {
                const entry = { id, classType, input };
                candidates.textInputs.push(entry);
                if (input === "text") textById[id] = entry;
            }
        }
        if (classType === "LoadImage") candidates.referenceImages.push({ id, input: "image" });
        if (LATENT_TYPES.has(classType)) {
            if ("width" in inputs) candidates.width.push({ id, input: "width" });
            if ("height" in inputs) candidates.height.push({ id, input: "height" });
        }
        if (classType === "KSampler" || classType === "KSamplerAdvanced") {
            if ("seed" in inputs) candidates.seed.push({ id, input: "seed" });
        }
        const capability = capabilityForOutput(classType);
        if (capability) candidates.outputs.push({ id, classType, capability });
    }

    // Defaults: first CLIPTextEncode-style text node; first latent size; first seed; first image output.
    const positive = Object.values(textById)[0] || candidates.textInputs[0];
    const defaults: Partial<ComfyuiIoMapping> = {};
    if (positive) defaults.promptText = { node: positive.id, input: positive.input };
    if (candidates.width.length) defaults.width = candidates.width[0];
    if (candidates.height.length) defaults.height = candidates.height[0];
    if (candidates.seed.length) defaults.seed = candidates.seed[0];
    const firstImageOutput = candidates.outputs.find((o) => o.capability === "image");
    if (firstImageOutput) defaults.outputNode = firstImageOutput.id;
    return { candidates, defaults };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/services/api/comfyui.ts
git commit -m "feat(comfyui): parse IO node candidates from prompt-format workflows"
```

---

### Task 6: Workflow fetch (server list) + import

**Files:**
- Modify: `web/src/services/api/comfyui.ts`

**Interfaces:**
- Consumes: `convertGraphToPrompt`, `detectWorkflowFormat`, `getObjectInfo`.
- Produces: `fetchComfyuiWorkflows(target, signal)`, `importComfyuiWorkflow(jsonString, objectInfo)`.

- [ ] **Step 1: Add the server-list fetcher**

Append to `web/src/services/api/comfyui.ts`:

```ts
export type ComfyuiWorkflowSummary = { name: string; promptJson: Record<string, any>; ok: boolean; reason?: string; source?: "server" | "import" };

type UserdataEntry = { path?: string; name?: string; type?: string };

/**
 * Fetch all workflows from ComfyUI's server-side workflow list (userdata/workflows).
 * Each graph-format file is converted to prompt format. Throws a specific error if the list API is
 * unavailable or empty, so the UI can fall back to manual JSON import.
 */
export async function fetchComfyuiWorkflows(target: string, signal?: AbortSignal): Promise<ComfyuiWorkflowSummary[]> {
    const list = await comfyuiRequest<UserdataEntry[]>(target, "get", "/api/userdata/workflows?recurse=true", undefined, signal);
    const files = (Array.isArray(list) ? list : []).filter((entry) => (entry.path || entry.name || "").endsWith(".json"));
    if (!files.length) throw new Error(i18n.t("config.comfyui.noServerWorkflows"));

    const objectInfo = await getObjectInfo(target, signal);
    const results: ComfyuiWorkflowSummary[] = [];
    for (const entry of files) {
        const filePath = entry.path || entry.name || "";
        const name = filePath.replace(/^workflows\//, "").replace(/\.json$/, "");
        try {
            const raw = await comfyuiRequest<unknown>(target, "get", `/api/userdata/${filePath}`, undefined, signal);
            const format = detectWorkflowFormat(raw);
            const promptJson = format === "prompt" ? (raw as Record<string, any>) : convertGraphToPrompt(raw as GraphJson, objectInfo).prompt;
            results.push({ name, promptJson, ok: Object.keys(promptJson).length > 0, source: "server" });
        } catch (error) {
            results.push({ name, promptJson: {}, ok: false, reason: error instanceof Error ? error.message : String(error), source: "server" });
        }
    }
    return results;
}
```

- [ ] **Step 2: Add the import path (used by the UI's import button)**

Append:

```ts
/** Import a pasted/uploaded workflow JSON. Auto-detects format; converts graph format using objectInfo. */
export async function importComfyuiWorkflow(jsonString: string, objectInfo: ComfyuiObjectInfo): Promise<ComfyuiWorkflowSummary> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonString);
    } catch {
        throw new Error(i18n.t("config.comfyui.invalidWorkflowJson"));
    }
    const format = detectWorkflowFormat(parsed);
    if (format === "prompt") return { name: i18n.t("config.comfyui.importedWorkflow"), promptJson: parsed as Record<string, any>, ok: true, source: "import" };
    const { prompt, errors } = convertGraphToPrompt(parsed as GraphJson, objectInfo);
    if (errors.length) {
        // Still usable if conversion produced nodes, but surface the warning via ok=false so the UI can hint.
        return { name: i18n.t("config.comfyui.importedWorkflow"), promptJson: prompt, ok: Object.keys(prompt).length > 0, reason: errors.join("; "), source: "import" };
    }
    return { name: i18n.t("config.comfyui.importedWorkflow"), promptJson: prompt, ok: true, source: "import" };
}
```

- [ ] **Step 3: Typecheck**

Run: `cd web && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/services/api/comfyui.ts
git commit -m "feat(comfyui): fetch server workflow list and import workflow JSON"
```

---

### Task 7: `runComfyui` — inject, submit, poll, fetch

**Files:**
- Modify: `web/src/services/api/comfyui.ts`

**Interfaces:**
- Consumes: `ComfyuiIoMapping`, `ComfyuiModelMeta` (from config-store).
- Produces: `runComfyui({ target, meta, prompt, negativePrompt?, referenceDataUrl?, size?, signal })` → `Promise<string[]>` (data URLs).

- [ ] **Step 1: Add upload + view helpers**

Append to `web/src/services/api/comfyui.ts`:

```ts
type ComfyuiOutputImage = { filename: string; subfolder?: string; type?: string };

/** Upload a reference image (data URL) to ComfyUI and return the upload response {name, subfolder, type}. */
async function uploadImage(target: string, dataUrl: string, signal?: AbortSignal): Promise<{ name: string; subfolder: string; type: string }> {
    const blob = await (await fetch(dataUrl)).blob();
    const form = new FormData();
    form.append("image", blob, "reference.png");
    const result = await comfyuiRequest<{ name: string; subfolder: string; type: string }>(target, "post", "/upload/image", form, signal);
    return { name: result.name, subfolder: result.subfolder || "", type: result.type || "input" };
}

/** Fetch a generated image blob from /view and convert to a data URL. */
async function fetchView(target: string, image: ComfyuiOutputImage, signal?: AbortSignal): Promise<string> {
    const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" });
    const blob = await comfyuiRequest<Blob>(target, "get", `/view?${params.toString()}`, undefined, signal);
    return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error(i18n.t("config.comfyui.viewFailed")));
        reader.readAsDataURL(blob);
    });
}
```

- [ ] **Step 2: Add the submission + polling + orchestrator**

Append:

```ts
const COMFYUI_CLIENT_ID = `infinite-canvas-${Math.random().toString(36).slice(2)}`;

function setNodeInput(graph: Record<string, any>, slot: { node: string; input: string } | undefined, value: unknown) {
    if (!slot) return;
    const node = graph[slot.node];
    if (node) node.inputs[slot.input] = value;
}

// ComfyUI 0.30 made some inputs required (e.g. SaveImage.filename_prefix). Patch known required defaults.
function patchRequiredDefaults(graph: Record<string, any>) {
    for (const node of Object.values(graph) as Array<any>) {
        if (node.class_type === "SaveImage" && node.inputs.filename_prefix === undefined) node.inputs.filename_prefix = "infinite_canvas";
    }
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    });
}

export type RunComfyuiArgs = {
    target: string;
    meta: ComfyuiModelMeta;
    prompt: string;
    negativePrompt?: string;
    referenceDataUrl?: string;
    size?: { width?: number; height?: number };
    signal?: AbortSignal;
};

/**
 * Run a comfyui workflow: inject prompt/reference/seed into the mapped nodes, submit /prompt,
 * poll /history until the output node is ready, then fetch each result via /view.
 */
export async function runComfyui(args: RunComfyuiArgs): Promise<string[]> {
    const { target, meta, signal } = args;
    const io = meta.io;
    if (!io.promptText) throw new Error(i18n.t("config.comfyui.promptNodeNotConfigured"));
    if (!io.outputNode) throw new Error(i18n.t("config.comfyui.outputNodeNotConfigured"));

    const graph = JSON.parse(JSON.stringify(meta.promptJson)) as Record<string, any>;
    setNodeInput(graph, io.promptText, args.prompt);
    if (io.negativeText && args.negativePrompt !== undefined) setNodeInput(graph, io.negativeText, args.negativePrompt);
    if (io.seed) setNodeInput(graph, io.seed, Math.floor(Math.random() * 1_000_000_000_000));
    if (io.width && args.size?.width) setNodeInput(graph, io.width, args.size.width);
    if (io.height && args.size?.height) setNodeInput(graph, io.height, args.size.height);
    if (io.referenceImage && args.referenceDataUrl) {
        const uploaded = await uploadImage(target, args.referenceDataUrl, signal);
        setNodeInput(graph, io.referenceImage, uploaded.name);
    }
    patchRequiredDefaults(graph);

    const submit = await comfyuiRequest<{ prompt_id: string }>(target, "post", "/prompt", { prompt: graph, client_id: COMFYUI_CLIENT_ID }, signal);
    const promptId = submit.prompt_id;

    const deadline = Date.now() + 300_000;
    for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const history = await comfyuiRequest<Record<string, { outputs?: Record<string, { images?: ComfyuiOutputImage[]; gifs?: ComfyuiOutputImage[] }>; status?: { completed?: boolean } }>>(target, "get", `/history/${promptId}`, undefined, signal);
        const entry = history[promptId];
        if (entry?.status?.completed) {
            const nodeOutput = entry.outputs?.[io.outputNode];
            const images = nodeOutput?.images || nodeOutput?.gifs || [];
            if (!images.length) throw new Error(i18n.t("config.comfyui.noOutput"));
            return Promise.all(images.map((image) => fetchView(target, image, signal)));
        }
        if (Date.now() >= deadline) throw new Error(i18n.t("config.comfyui.pollTimeout"));
        await sleep(1000, signal);
    }
}
```

> Note: `Math.random()` and `Date.now()` are fine here — this runs in the browser app, not inside a workflow `agent()` script (where they are unavailable). `COMFYUI_CLIENT_ID` is evaluated once at module load.

- [ ] **Step 3: Typecheck**

Run: `cd web && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/services/api/comfyui.ts
git commit -m "feat(comfyui): runComfyui — inject, submit /prompt, poll /history, fetch /view"
```

---

### Task 8: Wire ComfyUI into image generation (`image.ts`)

**Files:**
- Modify: `web/src/services/api/image.ts`

**Interfaces:**
- Consumes: `resolveChannelModelEntry`, `resolveModelRequestConfig` (config-store); `runComfyui` (comfyui.ts).
- Produces: `requestGeneration` and `requestEdit` handle `apiFormat === "comfyui"`.

- [ ] **Step 1: Add the comfyui import**

At the top of `web/src/services/api/image.ts`, add (near the other `@/stores/use-config-store` import):

```ts
import { resolveChannelModelEntry } from "@/stores/use-config-store";
import { runComfyui } from "@/services/api/comfyui";
```

- [ ] **Step 2: Add a comfyui branch to `requestGeneration`**

In `requestGeneration` (line ~716), immediately after the `if (script) { ... }` block (after line 738, before the `if (requestConfig.apiFormat === "gemini")` at line 739), insert:

```ts
    if (requestConfig.apiFormat === "comfyui") {
        const entry = resolveChannelModelEntry(config, config.model || config.imageModel);
        if (!entry?.model.comfyui) throw new Error(apiText("requestFailed"));
        try {
            const dataUrls = await runComfyui({ target: requestConfig.baseUrl, meta: entry.model.comfyui, prompt: withSystemPrompt(requestConfig, prompt), signal: options?.signal });
            return dataUrls.map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
```

- [ ] **Step 3: Add a comfyui branch to `requestEdit` (image-to-image)**

In `requestEdit` (line ~774), immediately after its `if (script) { ... }` block (after line 798, before `if (requestConfig.apiFormat === "gemini")` at line 799), insert:

```ts
    if (requestConfig.apiFormat === "comfyui") {
        const entry = resolveChannelModelEntry(config, config.model || config.imageModel);
        if (!entry?.model.comfyui) throw new Error(apiText("requestFailed"));
        const referenceDataUrl = references.length ? await imageToDataUrl(references[0]) : undefined;
        try {
            const dataUrls = await runComfyui({ target: requestConfig.baseUrl, meta: entry.model.comfyui, prompt: withSystemPrompt(requestConfig, requestPrompt), referenceDataUrl, signal: options?.signal });
            return dataUrls.map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
```

- [ ] **Step 4: Typecheck**

Run: `cd web && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/services/api/image.ts
git commit -m "feat(image): route comfyui channels through runComfyui for generation and edit"
```

---

### Task 9: IO-node selection Modal

**Files:**
- Create: `web/src/components/layout/comfyui-io-modal.tsx`

**Interfaces:**
- Consumes: `parseComfyuiPromptNodes`, `ComfyuiIoMapping`/`ComfyuiModelMeta` types, `ModelCapability`.
- Produces: `ComfyuiIoModal({ open, promptJson, capability, initial, onSave, onClose })`.

- [ ] **Step 1: Create the modal component**

Create `web/src/components/layout/comfyui-io-modal.tsx`:

```tsx
import { Modal, Select, Space, Typography } from "antd";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { parseComfyuiPromptNodes } from "@/services/api/comfyui";
import type { ComfyuiIoMapping, ModelCapability } from "@/stores/use-config-store";

type Props = {
    open: boolean;
    promptJson: Record<string, any>;
    capability: ModelCapability;
    initial: Partial<ComfyuiIoMapping>;
    onSave: (mapping: ComfyuiIoMapping) => void;
    onClose: () => void;
};

const SLOT_UNDEFINED = "__none__";

export function ComfyuiIoModal({ open, promptJson, capability, initial, onSave, onClose }: Props) {
    const { t } = useTranslation();
    const { candidates, defaults } = useMemo(() => parseComfyuiPromptNodes(promptJson), [promptJson]);
    const [value, setValue] = useState<ComfyuiIoMapping>(() => ({
        promptText: initial.promptText || defaults.promptText || { node: "", input: "text" },
        negativeText: initial.negativeText,
        referenceImage: initial.referenceImage,
        width: initial.width || defaults.width,
        height: initial.height || defaults.height,
        seed: initial.seed || defaults.seed,
        outputNode: initial.outputNode || defaults.outputNode || candidates.outputs[0]?.id || "",
    }));
    const patch = (partial: Partial<ComfyuiIoMapping>) => setValue((prev) => ({ ...prev, ...partial }));

    const textOptions = candidates.textInputs.map((entry) => ({ label: `${entry.id} · ${entry.classType}.${entry.input}`, value: `${entry.id}::${entry.input}` }));
    const refOptions = candidates.referenceImages.map((entry) => ({ label: `${entry.id} · LoadImage`, value: `${entry.id}::${entry.input}` }));
    const sizeOptions = (list: Array<{ id: string; input: string }>) => list.map((entry) => ({ label: `${entry.id} · ${entry.input}`, value: `${entry.id}::${entry.input}` }));
    const outputOptions = candidates.outputs.filter((o) => o.capability === capability).map((o) => ({ label: `${o.id} · ${o.classType}`, value: o.id }));
    void sizeOptions; // reserved for a future size-mapping panel (P1)

    const decodeSlot = (encoded: string) => {
        const [node, input] = encoded.split("::");
        return { node, input };
    };
    const encodeSlot = (slot?: { node: string; input: string }) => (slot ? `${slot.node}::${slot.input}` : SLOT_UNDEFINED);

    return (
        <Modal open={open} title={t("config.comfyui.ioTitle")} onCancel={onClose} onOk={() => onSave(value)} okText={t("common.save")} cancelText={t("common.cancel")} width={560}>
            <Space direction="vertical" size="middle" className="w-full">
                <Typography.Text type="secondary">{t("config.comfyui.ioHint")}</Typography.Text>
                <Field label={t("config.comfyui.promptNode")}>
                    <Select className="w-full" options={textOptions} value={encodeSlot(value.promptText)} onChange={(v) => patch({ promptText: decodeSlot(v) })} />
                </Field>
                <Field label={t("config.comfyui.negativeNode")}>
                    <Select className="w-full" options={[{ label: t("config.comfyui.none"), value: SLOT_UNDEFINED }, ...textOptions]} value={encodeSlot(value.negativeText)} onChange={(v) => patch({ negativeText: v === SLOT_UNDEFINED ? undefined : decodeSlot(v) })} />
                </Field>
                {capability === "image" && (
                    <Field label={t("config.comfyui.referenceNode")}>
                        <Select className="w-full" options={[{ label: t("config.comfyui.none"), value: SLOT_UNDEFINED }, ...refOptions]} value={encodeSlot(value.referenceImage)} onChange={(v) => patch({ referenceImage: v === SLOT_UNDEFINED ? undefined : decodeSlot(v) })} />
                    </Field>
                )}
                <Field label={t("config.comfyui.outputNode")}>
                    <Select className="w-full" options={outputOptions} value={value.outputNode} onChange={(v) => patch({ outputNode: v })} />
                </Field>
            </Space>
        </Modal>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="block">
            <span className="mb-1 block text-sm font-medium">{label}</span>
            {children}
        </label>
    );
}
```

> The `value` draft lives in `useState`; `patch` merges a partial and triggers a re-render so each `<Select>` (a controlled component) reflects its selection immediately. `onOk` reads the current `value` at click time.

- [ ] **Step 2: Typecheck**

Run: `cd web && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/layout/comfyui-io-modal.tsx
git commit -m "feat(comfyui): IO-node selection modal"
```

---

### Task 10: Channel editor — comfyui protocol + IO button

**Files:**
- Modify: `web/src/components/layout/channel-editor-drawer.tsx`

**Interfaces:**
- Consumes: `ComfyuiIoModal` (Task 9), `ComfyuiIoMapping` type, `ChannelModel`.

> Tasks 10 and 11 share a type (`onConfirmComfyui` prop). Implement them together and run typecheck once at the end of Task 11.

- [ ] **Step 1: Update imports and add the comfyui protocol option**

In `web/src/components/layout/channel-editor-drawer.tsx`, update the import from config-store (line 6) to also bring in `ComfyuiIoMapping`, and add the `ComfyuiIoModal` import (after line 7):

```ts
import { defaultBaseUrlForApiFormat, guessCapability, normalizeChannelModels, type ApiCallFormat, type ChannelModel, type ComfyuiIoMapping, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ComfyuiIoModal } from "./comfyui-io-modal";
```

Append a comfyui entry to `apiFormatOptions` (line 17-21):

```ts
    const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
        { label: "OpenAI", value: "openai" },
        { label: "Gemini", value: "gemini" },
        { label: t("config.protocols.ark"), value: "ark" },
        { label: t("config.protocols.comfyui"), value: "comfyui" },
    ];
```

- [ ] **Step 2: Add IO-modal state + comfyui flag + setter**

After `const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);` (line 16), add:

```ts
    const [ioTarget, setIoTarget] = useState<{ name: string; capability: ModelCapability } | null>(null);
```

After the `if (!draft) return null;` guard (line 28), add:

```ts
    const isComfyui = draft.apiFormat === "comfyui";
```

After `setScript` (line 44), add:

```ts
    const setComfyuiIo = (name: string, io: ComfyuiIoMapping) => setModels(draft.models.map((model) => (model.name === name ? { ...model, comfyui: { ...(model.comfyui || { promptJson: {}, io: {} }), io } } : model)));
```

- [ ] **Step 3: Render the IO button instead of the script button for comfyui models**

Replace the per-model button (lines 106-108) with:

```tsx
                                {isComfyui ? (
                                    <Button
                                        size="small"
                                        type={model.comfyui?.io?.outputNode ? "primary" : "default"}
                                        ghost={Boolean(model.comfyui?.io?.outputNode)}
                                        onClick={() => setIoTarget({ name: model.name, capability: model.capability })}
                                    >
                                        {t(model.comfyui?.io?.outputNode ? "config.channelEditor.ioNodesReady" : "config.channelEditor.ioNodes")}
                                    </Button>
                                ) : (
                                    <Button size="small" type={model.script ? "primary" : "default"} ghost={Boolean(model.script)} onClick={() => setScriptTarget({ name: model.name, capability: model.capability, value: model.script || "" })}>
                                        {t(model.script ? "config.channelEditor.scriptReady" : "config.channelEditor.script")}
                                    </Button>
                                )}
```

- [ ] **Step 4: Hide the API Key field for comfyui**

Replace the API Key block (lines 81-84) with:

```tsx
                {!isComfyui && (
                    <label className="block md:col-span-2">
                        <span className="mb-1 block text-sm font-medium">API Key</span>
                        <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-..." />
                    </label>
                )}
```

- [ ] **Step 5: Preserve comfyui meta on selection**

Replace `applySelection` (line 38-41) with:

```ts
    const applySelection = (names: string[], metas?: Record<string, { promptJson: Record<string, any>; source?: "server" | "import" }>) => {
        const map = new Map(draft.models.map((model) => [model.name, model]));
        setModels(
            names.map((name) => {
                const existing = map.get(name);
                if (existing) return existing;
                const meta = metas?.[name];
                if (isComfyui && meta) return { name, capability: guessCapability(name), comfyui: { promptJson: meta.promptJson, io: {}, source: meta.source } };
                return { name, capability: guessCapability(name) };
            }),
        );
    };
```

Update the `ModelSelectModal` usage (line 118) to pass the comfyui confirm:

```tsx
            <ModelSelectModal
                open={selectOpen}
                channel={draft}
                selectedNames={draft.models.map((model) => model.name)}
                onConfirm={applySelection}
                onConfirmComfyui={(names, metas) => applySelection(names, metas)}
                onClose={() => setSelectOpen(false)}
            />
```

- [ ] **Step 6: Render the IO modal**

Before the closing `</Drawer>` (after the `ModelScriptEditor` block, line 127), add:

```tsx
            {ioTarget && (
                <ComfyuiIoModal
                    open={Boolean(ioTarget)}
                    promptJson={draft.models.find((m) => m.name === ioTarget.name)?.comfyui?.promptJson || {}}
                    capability={ioTarget.capability}
                    initial={draft.models.find((m) => m.name === ioTarget.name)?.comfyui?.io || {}}
                    onSave={(mapping) => {
                        setComfyuiIo(ioTarget.name, mapping);
                        setIoTarget(null);
                    }}
                    onClose={() => setIoTarget(null)}
                />
            )}
```

---

### Task 11: Model-select — comfyui workflow fetch + import

**Files:**
- Modify: `web/src/components/layout/model-select-modal.tsx`

- [ ] **Step 1: Update imports and props**

In `web/src/components/layout/model-select-modal.tsx`, replace lines 1-9 imports:

```ts
import { App, Button, Checkbox, Input, Modal, Tabs, Upload } from "antd";
import { RefreshCw, Search, Upload as UploadIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchChannelModels } from "@/services/api/image";
import { fetchComfyuiWorkflows, getObjectInfo, importComfyuiWorkflow, type ComfyuiWorkflowSummary } from "@/services/api/comfyui";
import { type ChannelModel, type ModelChannel } from "@/stores/use-config-store";
```

Extend the props (replace the `export function ModelSelectModal({...})` signature at line 10-11):

```ts
export function ModelSelectModal({
    open,
    channel,
    selectedNames,
    onConfirm,
    onConfirmComfyui,
    onClose,
}: {
    open: boolean;
    channel: ModelChannel | null;
    selectedNames: string[];
    onConfirm: (names: string[]) => void;
    onConfirmComfyui?: (names: string[], metas: Record<string, { promptJson: Record<string, any>; source?: "server" | "import" }>) => void;
    onClose: () => void;
}) {
```

- [ ] **Step 2: Add comfyui state + resets**

Inside the component, after the `useState` declarations (after line 19), add:

```ts
    const isComfyui = channel?.apiFormat === "comfyui";
    const [comfyuiWorkflows, setComfyuiWorkflows] = useState<ComfyuiWorkflowSummary[]>([]);
    const comfyuiMeta = useRef<Record<string, { promptJson: Record<string, any>; source?: "server" | "import" }>>({});
```

In the open-reset `useEffect` (line 21-29), append:

```ts
        setComfyuiWorkflows([]);
        comfyuiMeta.current = {};
```

- [ ] **Step 3: Branch fetch on comfyui**

Replace `fetchModels` (line 62-79):

```ts
    const fetchModels = async () => {
        if (!channel) return;
        if (!channel.baseUrl.trim() || (!isComfyui && !channel.apiKey.trim())) {
            message.error(t("config.modelSelect.missingConfig"));
            return;
        }
        setLoading(true);
        try {
            if (isComfyui) {
                const workflows = await fetchComfyuiWorkflows(channel.baseUrl);
                comfyuiMeta.current = Object.fromEntries(workflows.filter((w) => w.ok).map((w) => [w.name, { promptJson: w.promptJson, source: w.source }]));
                setComfyuiWorkflows(workflows);
                setFetched(workflows.map((w) => w.name));
                setActiveTab("new");
                const ready = workflows.filter((w) => w.ok).length;
                message.success(t("config.modelSelect.fetched", { count: ready }));
                if (!ready) message.warning(t("config.comfyui.importHint"));
            } else {
                const models = await fetchChannelModels(channel);
                setFetched(models);
                setActiveTab("new");
                message.success(t("config.modelSelect.fetched", { count: models.length }));
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.modelSelect.fetchFailed"));
            if (isComfyui) message.warning(t("config.comfyui.importHint"));
        } finally {
            setLoading(false);
        }
    };
```

- [ ] **Step 4: Add the import handler**

After `fetchModels`, add:

```ts
    const importWorkflow = async (file: File) => {
        if (!channel) return;
        try {
            const objectInfo = await getObjectInfo(channel.baseUrl);
            const summary = await importComfyuiWorkflow(await file.text(), objectInfo);
            const name = file.name.replace(/\.json$/i, "");
            comfyuiMeta.current[name] = { promptJson: summary.promptJson, source: "import" };
            setComfyuiWorkflows((current) => [...current, { ...summary, name }]);
            setFetched((current) => (current.includes(name) ? current : [name, ...current]));
            setSelected((current) => new Set(current).add(name));
            setActiveTab("new");
            if (!summary.ok) message.warning(t("config.comfyui.importPartial", { reason: summary.reason || "" }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.comfyui.importFailed"));
        }
    };
```

- [ ] **Step 5: Add the import button + comfyui meta to confirm**

In the toolbar `<div>` (around line 108-115), add an import button after the fetch `<Button>`:

```tsx
                {isComfyui && (
                    <Upload accept=".json,application/json" showUploadList={false} beforeUpload={(file) => { void importWorkflow(file); return false; }}>
                        <Button icon={<UploadIcon className="size-4" />}>{t("config.comfyui.importWorkflow")}</Button>
                    </Upload>
                )}
```

Replace `confirm` (line 81-85):

```ts
    const confirm = () => {
        const ordered = [...existing, ...fetched].filter((name, index, list) => list.indexOf(name) === index).filter((name) => selected.has(name));
        if (isComfyui && onConfirmComfyui) onConfirmComfyui(ordered, comfyuiMeta.current);
        else onConfirm(ordered);
        onClose();
    };
```

- [ ] **Step 6: Typecheck (Tasks 10 + 11 together)**

Run: `cd web && bun run typecheck`
Expected: PASS for both files. (`comfyuiWorkflows` state is available for future UI richness; if `tsc` flags it unused, prefix with `void comfyuiWorkflows;` or remove the state and derive from `fetched` — keep `comfyuiMeta` ref, which is used.)

- [ ] **Step 7: Commit Tasks 10 + 11 together**

```bash
git add web/src/components/layout/model-select-modal.tsx web/src/components/layout/channel-editor-drawer.tsx
git commit -m "feat(comfyui): workflow fetch/import in model-select + IO wiring in channel editor"
```

---

### Task 12: i18n keys + env doc update

**Files:**
- Modify: `web/src/i18n/locales/zh-CN.ts`
- Modify: `web/src/i18n/locales/en-US.ts`
- Modify: `web/.env.example`
- Modify: `web/.env.local`

- [ ] **Step 1: Add Chinese keys**

In `web/src/i18n/locales/zh-CN.ts`:

In the `protocols` block (line ~573), add `comfyui`:

```ts
        protocols: {
            ark: "火山方舟",
            comfyui: "ComfyUI",
        },
```

In the `channelEditor` block (line ~481), add alongside `script`/`scriptReady`:

```ts
            ioNodes: "输入输出节点",
            ioNodesReady: "节点已配置",
```

Add a new `comfyui` block inside `config` (after `modelSelect`, before `protocols`):

```ts
        comfyui: {
            ioTitle: "配置 ComfyUI 输入输出节点",
            ioHint: "把画布的提示词/参考图映射到工作流节点，并选择读取结果的输出节点。",
            promptNode: "正向提示词节点",
            negativeNode: "负向提示词节点",
            referenceNode: "参考图节点（图生图）",
            outputNode: "输出节点",
            none: "无",
            invalidWorkflowJson: "工作流 JSON 格式无效",
            unknownNodeType: "节点 {{id}} ({{type}}) 未在 ComfyUI 中找到定义",
            widgetCountMismatch: "节点 {{id}} ({{type}}) 的 widget 数量少于定义,转换可能不完整,建议改用 API 格式导入。",
            noServerWorkflows: "未在 ComfyUI 读取到工作流，请改用「导入工作流」上传 API 格式 JSON。",
            importedWorkflow: "导入的工作流",
            importWorkflow: "导入工作流",
            importHint: "服务端未返回可用工作流，请用「导入工作流」上传 ComfyUI「Save (API Format)」导出的 JSON。",
            importPartial: "部分节点转换失败：{{reason}}，建议改用 API 格式导入。",
            importFailed: "导入工作流失败",
            promptNodeNotConfigured: "尚未配置正向提示词节点，请先在渠道里配置输入输出节点。",
            outputNodeNotConfigured: "尚未配置输出节点，请先在渠道里配置输入输出节点。",
            noOutput: "ComfyUI 未返回图片，请检查输出节点配置。",
            viewFailed: "读取 ComfyUI 生成图片失败",
            pollTimeout: "ComfyUI 生成超时，请稍后重试（--lowvram 首帧较慢）。",
        },
```

- [ ] **Step 2: Add English keys (mirror in `en-US.ts`)**

Add the same keys to `web/src/i18n/locales/en-US.ts`:

```ts
        protocols: {
            ark: "Volcano Ark",
            comfyui: "ComfyUI",
        },
```

```ts
            ioNodes: "Input/Output Nodes",
            ioNodesReady: "Nodes configured",
```

```ts
        comfyui: {
            ioTitle: "Configure ComfyUI IO Nodes",
            ioHint: "Map the canvas prompt/reference to workflow nodes and choose the output node to read results from.",
            promptNode: "Positive prompt node",
            negativeNode: "Negative prompt node",
            referenceNode: "Reference image node (img2img)",
            outputNode: "Output node",
            none: "None",
            invalidWorkflowJson: "Invalid workflow JSON",
            unknownNodeType: "Node {{id}} ({{type}}) is not defined in ComfyUI",
            widgetCountMismatch: "Node {{id}} ({{type}}) has fewer widgets than its definition; conversion may be incomplete — prefer an API-format import.",
            noServerWorkflows: "No workflows found in ComfyUI; use \"Import Workflow\" to upload an API-format JSON.",
            importedWorkflow: "Imported workflow",
            importWorkflow: "Import Workflow",
            importHint: "The server returned no usable workflows; use \"Import Workflow\" to upload a ComfyUI \"Save (API Format)\" JSON.",
            importPartial: "Some nodes failed to convert: {{reason}} — prefer an API-format import.",
            importFailed: "Import workflow failed",
            promptNodeNotConfigured: "Positive prompt node not configured — set IO nodes in the channel first.",
            outputNodeNotConfigured: "Output node not configured — set IO nodes in the channel first.",
            noOutput: "ComfyUI returned no image; check the output node mapping.",
            viewFailed: "Failed to read generated image from ComfyUI",
            pollTimeout: "ComfyUI generation timed out; please retry (--lowvram first frame is slow).",
        },
```

- [ ] **Step 3: Update the env files' comment**

In both `web/.env.example` and `web/.env.local`, replace the comment block above `COMFYUI_URL=` with:

```
# ComfyUI address used as the FALLBACK target for the Vite dev proxy when a request
# omits the x-comfyui-target header. The real, UI-editable address lives in the channel's
# Base URL; this only needs to be correct if you hit /comfyui/* outside the app.
```

(Keep `localhost:8188` in `.env.example`; keep `10.168.1.109:8188` in `.env.local`.)

- [ ] **Step 4: Typecheck + build**

Run: `cd web && bun run typecheck && bun run build`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/i18n/locales/zh-CN.ts web/src/i18n/locales/en-US.ts web/.env.example web/.env.local
git commit -m "feat(comfyui): i18n keys and env doc update"
```

---

### Task 13: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Ensure dev server and ComfyUI are up**

Dev server: http://localhost:3001 (background task). ComfyUI: http://10.168.1.109:8188 (`/system_stats` responds).

- [ ] **Step 2: Configure a comfyui channel**

Config → Channels → add channel → protocol = ComfyUI → Base URL = `http://10.168.1.109:8188` → Save. Confirm the API Key field is hidden.

- [ ] **Step 3: Add a workflow via import (reliable path)**

In ComfyUI: open a workflow → menu → **Save (API Format)** → keep the JSON. In the channel: 添加模型 / 拉取模型 → if the server list is empty (expected on 0.30.2), click **导入工作流** → select the API-format JSON. The workflow appears as a model; select it and confirm.

- [ ] **Step 4: Configure IO nodes**

On the model row click **输入输出节点** → confirm the positive prompt node (a CLIPTextEncode) and an output node (SaveImage) are auto-selected → Save.

- [ ] **Step 5: Generate**

On the image workbench, select this comfyui model as the image model, enter a prompt, generate. Expected: after up to ~60s (`--lowvram`), an image appears. If it errors on a missing required input, note the node — `patchRequiredDefaults` covers `SaveImage.filename_prefix`; others surface in the message.

- [ ] **Step 6: (Optional) server-list path**

If ComfyUI has server-saved workflows, 拉取模型 lists them; a workflow whose Graph→Prompt conversion succeeds (`ok`) works end-to-end; a failed conversion shows the import hint.

- [ ] **Step 7: Commit any fixups discovered**

```bash
git add -A
git commit -m "fix(comfyui): <what manual testing surfaced>"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** ① comfyui protocol → T1, T10; ② Base URL = real address + dynamic proxy → T2; ③ fetch = workflow list → T6, T11; ④ model = workflow → T1 (`ChannelModel.comfyui`), T11; ⑤ IO node selection replaces script → T5, T9, T10; ⑥ capability distinguishes output → T5 (`capabilityForOutput` + filter in T9), T1. Error handling (spec §7) → `patchRequiredDefaults`, poll timeout, view fail, import partial — T6/T7/T11. Phasing: only P0 is implemented; P1 (more node-type conversion robustness, size/batch panel, video) and P2 (audio) are deliberately out of scope.
- **Placeholder scan:** none — every step has concrete code or an exact edit.
- **Type consistency:** `ComfyuiIoSlot`/`ComfyuiIoMapping`/`ComfyuiModelMeta` (T1) used identically in T3/T5/T7/T9/T10/T11. `runComfyui`/`fetchComfyuiWorkflows`/`importComfyuiWorkflow`/`parseComfyuiPromptNodes`/`getObjectInfo` signatures match across producers/consumers. `onConfirmComfyui` prop added in T11 and consumed in T10 (implemented together). `resolveChannelModelEntry` added in T1, used in T8.
- **Deviation from spec (noted):** the spec listed a comfyui branch inside `fetchImageModels`; the plan instead fetches workflows directly in `model-select-modal` (T11), because `fetchImageModels` returns `string[]` and cannot carry the `promptJson` each workflow needs. Behavior is equivalent and cleaner.
