# BPMN-DSL Monorepo

Two apps sharing one engine.

```
packages/
  bpmn-core/        @text-to-bpmn/core — DSL → BPMN parser, layout, renderer, validator
apps/
  tfm-lab/          research / thesis editor (live DSL↔canvas, experiments tab)
  company-web/      landing + demo page intended for Vercel deployment
```

## Setup

```sh
pnpm install
```

## Run

| Command | What it does |
|---|---|
| `pnpm dev:tfm` | TFM lab editor on http://localhost:5173 |
| `pnpm dev:company` | Company demo page (Vite default port) |
| `pnpm build` | Build every workspace |
| `pnpm test` | Run every workspace's test suite |

## Engine API

Both apps import from `@text-to-bpmn/core`:

```ts
import { parseDsl, emitBpmnXml, renderSemanticXml, validateBpmnModel, generateDiagram } from "@text-to-bpmn/core";
```

Improvements to parser/layout/rendering inside `packages/bpmn-core/` reach both apps automatically — no copy-paste.

## Deploy `company-web` to Vercel

1. Import this repo in Vercel.
2. Set **Root Directory** to `apps/company-web`.
3. Framework preset: **Vite**. Build command: `pnpm build`. Output: `dist`.
4. Install command: leave default — Vercel detects pnpm workspaces.

## Historical

- `BPMN/` — original standalone HTML demo (with embedded video) + older project snapshot. Visual reference for `company-web`; not built or edited.
- `DLS-BPMN.backup/` — pre-reorg snapshot of the active project. Not in source control.
