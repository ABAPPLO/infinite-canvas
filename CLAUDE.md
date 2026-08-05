# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

无限画布 (infinite-canvas) — a browser-first, frontend-only open workbench for image creation. It combines an infinite canvas, AI image/video/audio generation, a chat assistant, a prompt library, and an asset store into one UI. There is **no project backend** serving the app: the built frontend is static (nginx / Vite preview / Vercel / Render), and AI requests go **directly from the browser** to the user's own OpenAI-compatible endpoint (Base URL + API Key stored in `localStorage`). Local persistence of business data (canvases, assets, generation history) uses `localforage` (IndexedDB); optional WebDAV sync.

The project is pre-release and does not guarantee data compatibility across versions — local storage formats may change without migration.

> **Read `AGENTS.md` first.** It is the authoritative source for AI/automated development rules in this repo (frontend conventions, canvas UI rules, docs workflow, release flow) and takes priority over this file. This file covers commands, architecture, and the big picture only.

## Commands

```bash
# Frontend (primary app, in web/)
cd web
bun install
bun run dev            # Vite dev server on http://localhost:3000 (host 0.0.0.0)
bun run build          # Production build -> web/dist
bun run start          # vite preview on :3000
bun run typecheck      # tsc --noEmit (no build artifacts, just type errors)
bun run format         # prettier --write .
bun run format:check   # prettier --check .

# Docker
docker compose -f docker-compose.local.yml up -d --build   # local image build, :3000
docker compose up -d                                       # pull prebuilt ghcr image, :3000
# Optional analytics via environment: ANALYTICS_GA4_ID, ANALYTICS_BAIDU_ID

# Canvas Agent (local Node bridge between the web app and Codex/Claude Code, in canvas-agent/)
cd canvas-agent
npm install
npm run build         # tsc -> dist/
node dist/index.js    # start HTTP agent server (default 127.0.0.1:17371, prints Local URL + Connect token)
npm run test          # tsx --test src/canvas-session.test.ts (only test in the repo)
npm run dev           # tsx src/index.ts (run without build)
# MCP mode (registers canvas tools into Codex/Claude): node dist/index.js mcp
```

There is **no test framework for the frontend** — no tests exist there. The only test is `canvas-agent`'s session test run via `tsx --test`. Per `AGENTS.md`, do not run build/test/typecheck after writing code; the user does that themselves.

Package manager: **bun** for `web/`, **npm** for `canvas-agent/` and plugins. The Docker build uses `oven/bun` for the web stage.

## High-level architecture

### Three independent build targets

This repo is not one app — it produces three separately-versioned, separately-built artifacts:

1. **`web/`** — the main React app (Vite + React 19 + TypeScript + Ant Design 6 + Tailwind 4 + Zustand). Versioned by root `VERSION` (currently `v0.14.0`). This is what gets deployed.
2. **`canvas-agent/`** — a standalone npm package `@basketikun/canvas-agent` (Express 5 + `@modelcontextprotocol/sdk` + `@openai/codex`). It has its own `package.json` version (currently `0.5.0`), independent of root `VERSION`. Published to npm via GitHub Action when the version isn't already on npm.
3. **`plugins/canvas/`** — canvas node plugins (markdown, svg, html, panorama, sticky-note, …) each built with `@infinite-canvas/plugin-sdk` into ESM bundles the host loads. `plugins/infinite-canvas/` is the Codex app plugin (skills + assets). `plugins/canvas/registry` is the official plugin list consumed by the in-app plugin panel.

### Frontend layout (`web/src/`)

Routes (`router.tsx`): `/` home, `/image` image workbench, `/video` video workbench, `/assets` asset library, `/prompts` prompt center, `/canvas` canvas list, `/canvas/:id` canvas project, `/config` settings. All under `UserLayout`.

Key conventions (details in `AGENTS.md`, summarized because they shape how code is organized):
- **External API calls live in `web/src/services/api/`** — the browser calls OpenAI-compatible endpoints directly; never assume a project backend exists.
- **Cross-page state in `web/src/stores/`** (Zustand); canvas-specific state in `web/src/stores/canvas/` (`use-canvas-store`, `use-canvas-ui-store`, `use-plugin-store`).
- **Canvas code is split by concern**: components in `components/canvas/`, tooling in `lib/canvas/` (node factory, geometry, export, plugin runtime/registry/loader, agent ops, event bus), store in `stores/canvas/`.
- Pages live in `web/src/pages/<page>/index.tsx`; page-private hooks/components stay in that page dir, only truly shared ones move up to `hooks/` or `components/`.
- **Persistence**: `localforage` for business data; `localStorage` only for tiny config. Never store lists/images/base64/large JSON in `localStorage`.

### Canvas node system (builtin + plugins)

Nodes are defined by a `CanvasNodeDefinition` (type, title, icon, defaultSize, render). Builtin node definitions are registered with owner `"builtin"`; plugin nodes with the plugin id. The registry is a Zustand store (`node-registry.ts`) with a version counter that bumps on register/unregister to drive create-menu re-renders.

`plugin-runtime.ts` / `plugin-loader.ts` / `plugin-registry.ts` handle loading remote ESM plugins over URL, installing/enabling/updating/uninstalling them, and bridging plugin calls back into the host (React is external — host supplies a single React instance). The plugin SDK (`@infinite-canvas/plugin-sdk`) gives plugin authors full types, `definePlugin()`, JSX that forwards to host React, and a one-line `buildPlugin()` esbuild builder.

### Canvas Agent ↔ web app ↔ Codex/Claude

The local Canvas Agent is the bridge that lets an AI agent operate the canvas:

- **HTTP server** (`server/http.ts`, default `127.0.0.1:17371`): the web app connects with a `Connect token`. Origins are gated by an **allow-list** (`config.origins`), not a single pin — any origin that presents the correct token once is added to the list and then allowed without the token; origins never admitted are rejected with 403. Clear `~/.infinite-canvas/canvas-agent.json` to reset. Notable routes: `/canvas/state` + `/canvas/activate` (per-`clientId` canvas snapshots, single active client — see multi-client note below), `/agent/local-image` (stream a local file's bytes), and `/agent/fetch` (CORS proxy — see the gotcha).
- **MCP server** (`server/mcp.ts`, `mcp` arg): exposes canvas tools (`canvas_get_state`, `canvas_get_selection`, `canvas_export_snapshot`, `canvas_apply_ops`, `canvas_create_text_node`, `canvas_create_image_prompt_flow`) to Codex/Claude via the official MCP SDK. Tools use zod schemas.
- **Codex sidebar**: the agent spawns `codex app-server --stdio` via `@openai/codex` (adapters in `agent/codex.ts` / `agent/codex-client.ts`; a Claude Code adapter exists in `agent/claude.ts` but the sidebar currently only exposes Codex). It injects the `infinite-canvas` MCP config with auto-approval and forwards structured events (`thread.started`, `turn.started`, `item.*`, `turn.completed`) to the web sidebar. `item/agentMessage/delta` is converted to `item.updated` so the web side streams from one message. Image attachments from the sidebar are written to temp files locally and passed to app-server as `localImage` (30MB request cap). Live turn events and the materialized thread history are unified by `threadId`/`turnId`/`itemId` (see the rule in `AGENTS.md`'s 项目注意事项) so multi-tab/refresh races don't double-merge messages.
- **Codex Skills** (`skills/store.ts` + web `stores/use-agent-skill-store.ts`, `components/agent/agent-skills-view.tsx`, `agent-skill-picker.tsx`): the agent manages local Codex Skills (view/create/edit/delete/toggle/invoke) and can generate an editable Skill draft from the current conversation or canvas; the user confirms before it is saved. Skill changes sync across tabs. During draft generation the live MCP canvas is isolated, the temporary task can be stopped, and concurrent Skill mutations are blocked.

### Plugin install paths for the agent

- Codex app plugin: `codex plugin marketplace add "$(pwd)"` then `codex plugin add infinite-canvas@infinite-canvas-local` (use absolute paths).
- Manual MCP (Codex): `codex mcp add infinite-canvas -- npx -y @basketikun/canvas-agent mcp` (dev: `-- node /abs/canvas-agent/dist/index.js mcp`).
- Manual MCP (Claude Code, user scope): `claude mcp add --scope user --transport stdio infinite-canvas -- npx -y @basketikun/canvas-agent mcp`.

## Docs & release workflow

Docs are MDX under `docs/content/docs/`; `docs/index.md` is the AI-facing index. Progress docs: `progress/todo.mdx` (planned), `progress/pending-test.mdx` (done but awaiting user test), `overview/features.mdx` (user-confirmed). Work moves todo → pending-test → features. Every user-visible change adds a Chinese one-liner to `CHANGELOG.md` `Unreleased` with a `[新增]/[调整]/[修复]/[优化]` prefix.

Release flow (per `AGENTS.md`): fold `Unreleased` into a new version section, bump root `VERSION`, commit all changes, tag `vX.Y.Z`. Do **not** build/test/compile during release unless explicitly asked. The `canvas-agent` npm version is independent and published by CI, not part of this flow.

## Project-specific gotchas

- The app has **no backend** despite the deployment options — do not write code that assumes a project server. All AI calls are browser→user's OpenAI-compatible endpoint.
- API Key lives in the browser and the browser makes the calls directly — reflect this in any security-related text.
- Canvas projects and "我的素材" are browser-local; WebDAV sync is opt-in. Do not document cloud sync as supported.
- Docker static-asset paths are still a known TODO — don't over-promise production Docker as fully validated.
- Canvas UI must follow the active theme (`canvasThemes`, `useThemeStore`, antd `ConfigProvider` tokens). Never hardcode `stone`/`slate`/black/white. See the "画布 UI 规范" section of `AGENTS.md` for the full flat/minimal styling rules.
- **CORS on remote result URLs**: when an AI provider returns a result file as a hosted `item.url` (instead of inline `b64_json`), persisting it to IndexedDB requires `fetch(url).blob()`, which the browser blocks if that CDN sends no `Access-Control-Allow-Origin`. First line of defense is requesting `response_format: "b64_json"` (already done for images); when only a URL is available, the local canvas-agent acts as a same-machine proxy via `POST /agent/fetch { url }` (Node fetch, not subject to browser CORS), guarded by the token + origin allow-list, 30s timeout, 30MB cap, http(s)-only. Web side routes these through `fetchBlob()` in `web/src/services/blob-fetch.ts` (used by `image-storage`, `file-storage`, `audio` plugin path); it falls back to direct `fetch` when the agent is not connected.
- **Multi-frontend + single active canvas**: multiple browser tabs/origins can connect to the agent simultaneously (each gets a `clientId`), but only one `activeClientId` at a time is what the MCP/Codex tools operate on; `POST /canvas/activate` (fired on tab focus) switches it, and `POST /canvas/result` returns 409 for non-active clients so cross-client tool results don't bleed. Conversation history is shared across tabs and unified by `threadId`/`turnId`/`itemId` (see `AGENTS.md` 项目注意事项).
