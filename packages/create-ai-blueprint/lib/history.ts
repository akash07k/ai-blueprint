import fs from "node:fs/promises";
import path from "node:path";

import { parseCompatibilityFeature } from "./current-work.js";

type HistoryItemType = "feature" | "fix" | "rollback";

interface HistoryItem {
  type: HistoryItemType;
  title: string;
  buildPlanItem: string | null;
  status: string | null;
  file: string;
}

interface HistorySummary {
  items: HistoryItem[];
  total: number;
}

const HISTORY_PATH = path.join("blueprint", "history");
const HISTORY_GROUPS: ReadonlyArray<{
  directory: string;
  type: HistoryItemType;
}> = [
  { directory: "features", type: "feature" },
  { directory: "fixes", type: "fix" },
  { directory: "rollbacks", type: "rollback" }
];

async function readHistory(projectRoot: string): Promise<HistorySummary> {
  const items = (
    await Promise.all(
      HISTORY_GROUPS.map((group) => readHistoryGroup(projectRoot, group))
    )
  ).flat();

  return {
    items: items.sort(compareHistoryItems),
    total: items.length
  };
}

async function readHistoryGroup(
  projectRoot: string,
  group: (typeof HISTORY_GROUPS)[number]
): Promise<HistoryItem[]> {
  const historyRoot = path.join(projectRoot, HISTORY_PATH);
  const directoryPath = path.join(projectRoot, HISTORY_PATH, group.directory);

  try {
    if (
      !(await isRegularDirectory(historyRoot)) ||
      !(await isRegularDirectory(directoryPath))
    ) {
      return [];
    }

    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const markdownFiles = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          entry.name.toLowerCase() !== "readme.md"
      )
      .sort((left, right) => left.name.localeCompare(right.name));

    return Promise.all(
      markdownFiles.map(async (entry) => {
        const relativeFile = path.join(group.directory, entry.name);
        const markdown = await fs.readFile(path.join(directoryPath, entry.name), "utf8");
        return parseHistoryItem(markdown, group.type, relativeFile);
      })
    );
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function isRegularDirectory(directoryPath: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(directoryPath);
    return !stats.isSymbolicLink() && stats.isDirectory();
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function parseHistoryItem(
  markdown: string,
  fallbackType: HistoryItemType,
  file: string
): HistoryItem {
  const heading = markdown.match(/^#\s+(?:(Feature|Fix|Rollback):\s*)?(.+)$/im);
  const fieldIdentity = markdown.match(
    /^\*\*(Feature|Fix|Rollback):\*\*\s*(.+)$/im
  );
  const genericHeading = heading?.[2]?.trim() || null;
  const canonicalType = normalizeHistoryType(heading?.[1] || fieldIdentity?.[1]);
  const compatibilityFeature = fallbackType === "feature" &&
      (!canonicalType || canonicalType === "feature")
    ? parseCompatibilityFeature(markdown, genericHeading)
    : null;
  const type = canonicalType ||
    (compatibilityFeature ? "feature" : fallbackType);
  const fieldValue = fieldIdentity?.[2]?.trim() || null;
  const fieldFeatureIdentity = type === "feature"
    ? fieldValue?.match(/^([0-9]+[a-z]?)\.?(?:\s+|$)(.*)$/i)
    : null;
  const title = heading?.[1]
    ? genericHeading || titleFromFile(file)
    : fieldFeatureIdentity?.[2]?.trim() || fieldValue || compatibilityFeature?.title ||
      genericHeading || titleFromFile(file);
  const explicitBuildPlanItem = markdown.match(
    /^\*\*From build-plan:\*\*\s*feature\s+([0-9]+[a-z]?)\b/im
  )?.[1]?.toLowerCase() || null;
  const buildPlanItem = explicitBuildPlanItem ||
    fieldFeatureIdentity?.[1]?.toLowerCase() ||
    compatibilityFeature?.id ||
    null;
  const status = markdown.match(/^\*\*Status:\*\*\s*(.+)$/im)?.[1]?.trim() || null;

  return { type, title, buildPlanItem, status, file };
}

function titleFromFile(file: string): string {
  const basename = path.basename(file, ".md").replace(/^\d+[a-z]?-/, "");
  return basename
    .split("-")
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function normalizeHistoryType(value: string | undefined): HistoryItemType | null {
  const normalized = value?.toLowerCase();
  return normalized === "feature" || normalized === "fix" || normalized === "rollback"
    ? normalized
    : null;
}

function compareHistoryItems(left: HistoryItem, right: HistoryItem): number {
  const leftId = parseBuildPlanOrder(left.buildPlanItem);
  const rightId = parseBuildPlanOrder(right.buildPlanItem);

  if (leftId !== rightId) {
    return rightId - leftId;
  }

  return right.file.localeCompare(left.file);
}

function parseBuildPlanOrder(value: string | null): number {
  if (!value) {
    return -1;
  }

  const match = value.match(/^(\d+)([a-z]?)$/i);
  if (!match) {
    return -1;
  }

  const whole = Number.parseInt(match[1] || "0", 10);
  const suffix = match[2]?.toLowerCase().charCodeAt(0) || 96;
  return whole * 100 + Math.max(0, suffix - 96);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export { HISTORY_PATH, parseHistoryItem, readHistory };

export type { HistoryItem, HistoryItemType, HistorySummary };
