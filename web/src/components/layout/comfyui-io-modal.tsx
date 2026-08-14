import { Button, Input, Modal, Select, Space, Spin, Typography } from "antd";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { buildComfyuiNodeInventory, buildLinkableTypes, getObjectInfo, isWidgetInput, type ComfyuiObjectInfo } from "@/services/api/comfyui";
import type { ComfyuiIoMapping, ComfyuiParamOverride, ComfyuiParamSource, ModelCapability } from "@/stores/use-config-store";

type Props = {
    open: boolean;
    target: string;
    promptJson: Record<string, any>;
    capability: ModelCapability;
    initial: Partial<ComfyuiIoMapping>;
    onSave: (mapping: ComfyuiIoMapping) => void;
    onClose: () => void;
};

const SLOT_UNDEFINED = "__none__";

// Known canvas values per param source, so the valueMap editor can render one input per value. Numeric
// sources (count, videoSeconds) have no enum values and pass through coerced to a number — no valueMap UI.
const CANVAS_SOURCE_VALUES: Record<ComfyuiParamSource, string[]> = {
    quality: ["auto", "high", "medium", "low"],
    vquality: ["720", "480"],
    background: ["transparent", ""],
    videoGenerateAudio: ["true", "false"],
    count: [],
    videoSeconds: [],
};
const PARAM_SOURCE_OPTIONS: Array<{ label: string; value: ComfyuiParamSource }> = [
    { label: "quality", value: "quality" },
    { label: "count", value: "count" },
    { label: "videoSeconds", value: "videoSeconds" },
    { label: "vquality", value: "vquality" },
    { label: "background", value: "background" },
    { label: "videoGenerateAudio", value: "videoGenerateAudio" },
];

export function ComfyuiIoModal({ open, target, promptJson, capability, initial, onSave, onClose }: Props) {
    const { t } = useTranslation();
    void capability; // manual mode offers the full typed inventory regardless of channel capability

    const [objectInfo, setObjectInfo] = useState<ComfyuiObjectInfo>();
    const [loadError, setLoadError] = useState(false);
    useEffect(() => {
        if (!open || !target) return;
        let alive = true;
        setLoadError(false);
        getObjectInfo(target)
            .then((oi) => {
                if (alive) setObjectInfo(oi);
            })
            .catch(() => {
                if (alive) setLoadError(true);
            });
        return () => {
            alive = false;
        };
    }, [open, target]);

    const inventory = useMemo(() => (objectInfo ? buildComfyuiNodeInventory(promptJson, objectInfo) : null), [promptJson, objectInfo]);

    const [value, setValue] = useState<ComfyuiIoMapping>(() => ({
        promptText: initial.promptText ?? { node: "", input: "text" },
        negativeText: initial.negativeText,
        referenceImages: initial.referenceImages ?? [],
        referenceVideos: initial.referenceVideos ?? [],
        width: initial.width,
        height: initial.height,
        seed: initial.seed,
        outputNode: initial.outputNode || "",
        params: initial.params ?? [],
    }));
    // Prefill defaults for unset fields once the typed inventory loads.
    useEffect(() => {
        if (!inventory) return;
        setValue((prev) => ({
            ...prev,
            promptText: prev.promptText?.node ? prev.promptText : (inventory.defaults.promptText ?? prev.promptText),
            referenceImages: prev.referenceImages?.length ? prev.referenceImages : (inventory.defaults.referenceImages ?? []),
            referenceVideos: prev.referenceVideos?.length ? prev.referenceVideos : (inventory.defaults.referenceVideos ?? []),
            width: prev.width ?? inventory.defaults.width,
            height: prev.height ?? inventory.defaults.height,
            seed: prev.seed ?? inventory.defaults.seed,
            outputNode: prev.outputNode || inventory.defaults.outputNode || "",
        }));
    }, [inventory]);
    const patch = (partial: Partial<ComfyuiIoMapping>) => setValue((prev) => ({ ...prev, ...partial }));

    const textOptions = (inventory?.textInputs ?? []).map((s) => ({ label: `${s.node} · ${s.classType}.${s.input}`, value: `${s.node}::${s.input}` }));
    const refOptions = (inventory?.referenceImages ?? []).map((s) => ({ label: `${s.node} · ${s.classType}`, value: `${s.node}::${s.input}` }));
    const refVideoOptions = (inventory?.referenceVideos ?? []).map((s) => ({ label: `${s.node} · ${s.classType}`, value: `${s.node}::${s.input}` }));
    const outputOptions = (inventory?.outputs ?? []).map((o) => ({ label: `${o.node} · ${o.classType} (${o.capability})`, value: o.node }));
    const widthOptions = (inventory?.width ?? []).map((s) => ({ label: `${s.node} · ${s.classType}.${s.input}`, value: `${s.node}::${s.input}` }));
    const heightOptions = (inventory?.height ?? []).map((s) => ({ label: `${s.node} · ${s.classType}.${s.input}`, value: `${s.node}::${s.input}` }));
    const seedOptions = (inventory?.seed ?? []).map((s) => ({ label: `${s.node} · ${s.classType}.${s.input}`, value: `${s.node}::${s.input}` }));
    // Param targets: widget inputs only (primitives/combos). Connection-typed inputs
    // (MODEL/CLIP/IMAGE/LATENT/VAE/CONDITIONING…) are wired links — writing a scalar canvas value
    // into them via setNodeInput would overwrite [originNode, slot] and sever the connection, so they
    // are excluded from the dropdown entirely.
    const paramTargetOptions = useMemo(() => {
        if (!objectInfo) return [] as Array<{ label: string; value: string }>;
        const linkableTypes = buildLinkableTypes(objectInfo);
        const opts: Array<{ label: string; value: string }> = [];
        const seen = new Set<string>();
        for (const [id, node] of Object.entries(promptJson)) {
            const classType = typeof node?.class_type === "string" ? node.class_type : "";
            const def = objectInfo[classType];
            if (!def) continue;
            for (const group of [def.input?.required, def.input?.optional]) {
                if (!group) continue;
                for (const [name, spec] of Object.entries(group)) {
                    if (!isWidgetInput(spec, linkableTypes)) continue;
                    const value = `${id}::${name}`;
                    if (seen.has(value)) continue;
                    seen.add(value);
                    opts.push({ label: `${id} · ${classType}.${name}`, value });
                }
            }
        }
        // Keep an already-selected (possibly legacy/now-filtered) target selectable so an existing
        // binding still renders its label instead of silently vanishing from the dropdown.
        for (const p of value.params ?? []) {
            const v = `${p.node}::${p.input}`;
            if (p.node && p.input && !seen.has(v)) {
                seen.add(v);
                opts.push({ label: `${p.node} · ${p.input}`, value: v });
            }
        }
        return opts;
    }, [promptJson, objectInfo, value.params]);

    const selectedRefKeys = new Set((value.referenceImages ?? []).map((s) => `${s.node}::${s.input}`));
    const addableReferences = refOptions.filter((opt) => !selectedRefKeys.has(opt.value));
    const selectedRefVideoKeys = new Set((value.referenceVideos ?? []).map((s) => `${s.node}::${s.input}`));
    const addableVideoReferences = refVideoOptions.filter((opt) => !selectedRefVideoKeys.has(opt.value));

    const moveReference = (index: number, dir: -1 | 1) =>
        setValue((prev) => {
            const list = [...(prev.referenceImages ?? [])];
            const to = index + dir;
            if (to < 0 || to >= list.length) return prev;
            [list[index], list[to]] = [list[to], list[index]];
            return { ...prev, referenceImages: list };
        });
    const removeReference = (index: number) => setValue((prev) => ({ ...prev, referenceImages: (prev.referenceImages ?? []).filter((_, i) => i !== index) }));
    const addReference = (slot: { node: string; input: string }) => setValue((prev) => ({ ...prev, referenceImages: [...(prev.referenceImages ?? []), slot] }));
    const moveReferenceVideo = (index: number, dir: -1 | 1) =>
        setValue((prev) => {
            const list = [...(prev.referenceVideos ?? [])];
            const to = index + dir;
            if (to < 0 || to >= list.length) return prev;
            [list[index], list[to]] = [list[to], list[index]];
            return { ...prev, referenceVideos: list };
        });
    const removeReferenceVideo = (index: number) => setValue((prev) => ({ ...prev, referenceVideos: (prev.referenceVideos ?? []).filter((_, i) => i !== index) }));
    const addReferenceVideo = (slot: { node: string; input: string }) => setValue((prev) => ({ ...prev, referenceVideos: [...(prev.referenceVideos ?? []), slot] }));

    const updateParam = (index: number, partial: Partial<ComfyuiParamOverride>) => setValue((prev) => ({ ...prev, params: (prev.params ?? []).map((p, i) => (i === index ? { ...p, ...partial } : p)) }));
    const addParam = () => setValue((prev) => ({ ...prev, params: [...(prev.params ?? []), { source: "quality", node: "", input: "" }] }));
    const removeParam = (index: number) => setValue((prev) => ({ ...prev, params: (prev.params ?? []).filter((_, i) => i !== index) }));
    // Set one canvas-value → ComfyUI-value entry; drop empties so unmapped values fall through to skip/passthrough.
    const setParamValueMap = (index: number, canvasValue: string, mapped: string) =>
        setValue((prev) => ({
            ...prev,
            params: (prev.params ?? []).map((p, i) => {
                if (i !== index) return p;
                const valueMap = { ...(p.valueMap ?? {}) };
                if (mapped === "") delete valueMap[canvasValue];
                else valueMap[canvasValue] = mapped;
                return { ...p, valueMap: Object.keys(valueMap).length ? valueMap : undefined };
            }),
        }));

    const decodeSlot = (encoded: string) => {
        const [node, input] = encoded.split("::");
        return { node, input };
    };
    const encodeSlot = (slot?: { node: string; input: string }) => (slot ? `${slot.node}::${slot.input}` : SLOT_UNDEFINED);

    return (
        <Modal open={open} title={t("config.comfyui.ioTitle")} onCancel={onClose} onOk={() => onSave(value)} okText={t("common.save")} cancelText={t("common.cancel")} width={560}>
            <Space direction="vertical" size="middle" className="w-full">
                <Typography.Text type="secondary">{t("config.comfyui.ioHint")}</Typography.Text>
                {loadError ? (
                    <Typography.Text type="danger">{t("config.comfyui.ioLoadError")}</Typography.Text>
                ) : !inventory ? (
                    <Spin />
                ) : (
                    <>
                        <Field label={t("config.comfyui.promptNode")} hint={textOptions.length ? undefined : t("config.comfyui.ioEmpty")}>
                            <Select className="w-full" showSearch options={textOptions} value={encodeSlot(value.promptText)} onChange={(v) => patch({ promptText: decodeSlot(v) })} />
                        </Field>
                        <Field label={t("config.comfyui.negativeNode")}>
                            <Select
                                className="w-full"
                                showSearch
                                options={[{ label: t("config.comfyui.none"), value: SLOT_UNDEFINED }, ...textOptions]}
                                value={encodeSlot(value.negativeText)}
                                onChange={(v) => patch({ negativeText: v === SLOT_UNDEFINED ? undefined : decodeSlot(v) })}
                            />
                        </Field>
                        <Field label={t("config.comfyui.referenceNodes")} hint={refOptions.length ? undefined : t("config.comfyui.ioEmpty")}>
                            <Space direction="vertical" size="small" className="w-full">
                                <Typography.Text type="secondary" className="text-xs">
                                    {t("config.comfyui.referenceOrderHint")}
                                </Typography.Text>
                                {value.referenceImages?.map((slot, index) => (
                                    <div key={`${slot.node}::${slot.input}`} className="flex items-center gap-2">
                                        <span className="flex-1 truncate text-sm">
                                            {slot.node} · {slot.input}
                                        </span>
                                        <Button size="small" disabled={index === 0} onClick={() => moveReference(index, -1)}>
                                            ↑
                                        </Button>
                                        <Button size="small" disabled={index === (value.referenceImages?.length ?? 0) - 1} onClick={() => moveReference(index, 1)}>
                                            ↓
                                        </Button>
                                        <Button size="small" danger onClick={() => removeReference(index)}>
                                            ✕
                                        </Button>
                                    </div>
                                ))}
                                <Select
                                    className="w-full"
                                    showSearch
                                    placeholder={t("config.comfyui.referenceAdd")}
                                    value={undefined}
                                    options={addableReferences}
                                    onChange={(v) => {
                                        if (typeof v === "string") addReference(decodeSlot(v));
                                    }}
                                />
                            </Space>
                        </Field>
                        <Field label={t("config.comfyui.referenceVideoNodes")} hint={refVideoOptions.length ? undefined : t("config.comfyui.ioEmpty")}>
                            <Space direction="vertical" size="small" className="w-full">
                                <Typography.Text type="secondary" className="text-xs">
                                    {t("config.comfyui.referenceOrderHint")}
                                </Typography.Text>
                                {value.referenceVideos?.map((slot, index) => (
                                    <div key={`${slot.node}::${slot.input}`} className="flex items-center gap-2">
                                        <span className="flex-1 truncate text-sm">
                                            {slot.node} · {slot.input}
                                        </span>
                                        <Button size="small" disabled={index === 0} onClick={() => moveReferenceVideo(index, -1)}>
                                            ↑
                                        </Button>
                                        <Button size="small" disabled={index === (value.referenceVideos?.length ?? 0) - 1} onClick={() => moveReferenceVideo(index, 1)}>
                                            ↓
                                        </Button>
                                        <Button size="small" danger onClick={() => removeReferenceVideo(index)}>
                                            ✕
                                        </Button>
                                    </div>
                                ))}
                                <Select
                                    className="w-full"
                                    showSearch
                                    placeholder={t("config.comfyui.referenceVideoAdd")}
                                    value={undefined}
                                    options={addableVideoReferences}
                                    onChange={(v) => {
                                        if (typeof v === "string") addReferenceVideo(decodeSlot(v));
                                    }}
                                />
                            </Space>
                        </Field>
                        <Field label={t("config.comfyui.widthNode")} hint={widthOptions.length ? undefined : t("config.comfyui.ioEmpty")}>
                            <Select
                                className="w-full"
                                showSearch
                                options={[{ label: t("config.comfyui.none"), value: SLOT_UNDEFINED }, ...widthOptions]}
                                value={encodeSlot(value.width)}
                                onChange={(v) => patch({ width: v === SLOT_UNDEFINED ? undefined : decodeSlot(v) })}
                            />
                        </Field>
                        <Field label={t("config.comfyui.heightNode")} hint={heightOptions.length ? undefined : t("config.comfyui.ioEmpty")}>
                            <Select
                                className="w-full"
                                showSearch
                                options={[{ label: t("config.comfyui.none"), value: SLOT_UNDEFINED }, ...heightOptions]}
                                value={encodeSlot(value.height)}
                                onChange={(v) => patch({ height: v === SLOT_UNDEFINED ? undefined : decodeSlot(v) })}
                            />
                        </Field>
                        <Field label={t("config.comfyui.seedNode")} hint={seedOptions.length ? undefined : t("config.comfyui.ioEmpty")}>
                            <Select
                                className="w-full"
                                showSearch
                                options={[{ label: t("config.comfyui.none"), value: SLOT_UNDEFINED }, ...seedOptions]}
                                value={encodeSlot(value.seed)}
                                onChange={(v) => patch({ seed: v === SLOT_UNDEFINED ? undefined : decodeSlot(v) })}
                            />
                        </Field>
                        <Field label={t("config.comfyui.paramMapping")} hint={t("config.comfyui.paramHint")}>
                            <Space direction="vertical" size="small" className="w-full">
                                <Typography.Text type="secondary" className="text-xs">
                                    {t("config.comfyui.paramOrderHint")}
                                </Typography.Text>
                                {(value.params ?? []).map((param, index) => {
                                    const enumValues = CANVAS_SOURCE_VALUES[param.source];
                                    return (
                                        <div key={index} className="flex flex-col gap-2 rounded border border-solid border-gray-200 p-2 dark:border-gray-700">
                                            <div className="flex items-center gap-2">
                                                <Select className="flex-1" showSearch options={PARAM_SOURCE_OPTIONS} value={param.source} onChange={(v) => updateParam(index, { source: v, valueMap: undefined })} />
                                                <Select
                                                    className="flex-1"
                                                    showSearch
                                                    placeholder={t("config.comfyui.paramTarget")}
                                                    options={[{ label: t("config.comfyui.none"), value: SLOT_UNDEFINED }, ...paramTargetOptions]}
                                                    value={param.node ? `${param.node}::${param.input}` : SLOT_UNDEFINED}
                                                    onChange={(v) => (v === SLOT_UNDEFINED ? updateParam(index, { node: "", input: "" }) : updateParam(index, decodeSlot(v)))}
                                                />
                                                <Button size="small" danger onClick={() => removeParam(index)}>
                                                    ✕
                                                </Button>
                                            </div>
                                            {enumValues.length > 0 && (
                                                <div className="flex flex-col gap-1">
                                                    <Typography.Text type="secondary" className="text-xs">
                                                        {t("config.comfyui.paramValueMapHint")}
                                                    </Typography.Text>
                                                    {enumValues.map((cv) => (
                                                        <div key={cv || "__empty__"} className="flex items-center gap-2">
                                                            <span className="w-28 shrink-0 text-xs text-gray-500 dark:text-gray-400">{cv === "" ? "(default)" : cv}</span>
                                                            <Input
                                                                className="flex-1"
                                                                size="small"
                                                                value={(param.valueMap?.[cv] as string) ?? ""}
                                                                placeholder={t("config.comfyui.paramValueMap")}
                                                                onChange={(e) => setParamValueMap(index, cv, e.target.value)}
                                                            />
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                <Button size="small" onClick={addParam}>
                                    {t("config.comfyui.paramAdd")}
                                </Button>
                            </Space>
                        </Field>
                        <Field label={t("config.comfyui.outputNode")} hint={outputOptions.length ? undefined : t("config.comfyui.ioEmpty")}>
                            <Select className="w-full" showSearch options={outputOptions} value={value.outputNode} onChange={(v) => patch({ outputNode: v })} />
                        </Field>
                    </>
                )}
            </Space>
        </Modal>
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <label className="block">
            <span className="mb-1 block text-sm font-medium">{label}</span>
            {hint ? (
                <Typography.Text type="secondary" className="mb-1 block text-xs">
                    {hint}
                </Typography.Text>
            ) : null}
            {children}
        </label>
    );
}
