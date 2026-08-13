# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read this first

`AGENTS.md` is the **authoritative AI/automation guidance file** for this repo ("开发时优先遵循本文件"). It contains the project's binding conventions (code style, canvas-UI rules, docs workflow, release flow, persistence rules). Follow it. This file covers the architecture and commands that AGENTS.md does not, and should not duplicate its rules — read both.

A few non-obvious rules from AGENTS.md worth keeping top-of-mind: keep code minimal (no speculative generality, no old-data compatibility — the project is pre-launch and local-storage formats may change freely), **do not run build/typecheck/syntax checks after writing code** (the user verifies themselves), do not revert or overwrite the user's existing working-tree changes, and touch only files relevant to the task.

## Project overview

无限画布 (infinite-canvas) — an open-source image-creation workbench. A single-page React frontend puts canvas orchestration, AI image/video/audio generation, reference-image editing, a chat assistant, a prompt library, and asset management in one UI. **There is no project backend**: the browser calls the user's own OpenAI-compatible endpoints directly, and all projects/assets/API keys are stored locally in the browser.

Repo layout (monorepo, each package has its own toolchain):

| Path | Stack | Package manager | Purpose |
|------|-------|-----------------|---------|
| `web/` | Vite 7 + React 19 + TS + Ant Design 6 + Tailwind 4 + Zustand 5 | **bun** | The main app |
| `canvas-agent/` | Node + TypeScript, Express, `@modelcontextprotocol/sdk`, `@openai/codex` | **npm** | `@basketikun/canvas-agent` — local agent bridging the browser ↔ Codex/Claude Code |
| `plugins/canvas/` | TypeScript SDK + per-plugin Vite bundles | npm | Canvas node plugins (html, markdown, svg, sticky-note, panorama, template) |
| `plugins/infinite-canvas/` | — | — | Codex app plugin (registers the MCP) |
| `docs/` | Fumadocs + Next.js | npm | Documentation site |

Root: `VERSION` (current version, e.g. `v0.15.1`), `Dockerfile` + `docker-compose.yml` (build `web/` with bun, serve static via nginx), `nginx.conf`, `CHANGELOG.md`.

## Commands

### web/ (use bun)
```bash
cd web
bun install
bun run dev          # Vite dev server on :3000 (--host 0.0.0.0)
bun run build        # vite build
bun run typecheck    # tsc --noEmit
bun run format       # prettier --write .
bun run format:check
```
`bun run typecheck` only works after `bun install` — a missing `i18next` install produces fake `string | undefined` errors at every `i18n.t(...)` call site. If typecheck looks globally broken, install deps first.

### canvas-agent/ (use npm)
```bash
cd canvas-agent
npm install
npm run build        # tsc -p tsconfig.json  → dist/
npm test             # node --test over a fixed list of *.test.ts files (see package.json)
npm run dev          # tsx src/index.ts  (--debug for verbose logging)
node dist/index.js        # start HTTP agent (default :17371, 127.0.0.1 only)
node dist/index.js mcp    # run as MCP stdio server instead
```

### docs/ (use npm)
```bash
cd docs && npm install
npm run dev          # next dev
npm run build
npm run types:check  # fumadocs-mdx && next typegen && tsc --noEmit
```

### Docker (whole app)
```bash
docker compose up -d    # builds web/, serves on :3000
```

There is no test framework in `web/`. `canvas-agent/` uses `tsx --test` against an explicit, hardcoded file list in the `test` script of `canvas-agent/package.json` — add new `*.test.ts` files to that script string (Node's built-in `node:test` runner, executed via `tsx` for TS). Run a single test file directly with `npx tsx --test src/canvas/session.test.ts` from `canvas-agent/`.

## Architecture

### Frontend (web/src/)
- **No backend assumption.** All external calls live in `web/src/services/api/` (`image.ts`, `video.ts`, `audio.ts`, `comfyui.ts`, `canvas-agent.ts`, `prompts.ts`, `model-plugin.ts`) and are made directly from the browser. Do not introduce a project backend.
- **State** — Zustand stores in `web/src/stores/`. Cross-page/global state goes here; components consume stores/hooks directly rather than receiving them as props (avoid prop-drilling and pass-through wrapper components). Canvas-specific state is under `stores/canvas/`: `use-canvas-store.ts` (persisted project data — see below), `use-canvas-ui-store.ts` (ephemeral UI state), `use-plugin-store.ts`.
- **Canvas engine** (`web/src/lib/canvas/`):
  - Project persistence lives in `stores/canvas/use-canvas-store.ts` (not under `lib/`) — Zustand `persist` to `localforage` under `infinite-canvas:canvas_store`, with a **400ms debounced write**. A project = `{ nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo, viewport:{x,y,k} }`. Node positions/sizes are in canvas-world coordinates; edges store only node IDs.
  - `node-registry.ts` — runtime registry of node definitions (builtin + plugin-owned); a version counter bumps on register/unregister so creation menus re-render.
  - `canvas-event-bus.ts` — pub/sub between nodes/plugins, plus per-plugin isolated `localforage` storage.
  - `plugin-loader.ts` / `plugin-runtime.ts` / `plugin-registry.ts` — load remote plugins by URL; the TS SDK lives in `plugins/canvas/sdk`.
  - `canvas-node-factory.ts`, `canvas-node-geometry.ts`, `canvas-node-size.ts`, `canvas-resource-references.ts`, `canvas-export.ts`, `canvas-generation-helpers.ts` — node creation, layout, media references, export, generation orchestration.
- **Routes** (`router.tsx`): `/` home, `/image`, `/video`, `/assets`, `/prompts`, `/canvas` (project list), `/canvas/:id` (project), `/config`. Pages in `pages/`, layouts in `layouts/`.
- **Persistence** — business data (projects, assets, generation history, images, base64) uses **`localforage`**, not `localStorage` (the latter is only for tiny config). Image/media blobs live in `image_files` / `media_files`; project JSON stores `storageKey` + metadata, never large base64. Cleanup is reference-counted: deleting an entity collects all still-referenced storage keys and removes only unreferenced blobs.

### ComfyUI integration (web/src/services/api/comfyui.ts)
ComfyUI requests are **same-origin through the Vite dev proxy** at `/comfyui/*`, with the real target address passed in the `x-comfyui-target` header (this is the active development area — see recent commits). ComfyUI saves two JSON shapes:
- **Prompt/API format** (`{ "<id>": { class_type, inputs } }`) — submittable directly.
- **Graph format** (`{ nodes, links }`) — must be converted to prompt format before submission. `detectWorkflowFormat()` distinguishes them; the conversion handles widgets→inputs, link wiring, and carries widget values.

### Canvas Agent (canvas-agent/src/)
A single Node entrypoint (`index.ts`) selects a mode via `argv`:
- default → `startHttpServer()` — Express on `127.0.0.1` only (default `:17371`); bridges the browser to `@openai/codex`'s `codex app-server --stdio`, streaming `thread.*` / `turn.*` / `item.*` events to the sidebar over SSE. A Claude Code adapter exists (`agent/claude.ts`) but the sidebar currently only exposes Codex.
- `mcp` → `startMcpServer()` — stdio MCP server exposing `canvas_get_state`, `canvas_get_selection`, `canvas_export_snapshot`, `canvas_apply_ops`, `canvas_create_text_node`, `canvas_create_image_prompt_flow`. Schemas are `zod`; tools operate on the live canvas session.

It binds only to localhost and pins the first connecting Origin (token-gated); other Origins are rejected unless cleared in `~/.infinite-canvas/canvas-agent.json`. **Agent message storage rules** (from AGENTS.md): messages are keyed by `threadId` + `turnId` + `itemId`; live events only fill un-materialized turns — once a history snapshot is authoritative, do not re-merge. Protocol version and storage version are managed **independently**; back up before any storage migration and refuse to overwrite on unknown version / corrupt manifest / conflicting backup (never silently trim metadata).

### Theming
Ant Design theme tokens, canvas palette, and popup (Dropdown/Menu/Select/Cascader/TreeSelect) backgrounds are configured globally in `web/src/lib/app-theme.ts`, `web/src/lib/canvas-theme.ts`, and `AppProviders`. Canvas UI must use `canvasThemes` / `useThemeStore` / the antd `ConfigProvider` token — do not hardcode stone/slate/black/white. See the "画布 UI 规范" section of AGENTS.md.

## Docs & release workflow

- `README.md` stays brief; `docs/index.md` is the AI-facing doc index; feature detail goes in `docs/content/docs/overview/features.mdx`; TODOs in `progress/todo.mdx`; things built but pending user test confirmation in `progress/pending-test.mdx`. Every user-visible change adds a `[新增]`/`[调整]`/`[修复]`/`[优化]` line to the `Unreleased` section of `CHANGELOG.md`; pure internal refactors need not.
- **Release flow** (AGENTS.md): fold `Unreleased` into a new versioned section, leave an empty `Unreleased`, bump root `VERSION`, commit everything, then tag `vX.Y.Z`. Do not run build/test/lint during release unless explicitly asked. `canvas-agent` versions independently on npm (its own `package.json`, published by GitHub Actions on `main`).
