<img align="left" height="125" width="125" src="./content/logo.png">

# Kromacut

[![Patreon](https://img.shields.io/badge/Patreon-Support-orange?logo=patreon&logoColor=white)](https://www.patreon.com/cw/vycdev) [![Discord](https://img.shields.io/badge/Discord-Join%20Chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/nU63sFMcnX) [![YouTube](https://img.shields.io/badge/YouTube-@vycdev-red?logo=youtube&logoColor=white)](https://www.youtube.com/@vycdev)

Open-source HueForge-style tool for converting images into stacked, color-layered 3D prints.

Kromacut is a browser-first app that helps you reduce an image to a small palette, preview how the image maps to stacked layers, tweak per-color layer heights and ordering, and export a printable STL along with printer swap instructions.

## Examples

A quick look at what Kromacut produces from a source image to a printable model:

- Fuji test image (2D input) → 3D preview → per-color sliced view → real print

| 2D Input | 3D Preview |
|---|---|
| <img src="content/fuji2d_new.png" alt="Fuji 2D Input" width="600" /> | <img src="content/fuji3d_new.png" alt="Fuji 3D Preview" width="600" /> |
| Sliced by Colors | Real Print |
| <img src="content/fuji3dsliced.png" alt="Fuji Sliced" width="600" /> | <img src="content/printed.jpg" alt="Printed Result" width="600" /> |

Another minimal test you can try yourself in the app header: the Transmission Distance (TD) test image.

| TD Test |
|---|
| <img src="src/assets/tdTest.png" alt="TD Test Image" width="600" /> |

## Notable Features

- Image upload and preview (drag & drop or file picker).
- Color reduction / quantization with selectable color count.
- Inline color pickers to tweak or replace generated palette colors.
- Per-color slice heights and a configurable base slice height.
- Reorder colors with drag-and-drop to control stack order (darkest → lightest default ordering).
- Live 2D preview and a 3D stacked preview rendered with three.js.
- 3D model export to binary STL or 3MF (Preview) suitable for multi-material slicers.
- Plain-text 3D print instructions that describe layer heights and exact layers where filament swaps are required.
- Copy-to-clipboard button for the print instructions (produces a clean, copyable plain-text plan).

## Notable implementation details

- Frontend: React + TypeScript + Vite.
- 3D Rendering: three.js with BufferGeometry. The geometry pipeline produces per-face (non-indexed) triangles so each color slice renders as a solid block (no blended vertex colors) and vertical side walls are preserved.
- Texture sampling: we create a `CanvasTexture` from the preview canvas and use `NearestFilter` with mipmaps disabled so the texture stays crisp when mapped onto the 3D mesh. The texture UVs are adjusted (repeat/offset) so the canvas region aligns with the mesh bounding box.
- Color ordering: palette swatches are derived from image pixels, then ordered by hue/saturation/lightness and presented from darkest to lightest by default (you can reorder manually).


## How to use

- Upload or drag an image into the preview area.
- Adjust quantization settings to reduce to the desired number of colors.
- Tweak or replace swatches using the color pickers in the Swatches panel.
- Open the 3D panel to configure per-color slice heights, base slice height, pixel size, and the color order.
- When ready, click `Download STL` or `Download 3MF` (in the preview-actions bar when in 3D mode) to export your model.
- Use the `Copy` button in the 3D controls to copy a plain-text print plan that lists layer heights and swap layers (hex codes are followed by friendly color names where available).

## 3D / printing specifics and tips

- Base slice height default: `0.20 mm`
- Layer height default: `0.12 mm`
- Layer height used to compute the exact layer numbers at which color swaps happen in the plain-text plan. 
- Per-color slice heights are snapped/multiplied to sensible values relative to `layerHeight` when the swatches change or are initialized.

## Auto-paint (Preview)

Auto-paint is an automated layer-generation mode that replaces the manual palette/swatch workflow. Instead of reducing an image to a fixed number of colors and manually tuning per-color slice heights, you define a set of **filaments** (each with a color and a Transmission Distance) and let the algorithm compute the optimal layer stack automatically.

### Core concepts

- **Filaments**: Each filament has a hex color and a **Transmission Distance (TD)** value (in mm). TD describes how translucent the filament is — at a thickness equal to TD, only ~10% of light passes through. Dark/opaque filaments have low TD (e.g. 0.5 mm); light/translucent filaments have high TD (e.g. 6+ mm). When you add a filament without specifying a TD, Kromacut estimates one from the color's luminance and saturation.
- **Beer-Lambert optical blending**: The algorithm simulates how light transmits through stacked filament layers using the Beer-Lambert law: `transmission = 10^(-thickness / TD)`. This physically models the color you see when printing thin semi-transparent layers on top of each other.
- **Transition zones**: Each filament in the stack needs enough vertical space to visually transition from the color below it to its own pure color. The algorithm simulates adding layers one at a time until the blended color converges (DeltaE < 2.3 — the "just noticeable difference" threshold) or opacity exceeds 85%. The result is a set of transition zones, each with a start height, end height, and the filament used.
- **Luminance-to-height mapping**: Once the transition zones are computed, each pixel's brightness is mapped to a target height in the model. Dark pixels get the minimum height (base layer only), bright pixels get the full height (all layers), and mid-tones fall proportionally in between. This produces the characteristic lithophane-style relief where image brightness = model thickness.

### How it works (step by step)

1. **Define filaments** — Add your filament colors and Transmission Distances in the Auto-paint tab. Use the color picker and TD input for each filament row.
2. **Filament ordering** — By default filaments are sorted by luminance (darkest on the bottom, lightest on top). With **Enhanced color matching** enabled, the algorithm evaluates orderings to find the one that best reproduces the image's color palette.
3. **Transition zone calculation** — For each consecutive pair of filaments, the algorithm simulates Beer-Lambert blending layer-by-layer until the color converges. The first (darkest) filament gets a foundation zone thick enough to be ~95% opaque (`TD × 1.3`).
4. **Height compression** — If the ideal height exceeds a user-set **Max Height**, all zones are uniformly compressed. The UI shows which zones are compressed and by how much.
5. **Virtual swatch generation** — The transition zones are sampled at each layer-height increment to produce a sequence of blended colors (virtual swatches). These drive the 3D preview and the height map, where each pixel maps to the layer whose blended color best matches.

### Options

| Option | Description |
|---|---|
| **Max Height** | Constrains the total model height (mm). When set below the auto-calculated ideal, zones are uniformly compressed. Leave blank or click `Auto` for the physics-derived default. |
| **Enhanced color matching** | Optimizes filament ordering for best color reproduction rather than simple luminance sorting. For ≤6 filaments, all permutations of all non-empty subsets are evaluated exhaustively. For >6, a greedy heuristic builds the sequence one filament at a time. Scoring considers weighted DeltaE accuracy, height spread, layer count, and transition waste. |
| **Allow repeated filament swaps** | (Requires Enhanced color matching) Allows a filament to appear more than once in the stack. This creates intermediate blended colors — for example, a thin white layer over red produces pink. The algorithm greedily inserts up to 4 extra swaps, each at the position that best improves the score. |
| **Height dithering** | (Requires Enhanced color matching) Applies block-aware Floyd-Steinberg error diffusion to the quantized height map. Instead of sharp stair-steps between layer heights, dithering produces a stippled gradient that simulates intermediate heights, resulting in smoother tonal transitions in the print. Edge pixels between different heights are protected from dithering to avoid staircase artifacts. |
| **Dither line width** | (Requires Height dithering) Controls the minimum dot size for the dither pattern in mm. This should roughly match your printer's line/nozzle width so dither dots are actually printable. Default: `0.42 mm`. |

### Filament profiles

Auto-paint configurations (filament lists) can be saved, loaded, and shared as **profiles**:

- **Save / Save New** — Persist the current filament set under a name. Overwrite an existing profile or create a new one.
- **Load** — Select a saved profile from the dropdown to restore its filaments.
- **Export** — Download the current filaments as a `.kapp` file (JSON) to share with others.
- **Import** — Load a `.kapp` or `.json` profile file from disk.
- **Delete** — Remove a saved profile.

Profiles are stored in browser `localStorage` and persist across sessions.

### Transition zones panel

When auto-paint is active and filaments are defined, the UI displays a **Transition Zones** panel showing:

- Each zone's filament color swatch and hex code.
- The start and end height of each zone (in mm) and its thickness (Δ).
- A **compressed** badge on zones that have been reduced below their ideal thickness due to a Max Height constraint.
- Total model height and total number of physical layers.

### Quick start

1. Load an image into Kromacut.
2. Switch to the **Auto-paint** tab (inside the 3D controls panel).
3. Click **Add Filament** and configure each filament's color and TD to match your real filament stock.
4. (Optional) Enable **Enhanced color matching** for better results with complex images.
5. The 3D preview updates automatically. Adjust **Max Height** if the model is too tall.
6. Export the model via **Download STL** or **Download 3MF** and follow the printed swap plan.

## 3MF Export (Preview)

Kromacut now supports exporting directly to `.3mf` format. This file format preserves color information by splitting the model into separate objects for each color, automatically assigned to different extruders/filaments.

**Disclaimer:** This feature is currently in **PREVIEW**. While Kromacut preserves colors, the rest of the settings in the slicer profile should be manually adjusted. Please report any issues or weird behaviors you encounter on the GitHub Issues page.

## Transmission Distance (TD) — what it is and how to use it here

Transmission Distance (TD) is the concept HueForge uses to produce perceptual intermediate shades by stacking translucent filament layers: instead of relying purely on opaque color pigments, TD models how light transmits through thin layers of filament and how stacking different colors (and varying thickness) produces new perceived colors. HueForge does a lot of this work automatically for you (generating intermediate shades and mapping them to layer swaps). For a full conceptual description see the HueForge blog: https://shop.thehueforge.com/blogs/news/what-is-hueforge

Important notes about Transmission Distance in Kromacut:

- Kromacut does NOT compute Transmission Distance or blend shades automatically. All TD-like effects are done manually by you in the app.
- Recommended workflow when you want TD-style results:
	1. Reduce your image to a palette with *more colors* than you actually intend to print. The extra colors give you candidate shades to use as intermediate/translucent-looking layers.
	2. Use the per-color slice heights and ordering controls in the 3D panel to approximate the stacked thicknesses and ordering that would produce the target intermediate shades. Small adjustments to `base slice height`, per-color slice heights, and `layerHeight` change the produced layer numbers and perceived blends.
	3. Iterate with actual filament on a small test print: translucency and perceived mix depend heavily on filament brand, color, and print settings.

All of the automated Transmission Distance processing that HueForge performs is manual in Kromacut — you are given the building blocks (palette, per-color heights, order, and the 3D preview) and you experiment until you find a stack that gives the visual result you want.

TD test image and quick experiment

- This repository includes a small test image `tdTest.png` (found in `src/assets/tdTest.png`).
- The app header includes a `Load TD Test` button that will load that image into the preview so you can quickly experiment with layer ordering and per-color slice heights.

You can try a quick experiment:

1. Click `Load TD Test` in the app header.
2. Reduce colors to your desired number.
3. Generate and download your 3d model. 
4. Follow the layer color swap instructions and print your 3d model to see results.  

Preview of the included TD test image:

<img src="src/assets/tdTest.png" alt="TD Test Image" width="600" />

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=vycdev/kromacut&type=date&legend=top-left)](https://www.star-history.com/#vycdev/kromacut&type=date&legend=top-left)

## Contributing

Contributions welcome. Open issues or PRs for bugs, improvements, or feature suggestions. If you plan a larger change (architecture, algorithms), open an issue first describing the approach so we can discuss it.

## License

This project is open-source — see the `LICENSE` file in the repository.
