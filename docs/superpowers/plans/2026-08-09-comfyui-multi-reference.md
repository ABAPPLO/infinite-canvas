# ComfyUI 多参考图输入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ComfyUI 工作流按顺序接收多张参考图——画布 `references[]` → 工作流的多个 `LoadImage` 槽，多了截断、不足留空（空槽保留工作流自带值）。

**Architecture:** 数据模型 `ComfyuiIoMapping.referenceImage`(单槽) → `referenceImages[]`(有序)；`normalizeChannelModels` 做无感迁移，并在持久化加载（persist `merge` → `normalizeChannels` → `normalizeChannelModels`）时生效；IO 面板改为可增/删/重排的有序列表（上移/下移按钮，无新依赖）；`runComfyui` 按位置逐槽注入；宿主 `requestEdit` 传整组参考图。画布侧零改动。采用「先加新字段、后删旧字段」的增量重构，保证每个任务结束 typecheck/build 都绿。

**Tech Stack:** React 19 + TypeScript 5 (strict) + Ant Design 6 + Zustand(persist) + react-i18next。

## Global Constraints

- **无测试框架**：仓库没有 test runner（`web/package.json` 无 `test` 脚本）。**不要新增测试框架**。每个任务的验证 = `cd web && bun run typecheck`（**0 个新增错误**，相对下方基线）+ `cd web && bun run build` 通过。本计划不写「先写失败测试」步骤，因为没有 runner——以 typecheck + build 作为行为/类型正确性门禁。
- **typecheck 前先装依赖**：`cd web && bun install` 再信 typecheck（缺 i18next 会产生假的 `string | undefined` 错误）。
- **typecheck 基线**（已知、不在本次范围，不计为新增）：`src/lib/canvas/canvas-generation-helpers.ts(51,47) TS18048 'node.metadata' is possibly 'undefined'`。门禁 = 相对基线 **0 NEW** 错误。
- **ComfyUI 目标地址绝不写死**：走 `x-comfyui-target` header / 渠道 `baseUrl`；代码里只能出现 `http://localhost:8188` 作为回退默认。真实远程地址只允许在 gitignored `web/.env.local`，不得提交。
- **提交前丢弃 Biome 格式化抖动**：`ECC_GATEGUARD=off git checkout -- <本次编辑的文件>`（仅本次改动的文件）。
- **直接在 `main` 提交**（既有约定）。
- **重排用「上移/下移」按钮**：仓库无 dnd 库（`@dnd-kit`/`react-beautiful-dnd` 均未安装），不新增依赖。这与 spec §3 的「拖拽」功能等价（都能设定注入顺序）。
- **i18n 双语**：新增的每个键都要在 `zh-CN.ts` 与 `en-US.ts` 同时加。

## File Structure

- `web/src/stores/use-config-store.ts` — `ComfyuiIoMapping` 类型（增量加 `referenceImages`，Task 4 删 `referenceImage`）；`normalizeChannelModels` 内迁移（新增私有 `migrateComfyuiMeta`）。**唯一迁移点**，持久化加载与编辑器保存都经过这里。
- `web/src/services/api/comfyui.ts` — `parseComfyuiPromptNodes` 的 `defaults` 增 `referenceImages`；`RunComfyuiArgs.referenceDataUrl`→`references`；`runComfyui` 按位置注入。
- `web/src/services/api/image.ts` — `requestEdit` 的 comfyui 分支：传整组 `references`。（`requestGeneration` 不改。）
- `web/src/components/layout/comfyui-io-modal.tsx` — 参考图区从单选改为有序可增/删/重排列表，写 `referenceImages`。
- `web/src/i18n/locales/zh-CN.ts` + `en-US.ts` — 新增 `referenceNodes` / `referenceOrderHint` / `referenceAdd` 三键。

任务依赖（线性）：Task 1 → 2 → 3 → 4 → 5。

---

### Task 1: Store — 增量添加 `referenceImages` 字段 + 迁移

**Files:**
- Modify: `web/src/stores/use-config-store.ts`（`ComfyuiIoMapping` ~L22-30；`normalizeChannelModels` ~L285-298）

**Interfaces:**
- Produces: `ComfyuiIoMapping.referenceImages?: ComfyuiIoSlot[]`（**新增**，与现有 `referenceImage?` 并存，Task 4 删旧字段）。
- Produces: `normalizeChannelModels` 把旧 `comfyui.io.referenceImage` 迁移为 `referenceImages:[it]`（`referenceImages` 已存在则不动）。

- [ ] **Step 1: 在 `ComfyuiIoMapping` 加字段**

在 `referenceImage?: ComfyuiIoSlot;`（~L25）下方新增一行（保留旧字段）：

```ts
    referenceImage?: ComfyuiIoSlot;   // [legacy] image-to-image source — migrated to referenceImages[0]; removed in Task 4
    referenceImages?: ComfyuiIoSlot[]; // ordered image-to-image sources: ref[i] → LoadImage slot i
```

- [ ] **Step 2: 加迁移 helper**

在 `normalizeChannelModels` 函数**上方**新增私有 helper：

```ts
// Migrate legacy single referenceImage → ordered referenceImages[]. No-op once a model already has referenceImages.
function migrateComfyuiMeta(meta: ComfyuiModelMeta): ComfyuiModelMeta {
    const io = meta.io;
    if (io.referenceImages || !io.referenceImage) return meta;
    return { ...meta, io: { ...io, referenceImages: [io.referenceImage] } };
}
```

- [ ] **Step 3: 在 `normalizeChannelModels` 内调用 helper**

把现有的（~L294-295）

```ts
        const comfyui = typeof item === "string" ? undefined : item.comfyui;
        result.push({ name, capability, script, ...(comfyui ? { comfyui } : {}) });
```

改为：

```ts
        const rawComfyui = typeof item === "string" ? undefined : item.comfyui;
        const comfyui = rawComfyui ? migrateComfyuiMeta(rawComfyui) : undefined;
        result.push({ name, capability, script, ...(comfyui ? { comfyui } : {}) });
```

- [ ] **Step 4: 验证门禁**

```bash
cd web && bun install && bun run typecheck   # 0 NEW（基线仅 canvas-generation-helpers.ts(51,47)）
cd web && bun run build                       # 绿
```

- [ ] **Step 5: 提交**

```bash
git add web/src/stores/use-config-store.ts
git commit -m "feat(comfyui): add referenceImages field + migration (additive)"
```

---

### Task 2: comfyui.ts + image.ts — 多参考图注入端到端

**Files:**
- Modify: `web/src/services/api/comfyui.ts`（`parseComfyuiPromptNodes` defaults ~L164-173；`RunComfyuiArgs` ~L296-304；`runComfyui` 注入块 ~L322-325）
- Modify: `web/src/services/api/image.ts`（`requestEdit` comfyui 分支 ~L810-820）

**Interfaces:**
- Consumes: `ComfyuiIoMapping.referenceImages`（Task 1）。
- Produces: `RunComfyuiArgs.references?: string[]`；`runComfyui` 按位置注入 `referenceImages[i]`。`requestEdit` 传整组 dataUrl 数组。

- [ ] **Step 1: `parseComfyuiPromptNodes` defaults 默认全选所有 LoadImage**

在 `defaults` 的 `return { candidates, defaults };`（~L173）**之前**新增（顺序 = 检测顺序，即 `candidates.referenceImages` 的顺序）：

```ts
    if (candidates.referenceImages.length) defaults.referenceImages = candidates.referenceImages.map((c) => ({ node: c.id, input: c.input }));
```

- [ ] **Step 2: `RunComfyuiArgs` 换字段**

把（~L301）

```ts
    referenceDataUrl?: string;
```

改为：

```ts
    references?: string[];
```

- [ ] **Step 3: `runComfyui` 改为按位置注入**

把现有单图注入块（~L322-325）

```ts
    if (io.referenceImage && args.referenceDataUrl) {
        const uploaded = await uploadImage(target, args.referenceDataUrl, signal);
        setNodeInput(graph, io.referenceImage, uploaded.name);
    }
```

改为：

```ts
    // Positional multi-reference: ref[i] → referenceImages[i]. Extras clamped; missing slots keep the
    // workflow's own value. Fall back to legacy single referenceImage slot while the IO modal still
    // writes the old field (Task 3 switches the modal; Task 4 removes this fallback).
    const refSlots = io.referenceImages?.length ? io.referenceImages : io.referenceImage ? [io.referenceImage] : [];
    const refs = args.references ?? [];
    for (let i = 0; i < refSlots.length; i++) {
        if (i >= refs.length) break;
        const uploaded = await uploadImage(target, refs[i], signal);
        setNodeInput(graph, refSlots[i], uploaded.name);
    }
```

- [ ] **Step 4: `image.ts` `requestEdit` comfyui 分支传整组**

把（~L813）

```ts
        const referenceDataUrl = references.length ? await imageToDataUrl(references[0]) : undefined;
        try {
            const dataUrls = await runComfyui({ target: requestConfig.baseUrl, meta: entry.model.comfyui, prompt: withSystemPrompt(requestConfig, requestPrompt), referenceDataUrl, signal: options?.signal });
```

改为（注意：`references` 此处恒为 `ReferenceImage[]`，空数组也照传，`runComfyui` 见 `refs.length` 为 0 即不注入）：

```ts
        const referenceDataUrls = await Promise.all(references.map((image) => imageToDataUrl(image)));
        try {
            const dataUrls = await runComfyui({ target: requestConfig.baseUrl, meta: entry.model.comfyui, prompt: withSystemPrompt(requestConfig, requestPrompt), references: referenceDataUrls, signal: options?.signal });
```

- [ ] **Step 5: 验证门禁**

```bash
cd web && bun run typecheck   # 0 NEW。确认 image.ts 的 requestGeneration（~L744）不报错（它不传 referenceDataUrl/references）
cd web && bun run build
```

- [ ] **Step 6: 提交**

```bash
git add web/src/services/api/comfyui.ts web/src/services/api/image.ts
git commit -m "feat(comfyui): multi-reference positional injection in runComfyui + requestEdit"
```

---

### Task 3: IO 面板 — 有序可增/删/重排列表 + i18n

**Files:**
- Modify: `web/src/components/layout/comfyui-io-modal.tsx`
- Modify: `web/src/i18n/locales/zh-CN.ts`（`config.comfyui` 段）
- Modify: `web/src/i18n/locales/en-US.ts`（`config.comfyui` 段）

**Interfaces:**
- Consumes: `ComfyuiIoMapping.referenceImages`、`candidates.referenceImages`、`defaults.referenceImages`、现有 `encodeSlot`/`decodeSlot`/`Field`/`patch`/`setValue`。
- Produces: modal `onSave` 写入有序 `referenceImages`（替代旧的单 `referenceImage`）。

- [ ] **Step 1: 初始 value 改用 `referenceImages`**

把（~L25）

```ts
        referenceImage: initial.referenceImage,
```

改为：

```ts
        referenceImages: initial.referenceImages ?? defaults.referenceImages ?? [],
```

- [ ] **Step 2: 加可添加候选 + 重排/删除/添加 handler**

在 `const patch = ...`（~L31）下方新增：

```ts
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
```

- [ ] **Step 3: 把单选 Field 换成有序列表区**

把现有的参考图 Field（~L55-59，`{capability === "image" && (...)}` 整块）替换为：

```tsx
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
                                    onChange={(v) => addReference(decodeSlot(v))}
                                />
                            )}
                        </Space>
                    </Field>
                )}
```

- [ ] **Step 4: 删除不再使用的 `refOptions`**

删除（~L34）

```ts
    const refOptions = candidates.referenceImages.map((entry) => ({ label: `${entry.id} · LoadImage`, value: `${entry.id}::${entry.input}` }));
```

（`encodeSlot`/`decodeSlot` 仍被 prompt/negative 字段使用，保留。）

- [ ] **Step 5: i18n 新增三键**

在 `zh-CN.ts` 的 `config.comfyui` 段（含 `referenceNode` 那处）新增：

```ts
referenceNodes: "参考图节点", referenceOrderHint: "顺序决定注入：第 i 张参考图 → 第 i 个 LoadImage；多余截断、不足留空。", referenceAdd: "添加参考图节点",
```

在 `en-US.ts` 的 `config.comfyui` 段对应新增：

```ts
referenceNodes: "Reference image nodes", referenceOrderHint: "Order sets injection: ref[i] → LoadImage slot i; extras clamped, missing slots keep the workflow default.", referenceAdd: "Add reference node",
```

- [ ] **Step 6: 验证门禁**

```bash
cd web && bun run typecheck   # 0 NEW
cd web && bun run build
```

- [ ] **Step 7: 提交**

```bash
git add web/src/components/layout/comfyui-io-modal.tsx web/src/i18n/locales/zh-CN.ts web/src/i18n/locales/en-US.ts
git commit -m "feat(comfyui): IO modal ordered reference-image slots (add/remove/reorder)"
```

---

### Task 4: Store 清理 — 删除 legacy `referenceImage` 字段

**Files:**
- Modify: `web/src/stores/use-config-store.ts`（`ComfyuiIoMapping` ~L25；`migrateComfyuiMeta`）
- Modify: `web/src/services/api/comfyui.ts`（`runComfyui` 注入块的 fallback ~L322-325）

**Interfaces:**
- 移除 `ComfyuiIoMapping.referenceImage`；`migrateComfyuiMeta` 改为通过类型断言读取并剥离旧字段（持久化 localStorage 可能仍带旧字段，但类型不再声明）。

- [ ] **Step 1: 删除类型里的 legacy 字段**

删除 `ComfyuiIoMapping` 中的（~L25，含 Task 1 加的注释）：

```ts
    referenceImage?: ComfyuiIoSlot;   // [legacy] ...
```

- [ ] **Step 2: 迁移 helper 改为读+剥离 legacy 字段**

把 Task 1 的 `migrateComfyuiMeta` 替换为（类型已无 `referenceImage`，故用交集类型读取并从输出 `io` 中剔除它）：

```ts
// Migrate legacy single referenceImage → ordered referenceImages[]. Reads the legacy field via cast
// (persisted localStorage may still carry it) and strips it from the migrated io.
function migrateComfyuiMeta(meta: ComfyuiModelMeta): ComfyuiModelMeta {
    const io = meta.io as Partial<ComfyuiIoMapping> & { referenceImage?: ComfyuiIoSlot };
    if (io.referenceImages || !io.referenceImage) return meta;
    const { referenceImage, ...rest } = io;
    void referenceImage;
    return { ...meta, io: { ...rest, referenceImages: [io.referenceImage] } };
}
```

- [ ] **Step 3: `runComfyui` 去掉 fallback**

把 Task 2 Step 3 的（~L322-325）

```ts
    const refSlots = io.referenceImages?.length ? io.referenceImages : io.referenceImage ? [io.referenceImage] : [];
```

改回（`io.referenceImage` 已不存在于类型）：

```ts
    const refSlots = io.referenceImages ?? [];
```

- [ ] **Step 4: 残留扫描 + 验证门禁**

```bash
cd web && bun run typecheck   # 0 NEW
cd web && bun run build
grep -rn "referenceImage" web/src --include=*.ts --include=*.tsx   # 仅应剩 migrateComfyuiMeta 内的 legacy 读取（带注释）
```

- [ ] **Step 5: 提交**

```bash
git add web/src/stores/use-config-store.ts web/src/services/api/comfyui.ts
git commit -m "refactor(comfyui): drop legacy referenceImage field (migrated to referenceImages)"
```

---

### Task 5: 最终门禁核验 + ledger

**Files:** 无（控制器/实现者侧核验）。

- [ ] **Step 1: 全量门禁**

```bash
cd web && bun install && bun run typecheck   # 0 NEW（基线仅 canvas-generation-helpers.ts(51,47)）
cd web && bun run build
```

- [ ] **Step 2: 残留与一致性扫描**

```bash
grep -rn "referenceDataUrl" web/src          # 应为 0（已全部改为 references）
grep -rn "\.referenceImage\b" web/src        # 应为 0（仅 migrateComfyuiMeta 内 legacy 读取用断言访问，无点访问残留）
```

- [ ] **Step 3: 记录 GPU 实跑核验为 DEFERRED**

在 SDD ledger（`.superpowers/sdd/2026-08-09-comfyui-multi-reference/progress.md`）记一条：多 `LoadImage` 工作流的端到端实跑核验**延期**（需远程 ComfyUI `http://10.168.1.109:8188`，仅 `.env.local`）；typecheck + build 为硬门禁。若日后实跑发现 fixup，在 `main` 提交并回填 ledger。

- [ ] **Step 4: 交回 finishing-a-development-branch**

typecheck/build 绿后，用 `superpowers:finishing-a-development-branch` 收尾（本仓库约定直接在 `main`）。

---

## Self-Review（计划作者自检，已完成）

- **Spec 覆盖**：spec §1 数据模型 → Task 1（加）+ Task 4（删旧）；§2 迁移 → Task 1 Step 2/3（已核实 `merge→normalizeChannels→normalizeChannelModels` 在加载时跑，迁移有效）；§3 IO 面板 → Task 3；§4 runComfyui 注入 → Task 2 Step 3；§5 宿主 → Task 2 Step 4（已按 plan 阶段核实修正：仅 `requestEdit`，`requestGeneration` 不改）；§6 输出类型 → Task 3 用 `candidates.referenceImages.length > 0` 门控，audio/text 无 LoadImage 自然不显示。✅
- **占位符扫描**：无 TBD/TODO；每步含具体代码或命令。✅
- **类型一致性**：`referenceImages: ComfyuiIoSlot[]`（store/io-modal/runComfyui 注释统一）；`RunComfyuiArgs.references: string[]`（comfyui.ts 定义 + image.ts 传入 + runComfyui 消费一致）；`defaults.referenceImages` 由 `candidates.referenceImages`（`{id,input}`）映射为 `{node:c.id, input:c.input}`。✅
