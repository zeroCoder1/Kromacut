# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Kromacut

Kromacut is a browser-based tool for converting images into stacked, color-layered 3D prints (lithophanes). Users upload an image, reduce it to a small color palette via quantization algorithms, configure per-color layer heights and ordering, preview in 3D, and export to STL or 3MF for multi-material printing.

Key domain concepts:
- **Transmission Distance (TD):** Models how light transmits through thin filament layers; used by the auto-paint algorithm to simulate multi-filament lithophane effects via Beer-Lambert law optical simulation.
- **Greedy meshing:** Maximal rectangle algorithm generates optimized 3D geometry with separate wall generation to prevent T-junctions.
- **Quantization algorithms:** Posterize, median-cut, K-means, octree, and Wu methods for color reduction.

## Commands

```bash
npm run dev        # Start Vite dev server
npm run build      # TypeScript check + Vite production build
npm run lint       # ESLint with zero warnings policy (--max-warnings=0)
npm run lint:fix   # ESLint with auto-fix
npm run format     # Prettier format all src files
npm run preview    # Preview production build locally
```

No test framework is configured.

## Architecture

**Stack:** React 19 + TypeScript + Vite + Three.js + Tailwind CSS v4 + Shadcn/Radix UI

**Path alias:** `@/*` maps to `./src/*`

### Code organization

- `src/components/` — React UI components. `App.tsx` is the root, holds top-level state.
- `src/components/ui/` — Shadcn/Radix primitive components (buttons, sliders, popovers, etc.).
- `src/hooks/` — Custom hooks that encapsulate business logic and state management:
  - `useSwatches` — Async image histogram computation with cancellation
  - `useQuantize` — Color quantization algorithm dispatch
  - `useThreeScene` — Three.js scene setup, camera, controls, render loop
  - `useAppHandlers` — STL/3MF export orchestration, image download
  - `useImageHistory` — Undo/redo stack
  - `useDropzone` — Drag-and-drop file upload
- `src/lib/` — Pure algorithmic logic (no React dependencies):
  - `algorithms.ts` — All quantization algorithms (K-means, median-cut, octree, Wu)
  - `meshing.ts` — Greedy mesh generation for 3D geometry
  - `autoPaint.ts` — Auto-paint layer stacking algorithm using TD and Beer-Lambert law
  - `exportStl.ts` — Binary STL file generation
  - `export3mf.ts` — 3MF multi-material export (uses JSZip)
  - `applyAdjustments.ts` — Image adjustment filters (exposure, contrast, saturation, etc.)
  - `color.ts` — RGB/HSL/Lab color space conversions
- `src/data/palettes.ts` — Predefined color palettes

### Data flow

State lives in `App.tsx` and flows down through props. The pipeline is:

1. Image upload → `useDropzone` / `useImageHistory`
2. Adjustments applied → `applyAdjustments.ts` on offscreen canvases
3. Quantization → `useQuantize` dispatches to algorithm in `algorithms.ts`
4. Swatch management → `useSwatches` computes histogram, user reorders via dnd-kit
5. 3D preview → `useThreeScene` builds geometry via `meshing.ts`, renders with Three.js
6. Export → `useAppHandlers` calls `exportStl.ts` or `export3mf.ts`

Canvas rendering uses dual offscreen canvases (`originalCanvasRef`, `processedCanvasRef`) for non-destructive adjustment processing. `CanvasPreview` and the Three.js scene expose imperative handles via `useImperativeHandle`.

### Rendering details

- Three.js BufferGeometry with per-face (non-indexed) triangles so each color slice is a solid block.
- `CanvasTexture` with `NearestFilter` and disabled mipmaps for crisp pixel mapping.
- STL/3MF export uses chunked processing with `setTimeout(_, 0)` to keep the UI responsive.

## Code style

- **Prettier:** 4-space indentation, single quotes, trailing commas (es5), semicolons, 100-char print width.
- **ESLint:** Zero warnings policy. `no-console` warns (allows `warn`/`error`). Unused vars warn (underscore-prefixed args ignored).
- **Naming:** PascalCase for components/types, camelCase for hooks/functions, UPPER_SNAKE_CASE for constants.
- **Hooks-first architecture:** No class components. Business logic extracted into custom hooks. Event handlers stabilized with `useCallback`.
- **TypeScript strict mode** enabled. Explicit interfaces for component props and shared types.
