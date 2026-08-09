import { App, Button, Checkbox, Input, Modal, Tabs, Upload } from "antd";
import { RefreshCw, Search, Upload as UploadIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchChannelModels } from "@/services/api/image";
import { fetchComfyuiWorkflows, getObjectInfo, importComfyuiWorkflow, type ComfyuiWorkflowSummary } from "@/services/api/comfyui";
import { type ChannelModel, type ModelChannel } from "@/stores/use-config-store";

// Channel model selector: fetch upstream models or add them manually, then include checked models in the channel list.
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
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [existing, setExisting] = useState<string[]>([]);
    const [fetched, setFetched] = useState<string[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [activeTab, setActiveTab] = useState("new");
    const [search, setSearch] = useState("");
    const [manual, setManual] = useState("");
    const [loading, setLoading] = useState(false);
    const isComfyui = channel?.apiFormat === "comfyui";
    const [comfyuiWorkflows, setComfyuiWorkflows] = useState<ComfyuiWorkflowSummary[]>([]);
    const comfyuiMeta = useRef<Record<string, { promptJson: Record<string, any>; source?: "server" | "import" }>>({});
    // Name → summary lookup so the list can grey out server-fetched workflows that failed graph→prompt conversion.
    const comfyuiWorkflowByName = useMemo(() => new Map(comfyuiWorkflows.map((w) => [w.name, w])), [comfyuiWorkflows]);

    useEffect(() => {
        if (!open) return;
        setExisting(selectedNames);
        setFetched([]);
        setSelected(new Set(selectedNames));
        setActiveTab(selectedNames.length ? "existing" : "new");
        setSearch("");
        setManual("");
        setComfyuiWorkflows([]);
        comfyuiMeta.current = {};
    }, [open, selectedNames]);

    const currentList = activeTab === "new" ? fetched : existing;
    const visibleList = useMemo(() => {
        const keyword = search.trim().toLowerCase();
        return keyword ? currentList.filter((name) => name.toLowerCase().includes(keyword)) : currentList;
    }, [currentList, search]);
    const visibleSelectedCount = visibleList.filter((name) => selected.has(name)).length;

    const toggle = (name: string, checked: boolean) =>
        setSelected((current) => {
            const next = new Set(current);
            if (checked) next.add(name);
            else next.delete(name);
            return next;
        });

    // Server-fetched workflows that failed conversion (missing custom nodes etc.) are shown greyed out and
    // excluded from selection: picking one would create a model with no usable prompt graph. Manually imported
    // workflows are exempt (a partial import is still configurable in the IO modal).
    const isWorkflowDisabled = (name: string): boolean => {
        const summary = comfyuiWorkflowByName.get(name);
        return !!summary && summary.source === "server" && !summary.ok;
    };

    const selectVisible = (checked: boolean) =>
        setSelected((current) => {
            const next = new Set(current);
            visibleList.forEach((name) => {
                if (checked) {
                    if (!isWorkflowDisabled(name)) next.add(name);
                } else {
                    next.delete(name);
                }
            });
            return next;
        });

    const addManual = () => {
        const name = manual.trim();
        if (!name) return;
        if (!fetched.includes(name) && !existing.includes(name)) setFetched((current) => [name, ...current]);
        setSelected((current) => new Set(current).add(name));
        setManual("");
        setActiveTab("new");
    };

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
                message.success(t("config.modelSelect.fetched", { count: workflows.length }));
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

    const confirm = () => {
        const ordered = [...existing, ...fetched].filter((name, index, list) => list.indexOf(name) === index).filter((name) => selected.has(name));
        if (isComfyui && onConfirmComfyui) onConfirmComfyui(ordered, comfyuiMeta.current);
        else onConfirm(ordered);
        onClose();
    };

    return (
        <Modal
            open={open}
            width={880}
            centered
            onCancel={onClose}
            title={
                <span>
                    {t("config.modelSelect.title")} <span className="ml-2 text-xs font-normal text-stone-500">{t("config.modelSelect.selected", { selected: selected.size, total: new Set([...existing, ...fetched]).size })}</span>
                </span>
            }
            styles={{ body: { maxHeight: "62vh", overflowY: "auto" } }}
            footer={[
                <Button key="cancel" onClick={onClose}>
                    {t("common.cancel")}
                </Button>,
                <Button key="confirm" type="primary" onClick={confirm}>
                    {t("config.modelSelect.confirm")}
                </Button>,
            ]}
        >
            <div className="flex flex-wrap items-center gap-3">
                <Input className="min-w-[200px] flex-1" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("config.modelSelect.search")} prefix={<Search className="size-4 text-stone-400" />} allowClear />
                <Input className="min-w-[180px] flex-1" value={manual} onChange={(event) => setManual(event.target.value)} onPressEnter={addManual} placeholder={t("config.modelSelect.modelName")} />
                <Button onClick={addManual}>{t("config.modelSelect.add")}</Button>
                <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void fetchModels()}>
                    {t("config.modelSelect.fetch")}
                </Button>
                {isComfyui && (
                    <Upload accept=".json,application/json" showUploadList={false} beforeUpload={(file) => { void importWorkflow(file); return false; }}>
                        <Button icon={<UploadIcon className="size-4" />}>{t("config.comfyui.importWorkflow")}</Button>
                    </Upload>
                )}
            </div>
            <div className="mt-2 text-xs text-stone-500">{t("config.modelSelect.description")}</div>

            <Tabs
                className="mt-3"
                activeKey={activeTab}
                onChange={setActiveTab}
                items={[
                    { key: "new", label: t("config.modelSelect.fetchedTab", { count: fetched.length }) },
                    { key: "existing", label: t("config.modelSelect.existingTab", { count: existing.length }) },
                ]}
            />

            <div className="mb-3 flex items-center justify-between gap-2">
                <span className="text-xs text-stone-500">{t("config.modelSelect.visibleSelected", { selected: visibleSelectedCount, total: visibleList.length })}</span>
                <div className="flex gap-2">
                    <Button size="small" disabled={!visibleList.length} onClick={() => selectVisible(true)}>
                        {t("config.modelSelect.selectVisible")}
                    </Button>
                    <Button size="small" disabled={!visibleSelectedCount} onClick={() => selectVisible(false)}>
                        {t("config.modelSelect.clearVisible")}
                    </Button>
                </div>
            </div>

            {visibleList.length ? (
                <div className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
                    {visibleList.map((name) => {
                        const disabled = isWorkflowDisabled(name);
                        const reason = comfyuiWorkflowByName.get(name)?.reason;
                        return (
                            <Checkbox key={name} checked={selected.has(name)} disabled={disabled} onChange={(event) => toggle(name, event.target.checked)}>
                                <span className={`truncate ${disabled ? "text-stone-400" : ""}`} title={disabled && reason ? reason : name}>
                                    {name}
                                </span>
                            </Checkbox>
                        );
                    })}
                </div>
            ) : (
                <div className="py-8 text-center text-sm text-stone-500">{t(activeTab === "new" ? "config.modelSelect.fetchedEmpty" : "config.modelSelect.existingEmpty")}</div>
            )}
        </Modal>
    );
}
