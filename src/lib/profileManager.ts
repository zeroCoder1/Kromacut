import type { Filament } from '@/types';
import { computeProfileConfidence } from './calibration';

export interface AutoPaintProfile {
    id: string;
    name: string;
    version: number;
    filaments: Filament[];
    createdAt: number;
    updatedAt: number;
    // Optional metadata
    description?: string;
    tags?: string[];
}

export const CURRENT_PROFILE_VERSION = 2; // Bumped for calibration support

const PROFILES_STORAGE_KEY = 'kromacut.autopaint.profiles';
const LAST_PROFILE_KEY = 'kromacut.autopaint.lastProfileId';

export function loadProfiles(): AutoPaintProfile[] {
    try {
        const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as AutoPaintProfile[];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (p) =>
                typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.filaments)
        );
    } catch {
        return [];
    }
}

export function loadLastProfileId(): string | null {
    try {
        return localStorage.getItem(LAST_PROFILE_KEY);
    } catch {
        return null;
    }
}

export function saveLastProfileId(id: string | null) {
    try {
        if (id) {
            localStorage.setItem(LAST_PROFILE_KEY, id);
        } else {
            localStorage.removeItem(LAST_PROFILE_KEY);
        }
    } catch {
        // ignore
    }
}

export function saveProfilesToStorage(profiles: AutoPaintProfile[]) {
    try {
        localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles));
    } catch {
        // ignore storage errors
    }
}

export function createProfile(name: string, filaments: Filament[]): AutoPaintProfile {
    const now = Date.now();
    return {
        id: crypto.randomUUID(),
        name: name.trim(),
        version: CURRENT_PROFILE_VERSION,
        filaments: filaments.map((f) => ({ ...f })),
        createdAt: now,
        updatedAt: now,
    };
}

export function overwriteProfile(
    profiles: AutoPaintProfile[],
    id: string,
    filaments: Filament[]
): AutoPaintProfile[] {
    return profiles.map((p) =>
        p.id === id
            ? {
                  ...p,
                  filaments: filaments.map((f) => ({ ...f })),
                  updatedAt: Date.now(),
              }
            : p
    );
}

export function deleteProfile(profiles: AutoPaintProfile[], id: string): AutoPaintProfile[] {
    return profiles.filter((p) => p.id !== id);
}

/** Check if two filament arrays are identical by color+td (order-sensitive). */
function filamentsEqual(a: Filament[], b: Filament[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((af, i) => af.color === b[i].color && af.td === b[i].td);
}

/** Derive a unique name by appending a numeric suffix if the name already exists. */
function deduplicateName(name: string, existing: AutoPaintProfile[]): string {
    const names = new Set(existing.map((p) => p.name));
    if (!names.has(name)) return name;
    let suffix = 2;
    while (names.has(`${name} (${suffix})`)) suffix++;
    return `${name} (${suffix})`;
}

export interface ImportResult {
    profiles: AutoPaintProfile[];
    imported: AutoPaintProfile[];
    skipped: string[];
    overwritten: string[];
    renamed: string[];
}

/**
 * Import one or more profiles with duplicate prevention:
 * - ID match: overwrite existing profile
 * - Content match (different ID): skip
 * - Name match (different ID, different content): rename with numeric suffix
 */
export function importProfiles(
    existing: AutoPaintProfile[],
    incoming: AutoPaintProfile[]
): ImportResult {
    const result: ImportResult = {
        profiles: [...existing],
        imported: [],
        skipped: [],
        overwritten: [],
        renamed: [],
    };

    for (const raw of incoming) {
        // Validate required fields
        if (!raw || typeof raw.name !== 'string' || !Array.isArray(raw.filaments)) continue;

        const validFilaments = raw.filaments.filter(
            (f) =>
                typeof f.id === 'string' && typeof f.color === 'string' && typeof f.td === 'number'
        ).map((f) => ({
            id: f.id,
            color: f.color,
            td: f.td,
            // Preserve calibration data if present
            ...(f.calibration && { calibration: f.calibration }),
            // Preserve metadata if present
            ...(f.brand && { brand: f.brand }),
            ...(f.name && { name: f.name }),
            ...(f.notes && { notes: f.notes }),
        }));

        const now = Date.now();
        const profile: AutoPaintProfile = {
            id: raw.id && typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
            name: raw.name,
            version: typeof raw.version === 'number' ? raw.version : CURRENT_PROFILE_VERSION,
            filaments: validFilaments,
            createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
            updatedAt: now,
        };

        // 1. ID match → overwrite
        const idMatch = result.profiles.findIndex((p) => p.id === profile.id);
        if (idMatch !== -1) {
            result.profiles[idMatch] = { ...profile, updatedAt: now };
            result.overwritten.push(profile.name);
            result.imported.push(result.profiles[idMatch]);
            continue;
        }

        // 2. Content match (same filaments) → skip
        const contentMatch = result.profiles.find((p) =>
            filamentsEqual(p.filaments, validFilaments)
        );
        if (contentMatch) {
            result.skipped.push(`${profile.name} (matches "${contentMatch.name}")`);
            continue;
        }

        // 3. Name match → rename
        const nameMatch = result.profiles.some((p) => p.name === profile.name);
        if (nameMatch) {
            profile.name = deduplicateName(profile.name, result.profiles);
            result.renamed.push(profile.name);
        }

        result.profiles.push(profile);
        result.imported.push(profile);
    }

    return result;
}

/**
 * Parse a file's JSON content into an array of profiles to import.
 * Supports both single profile objects and arrays of profiles.
 */
export function parseProfileFile(json: string): AutoPaintProfile[] | null {
    try {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.filaments)) {
            return [parsed as AutoPaintProfile];
        }
        return null;
    } catch {
        return null;
    }
}

/** Build an export blob for a profile. */
export function exportProfileBlob(profile: AutoPaintProfile): Blob {
    return new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
}

/** Sanitize a name for use as a filename. */
export function profileFileName(name: string): string {
    return `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.kapp`;
}

// ============================================================================
// Calibration Helpers
// ============================================================================

/**
 * Compute average confidence score for a profile based on filament calibrations
 */
export function getProfileConfidence(profile: AutoPaintProfile): number {
    if (profile.filaments.length === 0) return 0;

    const confidences = profile.filaments.map((f) =>
        computeProfileConfidence({ calibration: f.calibration, transmissionDistance: f.td })
    );

    return confidences.reduce((sum, c) => sum + c, 0) / confidences.length;
}

/**
 * Check if profile has calibration data for all filaments
 */
export function isProfileFullyCalibrated(profile: AutoPaintProfile): boolean {
    return profile.filaments.every((f) => f.calibration !== undefined);
}

/**
 * Check if profile has calibration data for at least one filament
 */
export function isProfilePartiallyCalibrated(profile: AutoPaintProfile): boolean {
    return profile.filaments.some((f) => f.calibration !== undefined);
}

/**
 * Get calibration status summary for UI display
 */
export function getProfileCalibrationStatus(profile: AutoPaintProfile): {
    calibratedCount: number;
    totalCount: number;
    confidence: number;
    status: 'none' | 'partial' | 'full';
} {
    const calibratedCount = profile.filaments.filter((f) => f.calibration).length;
    const totalCount = profile.filaments.length;
    const confidence = getProfileConfidence(profile);

    let status: 'none' | 'partial' | 'full';
    if (calibratedCount === 0) status = 'none';
    else if (calibratedCount === totalCount) status = 'full';
    else status = 'partial';

    return { calibratedCount, totalCount, confidence, status };
}
