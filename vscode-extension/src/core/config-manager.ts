/**
 * Configuration manager — reads/writes extension and project-level configs.
 * Project config is stored in .worktreepilot/config.json.
 */

import * as fs from "fs";
import * as path from "path";
import { logError } from "../utils/logger";

export interface ProjectConfig {
    projectName?: string;
    conventions?: {
        framework?: string;
        testFramework?: string;
        linter?: string;
    };
    sharedFiles?: string[];
    mergeTestCommand?: string;
    defaultTemplate?: string;
}

const CONFIG_DIR = ".worktreepilot";
const CONFIG_FILE = "config.json";

/**
 * Find and load the project config from .worktreepilot/config.json.
 * Searches upward from the given directory.
 */
export function loadProjectConfig(repoRoot: string): ProjectConfig | null {
    const configPath = path.join(repoRoot, CONFIG_DIR, CONFIG_FILE);

    if (!fs.existsSync(configPath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(configPath, "utf-8");
        return JSON.parse(content) as ProjectConfig;
    } catch (err) {
        logError("Failed to parse project config", err);
        return null;
    }
}

