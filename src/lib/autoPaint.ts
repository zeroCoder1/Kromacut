/**
 * Auto-Paint Algorithm for Filament Painting (HueForge-style lithophanes)
 *
 * This module implements the "Optical Slicer" approach to automatically generate
 * filament layer assignments based on the Beer-Lambert law for optical blending.
 *
 * Core concept: Instead of mapping image colors 1-to-1 to layers, we simulate
 * the physical stacking of semi-transparent filaments to achieve target luminance
 * values at each Z-height.
 */

import type { Filament } from '../components/ThreeDControls';

/** RGB color representation (0-255 range) */
export interface RGB {
    r: number;
    g: number;
    b: number;
}

/** A generated layer segment from the auto-paint algorithm */
export interface AutoPaintLayer {
    filamentId: string;
    filamentColor: string;
    startHeight: number; // mm from Z=0
    endHeight: number; // mm from Z=0
}

/** Result from the auto-paint generator */
export interface AutoPaintResult {
    layers: AutoPaintLayer[];
    totalHeight: number;
    filamentOrder: string[]; // Filament IDs in order (dark to light)
}

/**
 * Convert hex color to RGB
 */
export function hexToRgb(hex: string): RGB {
    const h = hex.replace(/^#/, '');
    return {
        r: parseInt(h.slice(0, 2), 16) || 0,
        g: parseInt(h.slice(2, 4), 16) || 0,
        b: parseInt(h.slice(4, 6), 16) || 0,
    };
}

/**
 * Convert RGB to hex
 */
export function rgbToHex(rgb: RGB): string {
    const toHex = (n: number) =>
        Math.round(Math.max(0, Math.min(255, n)))
            .toString(16)
            .padStart(2, '0');
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

/**
 * Calculate perceived luminance (brightness) from RGB values.
 * Uses the standard sRGB luminance coefficients.
 *
 * @param color - RGB color (0-255 range)
 * @returns Luminance value (0-255 range)
 */
export function getLuminance(color: RGB): number {
    return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

/**
 * Calculate the resulting color when placing a semi-transparent filament
 * on top of an existing background color using the Beer-Lambert law.
 *
 * The transmission follows: T = 0.1^(thickness/TD)
 * At thickness == TD, transmission is 10% (filament definition of TD).
 *
 * @param backgroundColor - The color of the existing stack
 * @param filamentColor - The color of the filament being added
 * @param filamentTD - Transmission Distance of the filament (mm)
 * @param layerThickness - How thick the filament layer is (mm)
 * @returns The resulting blended color
 */
export function blendColors(
    backgroundColor: RGB,
    filamentColor: RGB,
    filamentTD: number,
    layerThickness: number
): RGB {
    // Prevent division by zero or invalid TD
    if (filamentTD <= 0 || layerThickness <= 0) {
        return filamentColor;
    }

    // Beer-Lambert law: transmission = 10^(-thickness/TD)
    // At thickness == TD, transmission = 10^(-1) = 0.1 (10%)
    const transmission = Math.pow(0.1, layerThickness / filamentTD);

    // Opacity is the inverse of transmission
    const opacity = 1 - transmission;

    // Linear interpolation (simple RGB mixing)
    // For a more accurate implementation, we could convert to Lab color space
    return {
        r: filamentColor.r * opacity + backgroundColor.r * transmission,
        g: filamentColor.g * opacity + backgroundColor.g * transmission,
        b: filamentColor.b * opacity + backgroundColor.b * transmission,
    };
}

/**
 * Calculate the opacity (how opaque) a filament layer is at a given thickness.
 *
 * @param filamentTD - Transmission Distance (mm)
 * @param thickness - Layer thickness (mm)
 * @returns Opacity value (0-1)
 */
export function getOpacity(filamentTD: number, thickness: number): number {
    if (filamentTD <= 0 || thickness <= 0) return 0;
    const transmission = Math.pow(0.1, thickness / filamentTD);
    return 1 - transmission;
}

/**
 * Linear interpolation
 */
function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/**
 * Calculate the recommended model height based on filaments.
 * The model should be thick enough for the lightest filament to reach
 * near-full opacity (~99%).
 *
 * @param filaments - Array of filaments sorted dark to light
 * @returns Recommended model height in mm
 */
export function calculateRecommendedHeight(
    filaments: Array<{ color: string; td: number }>
): number {
    if (filaments.length === 0) return 2.0; // Default 2mm

    // Find the highest TD (slowest to become opaque)
    const maxTD = Math.max(...filaments.map((f) => f.td));

    // At what thickness does transmission drop below 1%? (99% opaque)
    // 0.01 = 0.1^(thickness/TD)
    // log(0.01) = (thickness/TD) * log(0.1)
    // -2 = (thickness/TD) * (-1)
    // thickness = 2 * TD
    const targetThickness = 2 * maxTD;

    // Clamp to reasonable bounds (0.5mm to 10mm)
    return Math.max(0.5, Math.min(10, targetThickness));
}

/**
 * Generate auto-paint layers based on filaments and image data.
 *
 * This algorithm simulates the optical stacking of filaments layer by layer,
 * deciding when to swap to the next lighter filament based on whether it
 * gets us closer to the target luminance gradient.
 *
 * @param filaments - User's list of filaments with colors and TDs
 * @param imageSwatches - Distinct colors from the image (for luminance range)
 * @param layerHeight - Layer height in mm (e.g., 0.12)
 * @param firstLayerHeight - First layer height in mm (e.g., 0.20)
 * @param maxModelHeight - Optional override for max model height
 * @returns Generated layer segments
 */
export function generateAutoLayers(
    filaments: Filament[],
    imageSwatches: Array<{ hex: string }>,
    layerHeight: number,
    firstLayerHeight: number,
    maxModelHeight?: number
): AutoPaintResult {
    // --- STEP 1: VALIDATION ---
    if (filaments.length === 0) {
        return { layers: [], totalHeight: 0, filamentOrder: [] };
    }

    if (imageSwatches.length === 0) {
        return { layers: [], totalHeight: 0, filamentOrder: [] };
    }

    // --- STEP 2: SORTING FILAMENTS ---
    // Sort filaments from Darkest to Lightest (by luminance)
    const sortedFilaments = [...filaments].sort((a, b) => {
        const lumA = getLuminance(hexToRgb(a.color));
        const lumB = getLuminance(hexToRgb(b.color));
        return lumA - lumB;
    });

    // --- STEP 3: GET TARGET LUMINANCE RANGE FROM IMAGE ---
    const swatchLuminances = imageSwatches.map((s) => getLuminance(hexToRgb(s.hex)));
    const minImageLum = Math.min(...swatchLuminances);
    const maxImageLum = Math.max(...swatchLuminances);

    // --- STEP 4: DETERMINE MODEL HEIGHT ---
    const recommendedHeight = calculateRecommendedHeight(
        sortedFilaments.map((f) => ({ color: f.color, td: f.td }))
    );
    const modelHeight = maxModelHeight ?? recommendedHeight;

    // --- STEP 5: STATE INITIALIZATION ---
    const generatedLayers: AutoPaintLayer[] = [];

    // "Current Background" is the color of the stack accumulated so far.
    // Initially, it's the color of the first (darkest) filament
    let currentBackingColor = hexToRgb(sortedFilaments[0].color);
    let lastSwapZ = 0;

    let activeFilamentIndex = 0;
    let currentZ = firstLayerHeight; // Start at the first layer

    // Track the filament order for the result
    const filamentOrder = sortedFilaments.map((f) => f.id);

    // --- STEP 6: THE SIMULATION LOOP ---
    // We iterate through every physical layer of the print
    while (currentZ <= modelHeight) {
        const activeFilament = sortedFilaments[activeFilamentIndex];
        const activeFilamentRgb = hexToRgb(activeFilament.color);

        // A. CALCULATE TARGET LUMINANCE
        // Where are we vertically? (0.0 to 1.0)
        const progress = currentZ / modelHeight;
        // What luminance *should* we have here to match the image gradient?
        const targetLuminance = lerp(minImageLum, maxImageLum, progress);

        // B. CALCULATE CURRENT REALITY
        // Thickness of the TOP filament only (distance since last swap)
        const topThickness = currentZ - lastSwapZ;

        const currentColor = blendColors(
            currentBackingColor,
            activeFilamentRgb,
            activeFilament.td,
            topThickness
        );
        const currentLum = getLuminance(currentColor);
        const currentError = Math.abs(currentLum - targetLuminance);

        // C. CHECK FOR SWAP (Look Ahead)
        // Can we do better by switching to the NEXT filament in the list?
        if (activeFilamentIndex < sortedFilaments.length - 1) {
            const nextFilament = sortedFilaments[activeFilamentIndex + 1];
            const nextFilamentRgb = hexToRgb(nextFilament.color);

            // Simulation: What if we swapped to the next filament now?
            // The current stack becomes the background, and we add one layer of new stuff
            const hypoColor = blendColors(
                currentColor, // The current stack becomes the background
                nextFilamentRgb,
                nextFilament.td,
                layerHeight // Just one layer of the new stuff
            );

            const hypoLum = getLuminance(hypoColor);
            const hypoError = Math.abs(hypoLum - targetLuminance);

            // LOGIC: If the next filament gets us closer to the target brightness
            // than sticking with the current one, we swap.
            if (hypoError < currentError) {
                // 1. Save the segment we just finished
                generatedLayers.push({
                    filamentId: activeFilament.id,
                    filamentColor: activeFilament.color,
                    startHeight: lastSwapZ,
                    endHeight: currentZ,
                });

                // 2. "Bake" the stack
                // The stack we just built becomes the new solid background
                currentBackingColor = currentColor;
                lastSwapZ = currentZ;

                // 3. Switch Index
                activeFilamentIndex++;

                // Continue to next iteration without incrementing Z
                // to re-evaluate this height with the new filament
                continue;
            }
        }

        // --- STEP 7: OPTIMIZATION (Early termination) ---
        // If the top layer is now so thick that it is effectively opaque
        // (opacity > 99%), and we have no more filaments to swap to,
        // we can stop - the rest would just be wasted plastic
        if (activeFilamentIndex === sortedFilaments.length - 1) {
            const opacity = getOpacity(activeFilament.td, topThickness);
            if (opacity > 0.99) {
                // We've reached full opacity with the final filament
                // Record this segment and exit
                generatedLayers.push({
                    filamentId: activeFilament.id,
                    filamentColor: activeFilament.color,
                    startHeight: lastSwapZ,
                    endHeight: currentZ,
                });
                return {
                    layers: generatedLayers,
                    totalHeight: currentZ,
                    filamentOrder,
                };
            }
        }

        // Increment Height
        currentZ += layerHeight;
    }

    // --- STEP 8: FINALIZE ---
    // Add the final segment
    generatedLayers.push({
        filamentId: sortedFilaments[activeFilamentIndex].id,
        filamentColor: sortedFilaments[activeFilamentIndex].color,
        startHeight: lastSwapZ,
        endHeight: modelHeight,
    });

    return {
        layers: generatedLayers,
        totalHeight: modelHeight,
        filamentOrder,
    };
}

/**
 * Convert auto-paint layers to the format expected by ThreeDView.
 *
 * This function generates MULTIPLE layers at each layerHeight increment,
 * creating a graduated effect where higher layers cover progressively
 * fewer pixels (only the lightest ones).
 *
 * ThreeDView expects:
 * - colorSliceHeights: height for each swatch index
 * - colorOrder: ordering of swatch indices
 * - virtualSwatches: colors for each layer
 */
export function autoPaintToSliceHeights(
    result: AutoPaintResult,
    layerHeight: number,
    firstLayerHeight: number
): {
    colorSliceHeights: number[];
    colorOrder: number[];
    virtualSwatches: Array<{ hex: string; a: number }>;
} {
    if (result.layers.length === 0 || result.totalHeight <= 0) {
        return {
            colorSliceHeights: [],
            colorOrder: [],
            virtualSwatches: [],
        };
    }

    const virtualSwatches: Array<{ hex: string; a: number }> = [];
    const colorSliceHeights: number[] = [];
    const colorOrder: number[] = [];

    // Generate layers at each layerHeight increment from 0 to totalHeight
    // Each layer gets the color of whichever filament is active at that Z height
    let currentZ = 0;
    let layerIndex = 0;

    while (currentZ < result.totalHeight) {
        // Determine thickness for this layer
        const thickness = layerIndex === 0 ? Math.max(firstLayerHeight, layerHeight) : layerHeight;

        const layerTopZ = currentZ + thickness;

        // Find which filament is active at this Z height
        // (find the layer whose range contains currentZ)
        let activeColor = result.layers[0].filamentColor;
        for (const layer of result.layers) {
            if (currentZ >= layer.startHeight && currentZ < layer.endHeight) {
                activeColor = layer.filamentColor;
                break;
            }
            // If we're past the layer's end, this might be the active one
            if (currentZ >= layer.startHeight) {
                activeColor = layer.filamentColor;
            }
        }

        // Add this layer
        virtualSwatches.push({
            hex: activeColor,
            a: 255,
        });
        colorSliceHeights.push(Number(thickness.toFixed(8)));
        colorOrder.push(layerIndex);

        currentZ = layerTopZ;
        layerIndex++;

        // Safety limit to prevent infinite loops
        if (layerIndex > 500) {
            console.warn('autoPaintToSliceHeights: too many layers, stopping at 500');
            break;
        }
    }

    return {
        colorSliceHeights,
        colorOrder,
        virtualSwatches,
    };
}

/**
 * Debug helper: simulate and log the optical stacking at each layer
 */
export function debugAutoPaint(
    filaments: Filament[],
    imageSwatches: Array<{ hex: string }>,
    layerHeight: number,
    firstLayerHeight: number
): void {
    const result = generateAutoLayers(filaments, imageSwatches, layerHeight, firstLayerHeight);

    console.group('Auto-Paint Debug');
    console.log('Input filaments:', filaments);
    console.log('Total height:', result.totalHeight, 'mm');
    console.log('Filament order (dark→light):', result.filamentOrder);
    console.log('Generated layers:');
    result.layers.forEach((layer, i) => {
        console.log(
            `  ${i + 1}. ${layer.filamentColor} | ${layer.startHeight.toFixed(2)}mm → ${layer.endHeight.toFixed(2)}mm | Δ${(layer.endHeight - layer.startHeight).toFixed(2)}mm`
        );
    });
    console.groupEnd();
}
