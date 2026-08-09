# ComfyUI 多参考图输入设计（第一版）

> 日期: 2026-08-09
> 状态: 设计已确认（brainstorming），待 spec 审阅 → writing-plans
> 关联: `docs/superpowers/plans/2026-08-09-comfyui-protocol.md`（已落地的 ComfyUI 协议第一版）

## 目标

让 ComfyUI 工作流接收**多张参考图**：在画布「一个节点、上游汇成 `references[]`」的现有模型下，把画布传入的参考图组**按顺序位置映射**到工作流的多个 `LoadImage` 槽位，并尊重**每工作流的数量上限**（多了截断、少了留空）。

## 背景

- **画布插件模型**：一个节点把多个上游节点汇成 `references: string[]`，加一条 prompt，按能力（`image`/`video`/`text`/`audio`）调用 `ai.generateImage(prompt, { references, ... })`。见 `web/src/types/canvas-plugin.ts` / `plugins/canvas/sdk/src/types.ts`。
- **ComfyUI 侧现状**：`ComfyuiIoMapping.referenceImage` 是**单槽** `{node,input}`；`runComfyui` 入参 `referenceDataUrl?: string` 只注入一张；`image.ts` 生图分支不传参考图、edit 分支只取 `references[0]`。
- **检测已就绪**：`parseComfyuiPromptNodes`（`comfyui.ts`）已把所有 `LoadImage` 节点收进 `candidates.referenceImages[]`，但映射类型与注入仍是单槽。
- **缺口**：画布能给多图、工作流也能要多个 `LoadImage`，但中间通路只过一张图。

## 范围

**V1（本次）**
- 多张参考图（同类型 `image`）。
- 按顺序**位置映射**：画布 `references[i]` → 工作流第 `i` 个图槽。
- 每工作流**数量上限 = 该工作流的图槽数**；多了截断、少了留空（空槽保留工作流自带值）。

**不在范围（留 V2）**
- 类型化输入槽（蒙版 / 音频片段 / 视频参考等按节点类型区分的槽位）。
- 每槽标签与「画布输入→具名槽」的显式指派 UI。
- 区间式 `min~max` 校验（当前为「上限」语义）。

## 设计

### 1. 数据模型

`ComfyuiIoMapping`：
- `referenceImage?: { node: string; input: string }` → **`referenceImages?: Array<{ node: string; input: string }>`**（有序；`undefined`/空数组 = 无图槽）。

`parseComfyuiPromptNodes` 的 `defaults`：
- 新增 `referenceImages = candidates.referenceImages.map((c) => ({ node: c.id, input: c.input }))`。
- **默认全选所有 `LoadImage`**，顺序 = 检测（`promptJson` 遍历）顺序。→ 上限 = 槽数，顺序 = 检测顺序，用户可在 IO 面板删减/重排。

### 2. 向后兼容 / 迁移

`normalizeChannelModels`（`use-config-store.ts`，C-1 那个 normalizer）：
- 读取时：旧 `referenceImage` → `referenceImages: [referenceImage]`；若已有 `referenceImages` 则以新数组为准；两者皆无 → `undefined`。
- 保证现有单图模型与已保存渠道**无感升级**。

### 3. IO 面板（`comfyui-io-modal.tsx`）

- 参考图区从「单选下拉」改为**有序列表**：每个 `LoadImage` 槽一行，显示节点 id（与类型）。
- **拖拽排序** = 注入顺序（画布第 `i` 张 → 第 `i` 槽）；默认顺序 = 检测顺序。
- **可删除某槽** = 降低该模型的实际上限（把可选 `LoadImage` 拿掉）。
- 无 `LoadImage` → 该区不显示。

### 4. 生成注入（`runComfyui`，`comfyui.ts`）

- 入参 `referenceDataUrl?: string` → **`references?: string[]`**（data URL 数组）。
- 对有序 `referenceImages` 逐槽处理：
  - `i < references.length` → `uploadImage(references[i])` 并 `setNodeInput(graph, referenceImages[i], uploaded.name)`。
  - 否则跳过（该槽保留工作流自带值）。
- `references.length > referenceImages.length` → 多出忽略（截断，不报错）。
- N 张 → N 次 `uploadImage`。

### 5. 宿主接线（`image.ts`）

- **生图分支**（`:744`）：补传 `references`（`await Promise.all(references.map(imageToDataUrl))`；现状不传）。
- **edit 分支**（`:813`）：`references[0]` → 整组 `references`（同上转 dataUrl 数组）。
- **画布节点侧零改动**：节点已汇成 `references[]`。

### 6. 输出类型适配（V1）

- 图槽检测对所有能力执行；只有 `image`/`video` 有意义。
- `audio`/`text` 无 `LoadImage` → `referenceImages` 空 → 不注入。
- 类型化输入槽（蒙版/音频）→ V2。

## 端到端数据流

画布节点（多上游）→ `references[]` → `image.ts`（转 dataUrl 数组）→ `runComfyui` → 按 `referenceImages[]` 顺序注入对应 `LoadImage`（多截断、少留空，空槽保留工作流值）→ `/prompt` → 轮询 `/history` → `/view` 取图。

## 错误处理 / 边界

- 工作流无 `LoadImage`：`referenceImages` 空/`undefined` → 不注入，等同现状。
- 画布 0 张参考图：不注入任何槽，全部保留工作流值。
- 画布张数 > 槽数：截断，不报错（上限语义）。
- 画布张数 < 槽数：前 N 槽注入，余槽保留工作流值。
- 单张上传失败：`uploadImage` 抛错 → `runComfyui` 整体失败，走现有 `submitFailed` / 错误透传（I-1）。
- 旧渠道/旧模型：`normalize` 自动迁移单槽 → 数组。

## 测试要点（实现阶段）

- `normalize`：旧单槽 → 数组；已是数组的模型不被破坏；两者皆无 → `undefined`。
- `runComfyui`：0 张、`< N` 张、`> N` 张三种情况下注入与截断正确。
- IO 面板：拖拽改顺序后注入顺序随之改变；删除某槽后上限下降；无 `LoadImage` 不显示该区。
- 端到端：多上游画布节点 → 多 `LoadImage` 工作流，生成出图。
