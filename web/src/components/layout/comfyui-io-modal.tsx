import { Button, Modal, Select, Space, Typography } from "antd";
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
        referenceImages: initial.referenceImages ?? defaults.referenceImages ?? [],
        width: initial.width || defaults.width,
        height: initial.height || defaults.height,
        seed: initial.seed || defaults.seed,
        outputNode: initial.outputNode || defaults.outputNode || candidates.outputs[0]?.id || "",
    }));
    const patch = (partial: Partial<ComfyuiIoMapping>) => setValue((prev) => ({ ...prev, ...partial }));

    const selectedRefKeys = new Set((value.referenceImages ?? []).map((s) => `${s.node}::${s.input}`));
    const addableReferences = candidates.referenceImages.filter((entry) => !selectedRefKeys.has(`${entry.id}::${entry.input}`));

    const moveReference = (index: number, dir: -1 | 1) =>
        setValue((prev) => {
            const list = [...(prev.referenceImages ?? [])];
            const target = index + dir;
            if (target < 0 || target >= list.length) return prev;
            [list[index], list[target]] = [list[target], list[index]];
            return { ...prev, referenceImages: list };
        });
    const removeReference = (index: number) =>
        setValue((prev) => ({ ...prev, referenceImages: (prev.referenceImages ?? []).filter((_, i) => i !== index) }));
    const addReference = (slot: { node: string; input: string }) =>
        setValue((prev) => ({ ...prev, referenceImages: [...(prev.referenceImages ?? []), slot] }));

    const textOptions = candidates.textInputs.map((entry) => ({ label: `${entry.id} · ${entry.classType}.${entry.input}`, value: `${entry.id}::${entry.input}` }));
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
                {candidates.referenceImages.length > 0 && (
                    <Field label={t("config.comfyui.referenceNodes")}>
                        <Space direction="vertical" size="small" className="w-full">
                            <Typography.Text type="secondary" className="text-xs">{t("config.comfyui.referenceOrderHint")}</Typography.Text>
                            {value.referenceImages?.map((slot, index) => (
                                <div key={`${slot.node}::${slot.input}`} className="flex items-center gap-2">
                                    <span className="flex-1 truncate text-sm">{slot.node} · LoadImage</span>
                                    <Button size="small" disabled={index === 0} onClick={() => moveReference(index, -1)}>↑</Button>
                                    <Button size="small" disabled={index === (value.referenceImages?.length ?? 0) - 1} onClick={() => moveReference(index, 1)}>↓</Button>
                                    <Button size="small" danger onClick={() => removeReference(index)}>✕</Button>
                                </div>
                            ))}
                            {addableReferences.length > 0 && (
                                <Select
                                    className="w-full"
                                    placeholder={t("config.comfyui.referenceAdd")}
                                    value={undefined}
                                    options={addableReferences.map((entry) => ({ label: `${entry.id} · LoadImage`, value: `${entry.id}::${entry.input}` }))}
                                    onChange={(v) => {
                                        if (typeof v === "string") addReference(decodeSlot(v));
                                    }}
                                />
                            )}
                        </Space>
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
