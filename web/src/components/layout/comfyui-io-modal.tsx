import { Button, Modal, Select, Space, Spin, Typography } from "antd";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { buildComfyuiNodeInventory, getObjectInfo, type ComfyuiObjectInfo } from "@/services/api/comfyui";
import type { ComfyuiIoMapping, ModelCapability } from "@/stores/use-config-store";

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
        width: initial.width,
        height: initial.height,
        seed: initial.seed,
        outputNode: initial.outputNode || "",
    }));
    // Prefill defaults for unset fields once the typed inventory loads.
    useEffect(() => {
        if (!inventory) return;
        setValue((prev) => ({
            ...prev,
            promptText: prev.promptText?.node ? prev.promptText : (inventory.defaults.promptText ?? prev.promptText),
            referenceImages: prev.referenceImages?.length ? prev.referenceImages : inventory.defaults.referenceImages ?? [],
            outputNode: prev.outputNode || inventory.defaults.outputNode || "",
        }));
    }, [inventory]);
    const patch = (partial: Partial<ComfyuiIoMapping>) => setValue((prev) => ({ ...prev, ...partial }));

    const textOptions = (inventory?.textInputs ?? []).map((s) => ({ label: `${s.node} · ${s.classType}.${s.input}`, value: `${s.node}::${s.input}` }));
    const refOptions = (inventory?.referenceImages ?? []).map((s) => ({ label: `${s.node} · ${s.classType}`, value: `${s.node}::${s.input}` }));
    const outputOptions = (inventory?.outputs ?? []).map((o) => ({ label: `${o.node} · ${o.classType} (${o.capability})`, value: o.node }));

    const selectedRefKeys = new Set((value.referenceImages ?? []).map((s) => `${s.node}::${s.input}`));
    const addableReferences = refOptions.filter((opt) => !selectedRefKeys.has(opt.value));

    const moveReference = (index: number, dir: -1 | 1) =>
        setValue((prev) => {
            const list = [...(prev.referenceImages ?? [])];
            const to = index + dir;
            if (to < 0 || to >= list.length) return prev;
            [list[index], list[to]] = [list[to], list[index]];
            return { ...prev, referenceImages: list };
        });
    const removeReference = (index: number) =>
        setValue((prev) => ({ ...prev, referenceImages: (prev.referenceImages ?? []).filter((_, i) => i !== index) }));
    const addReference = (slot: { node: string; input: string }) =>
        setValue((prev) => ({ ...prev, referenceImages: [...(prev.referenceImages ?? []), slot] }));

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
