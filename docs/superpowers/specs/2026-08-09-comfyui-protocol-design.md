# ComfyUI 协议一等公民集成 · 设计稿

- 日期:2026-08-09
- 状态:已认可,待实现计划
- 目标项目:`infinite-canvas`(`web/` 前端,React 19 + Vite 7 + TS + Ant Design 6 + Zustand)
- 目标 ComfyUI:0.30.2,远程 `http://10.168.1.109:8188`,RTX 4090,`--lowvram`

## 1. 背景与目标

当前 `infinite-canvas` 只支持 OpenAI/Gemini/Ark 三种「协议(apiFormat)」,图像生成走 OpenAI 兼容的 `/v1/images/generations`。用户希望把 ComfyUI 作为一等公民协议接入,使工作流能像模型一样被选择、配置 IO、调用。

### 用户需求(逐字)

1. 渠道中协议增加 `comfyui`,专门为 ComfyUI 设置一个。
2. Base URL 就是 ComfyUI 的真实地址。
3. 点击「拉取模型」时,获取 ComfyUI 工作流栏中的所有工作流列表。
4. 添加模型则确定使用的工作流。
5. 添加模型后,渠道模型中把「调用脚本」变成「选择输入输出节点」,作为 ComfyUI 渠道模型的输入输出配置。
6. 能力类型保留,用来区分输出类型。

### 已确认的决策

- **工作流来源**:先尝试服务端工作流列表;失败回退 JSON 导入。
- **代理范围**:本地/dev 动态代理即可,生产静态构建暂不支持 ComfyUI(用户当前即当本地工具用)。

## 2. 关键技术现实:工作流两种格式

ComfyUI 有两种工作流 JSON,结构完全不同:

| 格式 | 来源 | 结构 | 能否直接提交 `/prompt` |
|------|------|------|------|
| **Graph 格式** | 工作流栏保存的画布状态 | `nodes[]` / `links[]` / `widgets_values` | ❌ 需转换 |
| **Prompt/API 格式** | 菜单「Save (API Format)」导出 | `{nodeId: {class_type, inputs}}` | ✅ 可直接提交 |

工作流栏里所有工作流都是 **Graph 格式**,不能直接发给 `/prompt`。因此需求③要真正可运行,必须做 **Graph → Prompt 格式转换**(依赖 `/object_info` 节点定义)。这是方案中最复杂、最易出 bug 的部分;ComfyUI 自身前端在这块逻辑也较复杂。

「失败回退导入」与该现实契合:能转换则用列表,转不了则提示用「Save (API Format)」手动导入。**导入的 API 格式是 100% 可靠的基石。**

## 3. 架构总览

- **内部统一格式 = Prompt/API 格式**:无论工作流来自服务端列表还是导入,进入系统后统一转成 Prompt 格式,存入 `ChannelModel`。IO 解析、注入、调用只面对这一种格式。
- **动态代理**满足需求②:浏览器同源调 `/comfyui/*`,Vite 中间件从请求头 `x-comfyui-target` 读取 UI 里填的真实地址并转发;改地址无需重启。
- **数据流**:`拉取/导入工作流 → 转 Prompt 格式 → 存 model.comfyui.promptJson → 选 IO 节点存 model.comfyui.io → 调用时按 io 注入 promptJson → /prompt → 轮询 /history → /view 取图`。

## 4. 详细设计

### 4.1 类型与配置(`web/src/stores/use-config-store.ts`)

```ts
export type ApiCallFormat = "openai" | "gemini" | "ark" | "comfyui";

// 所有「注入点」统一为 {node, input},node=工作流内节点 id,input=该节点的输入名。
export type ComfyuiIoSlot = { node: string; input: string };

export type ComfyuiIoMapping = {
  promptText: ComfyuiIoSlot;        // 正向 prompt({node: CLIPTextEncode 的 id, input: "text"})
  negativeText?: ComfyuiIoSlot;     // 可选负向 prompt
  referenceImage?: ComfyuiIoSlot;   // 图生图参考图({node: LoadImage 的 id, input: "image"})
  width?: ComfyuiIoSlot;            // 宽(如 EmptyLatentImage.width)
  height?: ComfyuiIoSlot;           // 高
  seed?: ComfyuiIoSlot;             // 种子(如 KSampler.seed)
  outputNode: string;               // 读结果的输出节点 id(裸 nodeId,如 SaveImage 的 id)
};

export type ComfyuiModelMeta = {
  promptJson: Record<string, any>;   // 转换后的 Prompt 格式工作流
  io: ComfyuiIoMapping;
  source?: "server" | "import";
};

export type ChannelModel = {
  name: string;
  capability: ModelCapability;
  script?: string;
  comfyui?: ComfyuiModelMeta;   // 仅 comfyui 协议使用
};
```

配套改动:
- `defaultBaseUrlForApiFormat("comfyui")` → `http://localhost:8188`。
- `normalizeApiFormat`:接受 `"comfyui"`。
- `isAiConfigReady`:对 comfyui 渠道**放宽**——`apiKey` 非必填(ComfyUI 常无鉴权),只要 `model` 与 `baseUrl` 有值即视为就绪。
- `buildApiUrl` **不适用** comfyui(它不挂 `/v1`);comfyui 的 URL 由 `services/api/comfyui.ts` 自行拼接。
- `guessCapability`:新增 comfyui 模型默认 `image`,用户可在渠道编辑器里改。
- `ChannelModel` 序列化进 Zustand persist 无需特殊处理(`comfyui` 字段为普通对象)。

### 4.2 动态代理(`web/vite.config.ts`)— 需求②

把现有**静态** `server.proxy["/comfyui"]` 替换为**运行时中间件**插件 `comfyuiDynamicProxy`:

- 拦截同源 `/comfyui/*`(以及 discovery/preflight)。
- 从请求头 `x-comfyui-target` 读取真实地址(= UI 里填的 `baseUrl`,如 `http://10.168.1.109:8188`)。
- 转发到 `${target}${去掉 /comfyui 前缀后的路径}`,`changeOrigin: true`。
- 改地址**无需重启**;`.env.local` 的 `COMFYUI_URL` 仅作 header 缺省时的兜底默认值。
- 新增依赖 `http-proxy`(Vite 内部已用,但不导出;显式声明更稳)。
- 同源请求不触发 CORS,无需额外 CORS 头。

前端 comfyui 调用统一走同源前缀:`/comfyui/prompt`、`/comfyui/history/{id}`、`/comfyui/view`、`/comfyui/upload/image`、`/comfyui/object_info`、`/comfyui/api/userdata/workflows`,均带 `x-comfyui-target` 头(取自 `channel.baseUrl`)。

### 4.3 工作流获取(`web/src/services/api/comfyui.ts`,新建)— 需求③④

```
fetchComfyuiWorkflows(channel): Promise<{name, promptJson, ok, reason?}[]>
  1. GET /api/userdata/workflows?recurse=true            // 拉文件名列表
     - 成功且非空 → 逐个 GET /api/userdata/workflows/{name} 取内容
     - 任一步失败 / 列表为空 / 接口不可用 → 抛特定错误,UI 自动露出「导入 JSON」入口
  2. 对每个工作流:convertGraphToPrompt(graph, objectInfo)
     - objectInfo 由 getObjectInfo() 取并按 channel 缓存
  3. 返回结果;转换失败的工作流 ok=false、带 reason
```

**导入路径(可靠基石)**:用户粘贴/上传 JSON;`detectWorkflowFormat` 判别:
- Prompt 格式(顶层是 `{nodeId: {class_type, inputs}}`)→ 直用。
- Graph 格式(有 `nodes`/`links`)→ `convertGraphToPrompt` 转换。

### 4.4 Graph → Prompt 转换(`convertGraphToPrompt`)

输入:Graph JSON + 该 channel 的 `objectInfo`。算法:

1. 建 `link` 映射:`link_id → [origin_node_id, origin_slot]`。
2. 对每个 node:
   - `class_type = node.type`。
   - 从 `objectInfo[class_type]` 取 `input.required` 与 `input.optional`,得到「具名输入定义 + widget 顺序」。
   - **连线输入**:遍历 `node.inputs[]`,凡 `link != null`,查 link 映射得 `[origin_id, origin_slot]`,写入 `inputs[input.name]`。
   - **widget 输入**:按 objectInfo 的 widget 顺序,把 `node.widgets_values[]` 依次填入对应 `inputs[name]`。
3. 输出 `{ [node_id]: { class_type, inputs } }`。
4. 单节点类型在 objectInfo 中缺失或 widget 数对不上 → 该工作流标记转换失败(`ok=false`),提示「请用 Save (API Format) 手动导入」。

健壮性边界:对非标准 widget 顺序/自定义节点 best-effort;P1 再增强。失败不阻断导入路径。

### 4.5 IO 节点选择 UI(新组件 `web/src/components/layout/comfyui-io-modal.tsx`)— 需求⑤

解析 `model.comfyui.promptJson` 提取候选并让用户映射:

- **文本输入**:`inputs.text`(或同类字面量字符串输入)为字面量的节点(典型 `CLIPTextEncode`)→ 选一个接正向 prompt;可选负向。
- **参考图**:`class_type === "LoadImage"` 节点 → 图生图时接参考图。
- **参数**(可保持默认):`KSampler.seed`、`KSampler.denoise`、`EmptyLatentImage`/`EmptySD3LatentImage` 的 `width`/`height`/`batch_size`。
- **输出节点**:按 `model.capability` 过滤——
  - image:`SaveImage`、`PreviewImage`
  - video:`SaveAnimatedPNG`、`VHS_VideoCombine`
  - audio:`SaveAudio`(P2)
  
映射写入 `model.comfyui.io`。

UI 落点:渠道模型行原有的「脚本/脚本就绪」按钮,在 comfyui 协议下替换为「输入输出节点」按钮,点击打开本 Modal。

### 4.6 结构化调用(`runComfyui`,在 `services/api/comfyui.ts`)— 替代 JS 插件脚本

```
runComfyui(channel, model, { prompt, negativePrompt?, referenceImage?, size? }): Promise<图片[]>
  1. 深拷贝 model.comfyui.promptJson
  2. 按 io 映射注入:
     - prompt → promptText 节点的 inputs.text
     - negativePrompt → negativeText 节点
     - referenceImage → /upload/image 取 {name,subfolder,type},填入 LoadImage 节点 inputs.image
     - seed 随机;size(若有 width/height 映射)覆盖
  3. POST /comfyui/prompt  { prompt, client_id }  → { prompt_id }
  4. 轮询 GET /comfyui/history/{prompt_id} 直到 outputs[outputNode] 就绪
  5. 按 io.outputNode 取 outputs[outputNode].images / .gifs
     逐个 GET /comfyui/view?filename=&subfolder=&type= → 转 dataUrl/url 返回
```

轮询沿用既有节奏(intervalMs≈1000,timeoutMs≈300000,`--lowvram` 首帧约 48s)。

调用点(`web/src/services/api/image.ts`):
- `fetchImageModels`:加 `apiFormat === "comfyui"` 分支 → `fetchComfyuiWorkflows`(返回工作流作为"模型")。
- `requestGeneration` / `requestEdit`:加 `apiFormat === "comfyui"` 分支 → `runComfyui`。这两个函数现行的 `resolveModelScript`→`runModelPlugin` 逻辑对 comfyui 不走;comfyui 用结构化 `io` 而非 JS 脚本。

### 4.7 能力区分 — 需求⑥

输出候选按 `model.capability` 过滤(见 4.5)。新增 comfyui 模型默认 `image`,用户可在渠道编辑器里改为 video/audio,从而只显示对应类型的输出节点。

## 5. 文件改动清单

| 文件 | 改动 |
|------|------|
| `web/src/stores/use-config-store.ts` | `ApiCallFormat += "comfyui"`;新增 `ComfyuiIoMapping`/`ComfyuiModelMeta`;`ChannelModel.comfyui`;`defaultBaseUrlForApiFormat`/`normalizeApiFormat`;`isAiConfigReady` 放宽 apiKey |
| `web/vite.config.ts` | 静态 proxy → `comfyuiDynamicProxy` 中间件(读 `x-comfyui-target`) |
| `web/package.json` | 新增依赖 `http-proxy` |
| `web/src/services/api/comfyui.ts`(新) | `fetchComfyuiWorkflows`/`convertGraphToPrompt`/`detectWorkflowFormat`/`getObjectInfo`/`parseComfyuiPromptNodes`/`runComfyui` + 同源 URL/请求封装 |
| `web/src/services/api/image.ts` | `fetchImageModels`/`requestGeneration`/`requestEdit` 各加 comfyui 分支 |
| `web/src/components/layout/channel-editor-drawer.tsx` | apiFormat 选项加 comfyui;comfyui 时 apiKey 可空、模型行「脚本」按钮换「输入输出节点」 |
| `web/src/components/layout/comfyui-io-modal.tsx`(新) | IO 节点选择 Modal |
| `web/src/components/layout/model-select-modal.tsx` | comfyui 渠道:fetch 走工作流列表 + 提供「导入 JSON」入口 |
| `web/.env.example` / `web/.env.local` | `COMFYUI_URL` 改为「header 缺省兜底」语义说明(保留) |
| i18n 文案(`web/src/i18n/*`) | comfyui 协议名、输入输出节点、导入工作流等文案 |

## 6. 端到端数据流

```
配置渠道(协议=comfyui, baseUrl=http://10.168.1.109:8188)
  → 添加模型 = 拉取/导入工作流
     → 服务端列表(GET /api/userdata/workflows + 转换) 或 导入(Save API Format JSON)
        → 存 model.comfyui.promptJson(source=server|import)
  → 点「输入输出节点」→ 解析候选 → 用户映射 → 存 model.comfyui.io
生成时
  → requestGeneration(comfyui 分支) → runComfyui
     → 注入 promptJson → POST /comfyui/prompt → 轮询 /comfyui/history → /comfyui/view 取图
全部同源,x-comfyui-target 头指向真实地址;Vite 中间件转发到 ComfyUI。
```

## 7. 错误处理

- 工作流列表 API 不可用/为空 → 不报错阻断,UI 直接露出导入入口,提示「未读取到服务端工作流,请导入 API 格式 JSON」。
- Graph→Prompt 转换失败(缺节点定义/widget 数不符)→ 该工作流标记不可用,提示手动导入;其余工作流正常。
- `/prompt` 返回节点缺失必填输入(如 ComfyUI 0.30 的 `SaveImage.filename_prefix` 必填)→ 在注入阶段补全已知必填默认值(`filename_prefix="infinite_canvas"`),并在错误信息里透传 ComfyUI 的 node error。
- 轮询超时(300s)→ 抛出超时错误,UI 提示重试(`--lowvram` 首帧较慢)。
- 代理目标不可达(ComfyUI 未启动)→ 透传网络错误,提示检查地址。

## 8. 阶段划分

- **P0(本次实现)**:comfyui 协议 + 动态代理 + 导入(API 格式,可靠)+ 服务端列表(best-effort 转换)+ IO 节点选择 UI + 结构化调用 + image 能力过滤。
- **P1**:转换器对更多节点类型/自定义 widget 的健壮性;尺寸/批量参数化面板;video(`SaveAnimatedPNG`/`VHS_VideoCombine`)输出读取与预览。
- **P2**:audio 工作流(`SaveAudio`)。

## 9. 不在范围

- 生产(静态构建)下的 ComfyUI 支持——需要独立代理服务,本次不做。
- 在画布内可视化编辑 ComfyUI 工作流图——超出范围,只做「选择已有工作流 + 配 IO」。
- ComfyUI 鉴权(基本无;若需可后续在 channel 上加可选 header)。
