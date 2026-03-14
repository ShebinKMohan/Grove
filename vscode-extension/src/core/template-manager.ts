/**
 * Template Manager — loads, validates, and manages Agent Team templates.
 *
 * Templates are JSON files stored at:
 * - Project level: `.worktreepilot/templates/`
 * - Global level: `~/.worktreepilot/templates/`
 * Project templates override global ones (matched by name).
 *
 * No VS Code dependency — pure filesystem operations.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

export interface AgentRole {
    /** Unique role identifier within the template */
    role: string;
    /** Display name shown in UI */
    displayName: string;
    /** Glob patterns for files this agent owns */
    ownership: string[];
    /** System prompt / role description for the agent */
    prompt: string;
    /** Extra instructions appended to the generated CLAUDE.md */
    claudeMdExtra?: string;
    /** If true, agent should not modify files — review only */
    readOnly: boolean;
}

export interface TeamTemplate {
    /** Template name (unique identifier) */
    name: string;
    /** Human-readable description */
    description: string;
    /** Agents in this team */
    agents: AgentRole[];
    /** Preferred merge order (role names). If empty, auto-determined. */
    mergeOrder: string[];
    /** Estimated token cost range */
    estimatedTokens: string;
}

export interface TemplateValidationError {
    field: string;
    message: string;
}

// ────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────

const GLOBAL_TEMPLATE_DIR = path.join(
    os.homedir(),
    ".worktreepilot",
    "templates"
);

/**
 * Root path of the extension installation directory.
 * Must be set via `initTemplateManager()` before loading built-in templates.
 * When unset, falls back to a `__dirname`-relative guess (works in dev, not in VSIX).
 */
let extensionRoot: string = path.join(__dirname, "..", "..");

/**
 * Initialise the template manager with the extension's installation path.
 * Call this once during extension activation (pass `context.extensionPath`).
 */
export function initTemplateManager(extensionPath: string): void {
    extensionRoot = extensionPath;
}

// ────────────────────────────────────────────
// Template Loading
// ────────────────────────────────────────────

/**
 * Load all available templates. Project templates override global ones.
 */
export function loadAllTemplates(
    repoRoot: string,
    templateDir: string = ".worktreepilot/templates"
): TeamTemplate[] {
    const templates = new Map<string, TeamTemplate>();

    // 1. Load built-in templates (shipped with extension)
    const builtinDir = path.join(extensionRoot, "templates");
    loadTemplatesFromDir(builtinDir, templates);

    // 2. Load global templates (override built-ins)
    loadTemplatesFromDir(GLOBAL_TEMPLATE_DIR, templates);

    // 3. Load project templates (override global)
    const projectDir = path.join(repoRoot, templateDir);
    loadTemplatesFromDir(projectDir, templates);

    return [...templates.values()];
}

/**
 * Load a single template by name.
 */
export function loadTemplate(
    name: string,
    repoRoot: string,
    templateDir: string = ".worktreepilot/templates"
): TeamTemplate | undefined {
    const all = loadAllTemplates(repoRoot, templateDir);
    return all.find((t) => t.name === name);
}

/**
 * List template names from all sources (for quick-pick UI).
 */
export function listTemplateNames(
    repoRoot: string,
    templateDir: string = ".worktreepilot/templates"
): Array<{ name: string; description: string; source: string }> {
    const result: Array<{ name: string; description: string; source: string }> = [];
    const seen = new Set<string>();

    // Project templates first (highest priority)
    const projectDir = path.join(repoRoot, templateDir);
    for (const t of readTemplatesFromDir(projectDir)) {
        if (!seen.has(t.name)) {
            seen.add(t.name);
            result.push({ name: t.name, description: t.description, source: "project" });
        }
    }

    // Global templates
    for (const t of readTemplatesFromDir(GLOBAL_TEMPLATE_DIR)) {
        if (!seen.has(t.name)) {
            seen.add(t.name);
            result.push({ name: t.name, description: t.description, source: "global" });
        }
    }

    // Built-in templates
    const builtinDir = path.join(extensionRoot, "templates");
    for (const t of readTemplatesFromDir(builtinDir)) {
        if (!seen.has(t.name)) {
            seen.add(t.name);
            result.push({ name: t.name, description: t.description, source: "built-in" });
        }
    }

    return result;
}

// ────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────

/**
 * Validate a template. Returns empty array if valid.
 */
export function validateTemplate(
    template: unknown
): TemplateValidationError[] {
    const errors: TemplateValidationError[] = [];
    const t = template as Record<string, unknown>;

    if (!t || typeof t !== "object") {
        errors.push({ field: "root", message: "Template must be a JSON object" });
        return errors;
    }

    if (typeof t.name !== "string" || t.name.trim().length === 0) {
        errors.push({ field: "name", message: "Template name is required" });
    }

    if (typeof t.description !== "string") {
        errors.push({ field: "description", message: "Description is required" });
    }

    if (!Array.isArray(t.agents) || t.agents.length === 0) {
        errors.push({ field: "agents", message: "At least one agent is required" });
        return errors;
    }

    const roles = new Set<string>();
    for (let i = 0; i < (t.agents as unknown[]).length; i++) {
        const agent = (t.agents as Record<string, unknown>[])[i];
        const prefix = `agents[${i}]`;

        if (typeof agent.role !== "string" || agent.role.trim().length === 0) {
            errors.push({ field: `${prefix}.role`, message: "Role identifier is required" });
        } else if (roles.has(agent.role as string)) {
            errors.push({ field: `${prefix}.role`, message: `Duplicate role: ${agent.role}` });
        } else {
            roles.add(agent.role as string);
        }

        if (typeof agent.displayName !== "string" || (agent.displayName as string).trim().length === 0) {
            errors.push({ field: `${prefix}.displayName`, message: "Display name is required" });
        }

        if (!Array.isArray(agent.ownership)) {
            errors.push({ field: `${prefix}.ownership`, message: "Ownership must be an array of glob patterns" });
        }

        if (typeof agent.prompt !== "string") {
            errors.push({ field: `${prefix}.prompt`, message: "Prompt is required" });
        }

        if (agent.readOnly !== undefined && typeof agent.readOnly !== "boolean") {
            errors.push({ field: `${prefix}.readOnly`, message: "readOnly must be a boolean" });
        }
    }

    if (Array.isArray(t.mergeOrder)) {
        for (const role of t.mergeOrder as string[]) {
            if (!roles.has(role)) {
                errors.push({
                    field: "mergeOrder",
                    message: `Unknown role in mergeOrder: ${role}`,
                });
            }
        }
    }

    return errors;
}

// ────────────────────────────────────────────
// Overlap Analysis (pre-flight)
// ────────────────────────────────────────────

export interface OwnershipOverlap {
    pattern: string;
    agents: string[];
}

/**
 * Detect overlapping ownership patterns between agents.
 * Simple heuristic: checks if any glob pattern appears in multiple agents,
 * or if one pattern is a prefix/subset of another.
 */
export function detectOwnershipOverlaps(
    template: TeamTemplate
): OwnershipOverlap[] {
    const overlaps: OwnershipOverlap[] = [];

    // Map each pattern to the agents that own it
    const patternOwners = new Map<string, string[]>();

    for (const agent of template.agents) {
        for (const pattern of agent.ownership) {
            const normalized = pattern.replace(/\\/g, "/");
            const existing = patternOwners.get(normalized) ?? [];
            existing.push(agent.role);
            patternOwners.set(normalized, existing);
        }
    }

    // Direct overlaps (same pattern in multiple agents)
    for (const [pattern, owners] of patternOwners) {
        if (owners.length > 1) {
            overlaps.push({ pattern, agents: owners });
        }
    }

    // Prefix overlaps (e.g., "src/**" overlaps with "src/api/**")
    const patterns = [...patternOwners.keys()];
    for (let i = 0; i < patterns.length; i++) {
        for (let j = i + 1; j < patterns.length; j++) {
            const a = patterns[i];
            const b = patterns[j];
            const ownersA = patternOwners.get(a)!;
            const ownersB = patternOwners.get(b)!;

            // Skip if already same agents
            if (
                ownersA.length === 1 &&
                ownersB.length === 1 &&
                ownersA[0] === ownersB[0]
            ) {
                continue;
            }

            // Check if base directories overlap
            const baseA = a.replace(/\*\*.*$/, "").replace(/\*.*$/, "");
            const baseB = b.replace(/\*\*.*$/, "").replace(/\*.*$/, "");

            if (baseA && baseB && (baseA.startsWith(baseB) || baseB.startsWith(baseA))) {
                const allAgents = [...new Set([...ownersA, ...ownersB])];
                if (allAgents.length > 1) {
                    overlaps.push({
                        pattern: `${a} ↔ ${b}`,
                        agents: allAgents,
                    });
                }
            }
        }
    }

    return overlaps;
}

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────

function loadTemplatesFromDir(
    dir: string,
    target: Map<string, TeamTemplate>
): void {
    for (const t of readTemplatesFromDir(dir)) {
        target.set(t.name, t);
    }
}

function readTemplatesFromDir(dir: string): TeamTemplate[] {
    if (!fs.existsSync(dir)) return [];

    const templates: TeamTemplate[] = [];
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return [];
    }

    for (const file of entries) {
        if (!file.endsWith(".json")) continue;
        try {
            const content = fs.readFileSync(path.join(dir, file), "utf-8");
            const parsed = JSON.parse(content) as unknown;
            const errors = validateTemplate(parsed);
            if (errors.length === 0) {
                templates.push(parsed as TeamTemplate);
            }
        } catch {
            // Skip invalid files
        }
    }

    return templates;
}
