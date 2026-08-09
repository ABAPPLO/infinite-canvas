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

export type ComfyuiObjectInfo = Record<string, { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> }; output?: string[] }>;

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

/** Frontend-only annotation nodes — never executed and never wired into the graph; ComfyUI omits them at submit. */
const ANNOTATION_NODE_TYPES = new Set(["Note", "MarkdownNote"]);

/** ComfyUI inserts a control_after_generate dropdown right after any "seed" widget; its value is not
 *  an object_info input, so it must be skipped when mapping widgets_values positionally. */
const CONTROL_AFTER_GENERATE = new Set(["fixed", "increment", "decrement", "randomize"]);

/** An object_info input is a widget (not a connection slot) when its type is a primitive
 *  (INT/FLOAT/STRING/BOOLEAN), a combo (spec[0] is a list of allowed values), or a non-standard type
 *  name that no node outputs — custom nodes sometimes type a combo with their own name, so anything
 *  that isn't a known linkable (output) type is an unwired widget. Typed inputs like
 *  MODEL/CLIP/IMAGE/LATENT/CONDITIONING are connection slots (they appear as node outputs). */
function isWidgetInput(spec: unknown[] | undefined, linkableTypes: Set<string>): boolean {
    const t = Array.isArray(spec) ? spec[0] : undefined;
    if (Array.isArray(t) || t === "INT" || t === "FLOAT" || t === "STRING" || t === "BOOLEAN") return true;
    return typeof t === "string" && !linkableTypes.has(t);
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

    // Every type some node outputs is a linkable connection type; used to tell custom-node combo widgets
    // (non-standard type names) apart from real connection slots.
    const linkableTypes = new Set<string>();
    for (const def of Object.values(objectInfo)) for (const t of def.output || []) linkableTypes.add(t);

    const prompt: ConvertResult["prompt"] = {};
    const errors: string[] = [];

    for (const node of graph.nodes || []) {
        // Skip annotation nodes silently (see ANNOTATION_NODE_TYPES) so a workflow isn't rejected for
        // carrying a comment. Other unknown types still error below → caller falls back to API import.
        if (ANNOTATION_NODE_TYPES.has(node.type)) continue;
        const def = objectInfo[node.type];
        if (!def) {
            errors.push(i18n.t("config.comfyui.unknownNodeType", { id: node.id, type: node.type }));
            continue;
        }
        const inputs: Record<string, unknown> = {};
        const connectedNames = new Set<string>();
        // Variadic/autogrow inputs (e.g. rgthree COMFY_AUTOGROW) are wired as dotted variants — the
        // object_info base name "values" is connected as "values.a". Track those bases so the base name
        // is treated as a connection, not a widget (avoids a false widget-count mismatch).
        const autogrowBases = new Set<string>();

        // Connection inputs: resolve each wired slot to [originNodeId, originSlot].
        for (const slot of node.inputs || []) {
            if (slot.link == null) continue;
            const origin = linkMap.get(slot.link);
            if (origin) {
                inputs[slot.name] = [String(origin[0]), origin[1]];
                connectedNames.add(slot.name);
                if (slot.name.includes(".")) autogrowBases.add(slot.name.split(".")[0]);
            }
        }

        // Widget inputs: object_info inputs whose type is a widget primitive/combo, in order, excluding
        // any wired as a connection or a variadic base. ComfyUI also lists unwired widgets in node.inputs
        // (link: null), so presence there does NOT mean "slot" — the object_info type does.
        const widgetInputs: string[] = [];
        for (const group of [def.input?.required, def.input?.optional]) {
            if (!group) continue;
            for (const [name, spec] of Object.entries(group)) {
                if (connectedNames.has(name) || autogrowBases.has(name)) continue; // wired slot or variadic base
                if (isWidgetInput(spec, linkableTypes)) widgetInputs.push(name);
            }
        }
        const widgetValues = Array.isArray(node.widgets_values) ? node.widgets_values : [];
        if (widgetValues.length < widgetInputs.length) {
            errors.push(i18n.t("config.comfyui.widgetCountMismatch", { id: node.id, type: node.type }));
        }
        for (let vi = 0, wi = 0; wi < widgetInputs.length && vi < widgetValues.length; wi++) {
            const name = widgetInputs[wi];
            if (!(name in inputs)) inputs[name] = widgetValues[vi];
            vi++;
            // Skip the control_after_generate value ComfyUI inserts right after a seed widget.
            if (name === "seed" && vi < widgetValues.length && CONTROL_AFTER_GENERATE.has(widgetValues[vi] as string)) vi++;
        }

        prompt[String(node.id)] = { class_type: node.type, inputs };
    }
    return { prompt, errors };
}

export type ComfyuiNodeCandidates = {
    textInputs: Array<{ id: string; classType: string; input: string }>; // candidate prompt slots (string-literal inputs)
    referenceImages: Array<{ id: string; input: string }>; // LoadImage nodes
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
    if (candidates.width.length) defaults.width = { node: candidates.width[0].id, input: candidates.width[0].input };
    if (candidates.height.length) defaults.height = { node: candidates.height[0].id, input: candidates.height[0].input };
    if (candidates.seed.length) defaults.seed = { node: candidates.seed[0].id, input: candidates.seed[0].input };
    const firstImageOutput = candidates.outputs.find((o) => o.capability === "image");
    if (firstImageOutput) defaults.outputNode = firstImageOutput.id;
    if (candidates.referenceImages.length) defaults.referenceImages = candidates.referenceImages.map((c) => ({ node: c.id, input: c.input }));
    return { candidates, defaults };
}

export type ComfyuiInputSlot = { node: string; input: string; classType: string };
export type ComfyuiOutputCandidate = { node: string; classType: string; capability: "image" | "video" | "audio" };
export type ComfyuiNodeInventory = {
    textInputs: ComfyuiInputSlot[]; // STRING-typed inputs → prompt candidates
    referenceImages: ComfyuiInputSlot[]; // LoadImage-style nodes → reference image slots
    outputs: ComfyuiOutputCandidate[]; // saver/preview nodes → result nodes, by capability
    defaults: Partial<ComfyuiIoMapping>;
};

const REFERENCE_LOADER_TYPES = new Set(["LoadImage", "LoadImageBatch", "LoadImageByUrl"]);

function inputTypeOf(spec: unknown): string | undefined {
    return Array.isArray(spec) && typeof spec[0] === "string" ? spec[0] : undefined;
}

/** Capability for a saver or preview node: known sets first, then object_info output type for Save/Preview/VHS-prefixed nodes. */
function capabilityForClass(classType: string, def: ComfyuiObjectInfo[string] | undefined): "image" | "video" | "audio" | undefined {
    if (IMAGE_OUTPUT_TYPES.has(classType)) return "image";
    if (VIDEO_OUTPUT_TYPES.has(classType)) return "video";
    if (AUDIO_OUTPUT_TYPES.has(classType)) return "audio";
    if (/^(Save|Preview|VHS_)/.test(classType) && Array.isArray(def?.output)) {
        for (const t of def.output) {
            if (t === "IMAGE") return "image";
            if (t === "VIDEO") return "video";
            if (t === "AUDIO") return "audio";
        }
    }
    return undefined;
}

/**
 * Build a typed IO inventory from a prompt-format workflow + object_info: STRING inputs become prompt
 * candidates, LoadImage-style nodes become reference-image slots, and saver/preview nodes become typed
 * output candidates. Input names come from object_info (not only the converted prompt's present keys),
 * so an unwired prompt slot on a custom encoder (e.g. TextEncodeQwenImageEditPlus.prompt) is still
 * selectable for manual binding.
 */
export function buildComfyuiNodeInventory(promptJson: Record<string, any>, objectInfo: ComfyuiObjectInfo): ComfyuiNodeInventory {
    const textInputs: ComfyuiInputSlot[] = [];
    const referenceImages: ComfyuiInputSlot[] = [];
    const outputs: ComfyuiOutputCandidate[] = [];

    for (const [id, node] of Object.entries(promptJson)) {
        const classType = typeof node?.class_type === "string" ? node.class_type : "";
        const def = objectInfo[classType];
        if (def) {
            for (const group of [def.input?.required, def.input?.optional]) {
                if (!group) continue;
                for (const [name, spec] of Object.entries(group)) {
                    if (inputTypeOf(spec) === "STRING") textInputs.push({ node: id, input: name, classType });
                }
            }
        }
        if (REFERENCE_LOADER_TYPES.has(classType)) referenceImages.push({ node: id, input: "image", classType });
        const capability = capabilityForClass(classType, def);
        if (capability) outputs.push({ node: id, classType, capability });
    }

    const promptLike = textInputs.find((s) => /^(text|prompt|positive)$/i.test(s.input));
    const firstText = promptLike ?? textInputs[0];
    const defaults: Partial<ComfyuiIoMapping> = {};
    if (firstText) defaults.promptText = { node: firstText.node, input: firstText.input };
    if (referenceImages.length) defaults.referenceImages = referenceImages.map((r) => ({ node: r.node, input: r.input }));
    if (outputs.length) defaults.outputNode = outputs[0].node;
    return { textInputs, referenceImages, outputs, defaults };
}

export type ComfyuiWorkflowSummary = { name: string; promptJson: Record<string, any>; ok: boolean; reason?: string; source?: "server" | "import" };

type UserdataEntry = { path?: string; name?: string; type?: string };

/**
 * Fetch all workflows from ComfyUI's server-side workflow list (userdata/workflows).
 * Each graph-format file is converted to prompt format. Throws a specific error if the list API is
 * unavailable or empty, so the UI can fall back to manual JSON import.
 */
export async function fetchComfyuiWorkflows(target: string, signal?: AbortSignal): Promise<ComfyuiWorkflowSummary[]> {
    // List endpoint is /api/v2/userdata?path=workflows (returns {name,path,type,...} objects with the
    // full "workflows/<file>.json" path). The v1 "/api/userdata/workflows" path is the FILE endpoint
    // (matches /userdata/{file} with file="workflows") and 403s — not the list endpoint.
    const list = await comfyuiRequest<UserdataEntry[]>(target, "get", "/api/v2/userdata?path=workflows", undefined, signal);
    const files = (Array.isArray(list) ? list : []).filter((entry) => {
        const filePath = entry.path || entry.name || "";
        // Skip ComfyUI-internal dotfiles (e.g. .index.json) — not real workflows.
        return filePath.endsWith(".json") && !filePath.split("/").pop()?.startsWith(".");
    });
    if (!files.length) throw new Error(i18n.t("config.comfyui.noServerWorkflows"));

    const objectInfo = await getObjectInfo(target, signal);
    const results: ComfyuiWorkflowSummary[] = [];
    for (const entry of files) {
        const filePath = entry.path || entry.name || "";
        const name = filePath.replace(/^workflows\//, "").replace(/\.json$/, "");
        try {
            // {file} route segment doesn't match "/", so encode the path (workflows/x.json → workflows%2Fx.json);
            // ComfyUI decodes %2F back to "/" server-side (user_manager.py: parse.unquote on "%").
            const raw = await comfyuiRequest<unknown>(target, "get", `/api/userdata/${encodeURIComponent(filePath)}`, undefined, signal);
            const format = detectWorkflowFormat(raw);
            if (format === "prompt") {
                const promptJson = raw as Record<string, any>;
                results.push({ name, promptJson, ok: Object.keys(promptJson).length > 0, source: "server" });
            } else {
                const { prompt, errors } = convertGraphToPrompt(raw as GraphJson, objectInfo);
                if (errors.length > 0) {
                    results.push({ name, promptJson: prompt, ok: false, reason: errors.join("; "), source: "server" });
                } else {
                    results.push({ name, promptJson: prompt, ok: true, source: "server" });
                }
            }
        } catch (error) {
            results.push({ name, promptJson: {}, ok: false, reason: error instanceof Error ? error.message : String(error), source: "server" });
        }
    }
    return results;
}

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
        return { name: i18n.t("config.comfyui.importedWorkflow"), promptJson: prompt, ok: false, reason: errors.join("; "), source: "import" };
    }
    return { name: i18n.t("config.comfyui.importedWorkflow"), promptJson: prompt, ok: true, source: "import" };
}

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

/** Keep only nodes reachable (reverse-traversing connection values) from the output node. Workflows can
 *  carry spurious disconnected branches — e.g. an ImageScale node whose required `image` input is left
 *  unwired — whose missing required inputs would fail ComfyUI validation even though nothing on the path
 *  to the output depends on them. If the output node is absent, return the graph unchanged. */
function pruneToOutput(graph: Record<string, any>, outputNode: string): Record<string, any> {
    if (!graph[outputNode]) return graph;
    const keep = new Set<string>();
    const stack = [outputNode];
    while (stack.length) {
        const id = stack.pop() as string;
        if (keep.has(id)) continue;
        keep.add(id);
        const node = graph[id];
        if (!node) continue;
        for (const value of Object.values<any>(node.inputs || {})) {
            if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number" && graph[value[0]]) {
                stack.push(value[0]);
            }
        }
    }
    const pruned: Record<string, any> = {};
    for (const [id, node] of Object.entries(graph)) if (keep.has(id)) pruned[id] = node;
    return pruned;
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

export type RunComfyuiArgs = {
    target: string;
    meta: ComfyuiModelMeta;
    prompt: string;
    negativePrompt?: string;
    references?: string[];
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
    // Positional multi-reference: ref[i] → referenceImages[i]. Extras clamped; missing slots keep the
    // workflow's own value.
    const refSlots = io.referenceImages ?? [];
    const refs = args.references ?? [];
    for (let i = 0; i < refSlots.length; i++) {
        if (i >= refs.length) break;
        const uploaded = await uploadImage(target, refs[i], signal);
        setNodeInput(graph, refSlots[i], uploaded.name);
    }
    patchRequiredDefaults(graph);
    const submitGraph = pruneToOutput(graph, io.outputNode);

    let submit: { prompt_id?: string; node_errors?: Record<string, unknown>; error?: string };
    try {
        submit = await comfyuiRequest<{ prompt_id?: string; node_errors?: Record<string, unknown>; error?: string }>(target, "post", "/prompt", { prompt: submitGraph, client_id: COMFYUI_CLIENT_ID }, signal);
    } catch (err) {
        const data = (err as { response?: { data?: unknown } })?.response?.data;
        if (data === undefined) throw err; // abort / network — propagate unchanged
        const detail = typeof data === "string" ? data : JSON.stringify(data);
        throw new Error(`${i18n.t("config.comfyui.submitFailed")}: ${detail}`);
    }
    if (!submit.prompt_id) {
        const detail = submit.node_errors ? JSON.stringify(submit.node_errors) : submit.error;
        throw new Error(detail ? `${i18n.t("config.comfyui.submitFailed")}: ${detail}` : i18n.t("config.comfyui.submitFailed"));
    }
    const promptId = submit.prompt_id;

    // ComfyUI only writes a /history entry once a prompt finishes (success or error); while it runs the
    // job lives in /queue. So poll /history for the result and keep refreshing the patience window while
    // the job is still queued — heavy models on --lowvram can run for many minutes, and a fixed short
    // deadline would abort jobs ComfyUI is still actively processing.
    let lastActive = Date.now();
    const stalledTimeout = 300_000; // absent from the queue for 5 min → presume it died
    for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const history = await comfyuiRequest<Record<string, { outputs?: Record<string, Record<string, ComfyuiOutputImage[]>>; status?: { completed?: boolean; status_str?: string } }>>(target, "get", `/history/${promptId}`, undefined, signal);
        const entry = history[promptId];
        if (entry?.status?.completed) {
            const nodeOutput = entry.outputs?.[io.outputNode];
            // Savers surface results under varying keys (images / gifs / videos / audio …) depending on
            // type (SaveImage, VHS_VideoCombine, SaveVideo, SaveAudio). Collect every file-like entry
            // regardless of key so video/audio outputs read just like images.
            const entries = Object.values(nodeOutput ?? {})
                .flat()
                .filter((v): v is ComfyuiOutputImage => Boolean(v && typeof v.filename === "string"));
            if (!entries.length) throw new Error(i18n.t("config.comfyui.noOutput"));
            return Promise.all(entries.map((image) => fetchView(target, image, signal)));
        }
        // A history entry that didn't reach completed means execution errored — surface ComfyUI's status
        // instead of making the user wait out the stall timer.
        if (entry?.status && entry.status.completed === false) {
            throw new Error(`${i18n.t("config.comfyui.submitFailed")}: ${entry.status.status_str || "execution failed"}`);
        }
        // Still pending: refresh the patience window only while the job remains alive in the queue.
        const queue = await comfyuiRequest<{ queue_running?: unknown[]; queue_pending?: unknown[] }>(target, "get", "/queue", undefined, signal);
        const inQueue = [...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].some((item) => JSON.stringify(item).includes(promptId));
        if (inQueue) lastActive = Date.now();
        else if (Date.now() - lastActive > stalledTimeout) throw new Error(i18n.t("config.comfyui.pollTimeout"));
        await sleep(2000, signal);
    }
}
