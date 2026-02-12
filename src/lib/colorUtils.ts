/**
 * Shared color utility functions.
 */

/**
 * Compute perceived luminance (0–1) from a hex color string.
 * Uses the standard sRGB luminance coefficients.
 */
export function hexLuminance(hex: string): number {
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16) / 255;
    const g = parseInt(c.slice(2, 4), 16) / 255;
    const b = parseInt(c.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Estimate Transmission Distance (TD) from a hex color.
 *
 * TD is related to how much light passes through the filament:
 * - Darker colors absorb more light → lower TD (≈0.5mm)
 * - Lighter colors are more transparent → higher TD (≈6.0mm)
 * - Saturated colors can be slightly clearer than gray of same luminance
 *
 * This is an approximation based on luminance with adjustments for saturation.
 */
export function estimateTDFromColor(hex: string): number {
    const h = hex.replace(/^#/, '');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;

    // Calculate luminance (perceived brightness)
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    // Calculate saturation (highly saturated colors tend to be clearer)
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;

    // Base TD from luminance: map 0-1 luminance to 0.5-6.0 TD (linear)
    let estimatedTD = 0.5 + luminance * 5.5;

    // Saturated colors can be clearer than gray of same luminance
    if (luminance < 0.9) {
        estimatedTD += saturation * 1.5;
    }

    // Clamp to reasonable range and round to 1 decimal
    return Math.round(Math.max(0.4, Math.min(7.5, estimatedTD)) * 10) / 10;
}
