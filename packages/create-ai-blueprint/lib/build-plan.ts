import fs from "node:fs/promises";
import path from "node:path";

interface BuildPlanItem {
  id: string | null;
  title: string;
  checked: boolean;
  depth: number;
  line: number;
}

type BuildPlanWarningCode =
  | "empty_build_plan"
  | "invalid_build_plan_path"
  | "missing_build_plan"
  | "no_checklist_items"
  | "placeholder_build_plan"
  | "unsafe_build_plan_path";

interface BuildPlanWarning {
  code: BuildPlanWarningCode;
  message: string;
}

interface BuildPlanSummary {
  items: BuildPlanItem[];
  leafItems: BuildPlanItem[];
  splitParents: BuildPlanItem[];
  completed: number;
  remaining: number;
  total: number;
  nextItem: BuildPlanItem | null;
  warnings: BuildPlanWarning[];
}

const CHECKBOX_PATTERN = /^(\s*)-\s+\[([ xX])\]\s+(.+?)\s*$/;
const BUILD_PLAN_PATH = path.join("blueprint", "build-plan.md");

async function readBuildPlan(projectRoot: string): Promise<BuildPlanSummary> {
  const buildPlanPath = path.join(projectRoot, BUILD_PLAN_PATH);

  try {
    const stats = await fs.lstat(buildPlanPath);

    if (stats.isSymbolicLink()) {
      return emptySummary({
        code: "unsafe_build_plan_path",
        message: "Build plan is a symbolic link and was not read."
      });
    }

    if (!stats.isFile()) {
      return emptySummary({
        code: "invalid_build_plan_path",
        message: "Build plan path is not a regular file."
      });
    }

    return parseBuildPlan(await fs.readFile(buildPlanPath, "utf8"));
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") {
      return emptySummary({
        code: "missing_build_plan",
        message: "Build plan is missing."
      });
    }

    throw error;
  }
}

function parseBuildPlan(markdown: string): BuildPlanSummary {
  if (markdown.trim() === "") {
    return emptySummary({
      code: "empty_build_plan",
      message: "Build plan is empty."
    });
  }

  const items = markdown
    .split(/\r?\n/)
    .map((line, index) => parseCheckboxItem(line, index + 1))
    .filter((item): item is BuildPlanItem => item !== null);

  if (items.length === 0) {
    return emptySummary({
      code: "no_checklist_items",
      message: "Build plan has no tracked checklist yet. Run /overview to format your feature list."
    });
  }

  if (hasStarterPlaceholders(items)) {
    return {
      ...emptySummary({
        code: "placeholder_build_plan",
        message: "Build plan still contains the starter feature placeholders."
      }),
      items
    };
  }

  const splitParents = items.filter((item, index) => {
    const nextItem = items[index + 1];
    return nextItem !== undefined && nextItem.depth > item.depth;
  });
  const splitParentLines = new Set(splitParents.map((item) => item.line));
  const leafItems = items.filter((item) => !splitParentLines.has(item.line));
  const completed = leafItems.filter((item) => item.checked).length;
  const remaining = leafItems.length - completed;

  return {
    items,
    leafItems,
    splitParents,
    completed,
    remaining,
    total: leafItems.length,
    nextItem: leafItems.find((item) => !item.checked) || null,
    warnings: []
  };
}

function parseCheckboxItem(line: string, lineNumber: number): BuildPlanItem | null {
  const match = line.match(CHECKBOX_PATTERN);

  if (!match) {
    return null;
  }

  const indent = match[1] || "";
  const marker = match[2] || "";
  const content = match[3] || "";
  const identity = parseItemIdentity(content);

  return {
    id: identity.id,
    title: identity.title,
    checked: marker.toLowerCase() === "x",
    depth: indent.replaceAll("\t", "  ").length,
    line: lineNumber
  };
}

function parseItemIdentity(content: string): Pick<BuildPlanItem, "id" | "title"> {
  const numberedMatch = content.match(/^(\d+[a-z]?)\.\s+(.+)$/i);
  const id = numberedMatch?.[1] || null;
  const label = numberedMatch?.[2] || content;
  const boldTitle = label.match(/^\*\*(.+?)\*\*/)?.[1];
  const plainTitle = label.split(/\s+-\s+/, 1)[0] || label;

  return {
    id,
    title: (boldTitle || plainTitle).trim()
  };
}

function hasStarterPlaceholders(items: readonly BuildPlanItem[]): boolean {
  const titles = new Set(items.map((item) => item.title.toLowerCase()));
  return titles.has("feature one") && titles.has("feature two");
}

function emptySummary(warning: BuildPlanWarning): BuildPlanSummary {
  return {
    items: [],
    leafItems: [],
    splitParents: [],
    completed: 0,
    remaining: 0,
    total: 0,
    nextItem: null,
    warnings: [warning]
  };
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export { BUILD_PLAN_PATH, parseBuildPlan, readBuildPlan };

export type {
  BuildPlanItem,
  BuildPlanSummary,
  BuildPlanWarning,
  BuildPlanWarningCode
};
