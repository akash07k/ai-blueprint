import fs from "node:fs/promises";
import path from "node:path";

import { readBuildPlan } from "./build-plan.js";
import type {
  BuildPlanItem,
  BuildPlanSummary
} from "./build-plan.js";
import { readCurrentWork } from "./current-work.js";
import type {
  CurrentWorkSummary,
  CurrentWorkType
} from "./current-work.js";
import { readFindings } from "./findings.js";
import type {
  Finding,
  FindingsSummary,
  FindingStatus
} from "./findings.js";
import { readGitStatus } from "./git-status.js";
import type { GitStatusSummary } from "./git-status.js";
import { readProjectMetadata } from "./project-metadata.js";
import type { ProjectAdapter } from "./project-metadata.js";
import { inspectGeneratedSkillHealth } from "./update.js";
import type { GeneratedSkillHealth } from "./update.js";

type OverviewState = "current" | "missing" | "stale" | "unknown";
type CompletionState = "blocked" | "needs_verification" | "ready";

interface StatusWarning {
  code: string;
  message: string;
}

interface StatusBuildPlan {
  completed: number;
  remaining: number;
  total: number;
  nextItem: Pick<BuildPlanItem, "id" | "title"> | null;
  splitParents: Array<Pick<BuildPlanItem, "id" | "title">>;
}

interface StatusCurrentWork {
  state: CurrentWorkSummary["state"];
  type: CurrentWorkType | null;
  title: string | null;
  status: string | null;
  buildPlanItem: string | null;
  completed: number;
  remaining: number;
  total: number;
  nextStep: { title: string } | null;
}

interface StatusFindings {
  total: number;
  byStatus: Record<FindingStatus, number>;
  active: Array<Pick<Finding, "id" | "severity" | "status" | "title">>;
  blockers: Array<Pick<Finding, "id" | "severity" | "status" | "title">>;
}

interface StatusOverview {
  state: OverviewState;
  reason: string | null;
}

interface StatusNextAction {
  command: string | null;
  reason: string;
}

interface StatusCompletion {
  state: CompletionState;
  blockers: string[];
}

interface HumanStatusOptions {
  color?: boolean;
}

interface ReadProjectStatusOptions {
  packageVersion?: string;
  syncSurface?: "global" | "package";
}

interface TextStyle {
  bold: (value: string) => string;
  brightCyan: (value: string) => string;
  cyan: (value: string) => string;
  dim: (value: string) => string;
  green: (value: string) => string;
  red: (value: string) => string;
  yellow: (value: string) => string;
}

interface ProjectStatus {
  schemaVersion: 1;
  health: "ok" | "warning";
  project: {
    name: string;
    root: string;
  };
  blueprint: {
    version: string | null;
    adapters: ProjectAdapter[];
  };
  plans: {
    overview: StatusOverview;
    build: StatusBuildPlan;
  };
  currentWork: StatusCurrentWork;
  findings: StatusFindings;
  git: GitStatusSummary;
  completion: StatusCompletion;
  nextAction: StatusNextAction;
  warnings: StatusWarning[];
}

const PROJECT_PLAN_PATH = path.join("blueprint", "project-plan.md");
const BUILD_PLAN_PATH = path.join("blueprint", "build-plan.md");
const OVERVIEW_PATH = path.join(
  "blueprint",
  "context",
  "project-overview.md"
);

async function readProjectStatus(
  startPath: string = process.cwd(),
  { packageVersion, syncSurface = "package" }: ReadProjectStatusOptions = {}
): Promise<ProjectStatus> {
  const metadata = await readProjectMetadata(startPath);
  const skillHealth = metadata.warnings.some((warning) => warning.code === "invalid_manifest")
    ? null
    : await inspectGeneratedSkillHealth(metadata.project.root);
  const [buildPlan, currentWork, findings, git, overviewResult] = await Promise.all([
    readBuildPlan(metadata.project.root),
    readCurrentWork(metadata.project.root),
    readFindings(metadata.project.root),
    readGitStatus(metadata.project.root),
    readOverviewStatus(metadata.project.root)
  ]);
  const warnings: StatusWarning[] = [
    ...metadata.warnings,
    ...buildPlan.warnings,
    ...currentWork.warnings,
    ...findings.warnings,
    ...overviewResult.warnings,
    ...findSkillHealthWarnings(skillHealth, packageVersion, syncSurface),
    ...findDrift(buildPlan, currentWork, git)
  ];
  const completion = selectCompletion(currentWork, findings, git);
  const nextAction = selectNextAction(
    overviewResult.overview,
    buildPlan,
    currentWork,
    findings
  );

  return {
    schemaVersion: metadata.schemaVersion,
    health: warnings.length > 0 || findings.blockers.length > 0
      ? "warning"
      : "ok",
    project: metadata.project,
    blueprint: metadata.blueprint,
    plans: {
      overview: overviewResult.overview,
      build: formatBuildPlan(buildPlan)
    },
    currentWork: formatCurrentWork(currentWork),
    findings: formatFindings(findings),
    git,
    completion,
    nextAction,
    warnings
  };
}

function findSkillHealthWarnings(
  health: GeneratedSkillHealth | null,
  packageVersion: string | undefined,
  syncSurface: ReadProjectStatusOptions["syncSurface"]
): StatusWarning[] {
  if (!health || !health.version) {
    return [];
  }

  const packageMatches = packageVersion === undefined || packageVersion === health.version;
  const syncCommand = (force = false): string => {
    const command = packageVersion === health.version && syncSurface === "global"
      ? "blueprint sync"
      : `npx @akash07k/create-ai-blueprint@${health.version} sync`;

    return force ? `${command} --force` : command;
  };
  const warnings: StatusWarning[] = [];

  if (packageVersion !== undefined && !packageMatches) {
    warnings.push({
      code: "generated_skills_package_version_mismatch",
      message:
        `Blueprint generated skills are locked to version ${health.version}, ` +
        `but the running package is ${packageVersion}. Run \`${syncCommand()}\`.`
    });
  }

  if (health.legacy) {
    warnings.push({
      code: "legacy_generated_skills",
      message: `Blueprint generated skills use a legacy manifest. Run \`${syncCommand()}\` to migrate the lock.`
    });
  }

  if (health.missing.length > 0) {
    warnings.push({
      code: "missing_generated_skills",
      message:
        `${health.missing.length} generated Blueprint skill file${health.missing.length === 1 ? " is" : "s are"} missing. ` +
        `Run \`${syncCommand()}\`.`
    });
  }

  if (health.modified.length > 0) {
    warnings.push({
      code: "modified_generated_skills",
      message:
        `${health.modified.length} generated Blueprint skill file${health.modified.length === 1 ? " was" : "s were"} modified. ` +
        `Run \`${syncCommand(true)}\` to back up and restore them.`
    });
  }

  if (health.unsafe.length > 0) {
    warnings.push({
      code: "unsafe_generated_skill_paths",
      message:
        `${health.unsafe.length} generated Blueprint skill file${health.unsafe.length === 1 ? " has" : "s have"} an unsafe parent path. ` +
        "Manually replace the symbolic-link or non-directory parent with a safe directory, then run sync. Do not use --force."
    });
  }

  return warnings;
}

function formatHumanStatus(
  status: ProjectStatus,
  options: HumanStatusOptions = {}
): string {
  const style = createTextStyle(options.color === true);
  const adapters = status.blueprint.adapters.length > 0
    ? status.blueprint.adapters.join(", ")
    : "none detected";
  const lines = [
    `${style.bold(style.cyan("Blueprint Status"))}  ${style.bold(status.project.name)}`,
    "",
    formatSection("Project", style),
    formatRow("Path", status.project.root, style),
    formatRow("Version", status.blueprint.version || "unknown", style),
    formatRow("Adapters", adapters, style),
    "",
    formatSection("Progress", style),
    formatRow("Overview", formatOverviewValue(status.plans.overview, style), style),
    formatRow("Build plan", formatBuildPlanValue(status.plans.build, style), style),
    formatRow("Work", formatWorkValue(status.currentWork, style), style)
  ];

  if (status.currentWork.state === "active") {
    lines.push(
      formatRow(
        "Steps",
        `${status.currentWork.completed}/${status.currentWork.total} complete`,
        style
      )
    );

    if (status.currentWork.nextStep) {
      lines.push(formatRow("Next step", status.currentWork.nextStep.title, style));
    }
  }

  lines.push(
    formatRow("Findings", formatFindingsValue(status.findings, style), style),
    formatRow("Completion", formatCompletionValue(status.completion, style), style),
    "",
    formatSection("Git", style)
  );
  appendGitLines(lines, status.git, style);

  if (status.warnings.length > 0) {
    lines.push("", formatSection("Attention", style));

    for (const warning of status.warnings) {
      lines.push(`  ${style.yellow("!")} ${style.yellow(warning.message)}`);
    }
  }

  lines.push("", formatSection("Next action", style));

  if (status.nextAction.command) {
    lines.push(`  ${style.bold(style.brightCyan(status.nextAction.command))}`);
  }

  lines.push(`  ${status.nextAction.reason}`);
  return lines.join("\n");
}

function shouldUseColor(
  isTTY: boolean | undefined = process.stdout.isTTY,
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return isTTY === true && !Object.hasOwn(environment, "NO_COLOR");
}

function formatSection(label: string, style: TextStyle): string {
  return style.bold(label);
}

function formatRow(label: string, value: string, style: TextStyle): string {
  return `  ${style.cyan(label.padEnd(14))}${value}`;
}

function formatOverviewValue(
  overview: StatusOverview,
  style: TextStyle
): string {
  return overview.state === "current"
    ? style.green("current")
    : style.yellow(overview.state);
}

function formatBuildPlanValue(
  build: StatusBuildPlan,
  style: TextStyle
): string {
  if (build.total === 0) {
    return style.yellow("not ready");
  }

  const progress = `${build.completed}/${build.total} complete`;
  return build.remaining === 0 ? style.green(progress) : progress;
}

function formatWorkValue(work: StatusCurrentWork, style: TextStyle): string {
  if (work.state === "idle") {
    return style.dim("none");
  }

  if (work.state === "malformed") {
    return style.red("present but malformed");
  }

  const type = work.type || "work";
  const identity = type === "feature" && work.buildPlanItem
    ? `${work.buildPlanItem} - ${work.title || "untitled"}`
    : work.title || "untitled";
  return style.brightCyan(`${type} ${identity}`);
}

function formatFindingsValue(
  findings: StatusFindings,
  style: TextStyle
): string {
  if (findings.total === 0) {
    return style.green("none");
  }

  const activeGroups = new Map<string, string[]>();
  for (const finding of findings.active) {
    const key = `${finding.status} ${finding.severity}`;
    activeGroups.set(key, [...(activeGroups.get(key) || []), finding.id]);
  }
  const activeCounts = [...activeGroups.entries()].map(
    ([label, ids]) => `${ids.length} ${label} (${ids.join(", ")})`
  );
  const resolvedCounts = (["closed", "accepted", "invalid"] as const)
    .filter((status) => findings.byStatus[status] > 0)
    .map((status) => `${findings.byStatus[status]} ${status}`);
  const value = [...activeCounts, ...resolvedCounts].join(", ");

  if (findings.blockers.length > 0) {
    return style.red(value);
  }

  return findings.active.length > 0 ? style.yellow(value) : style.green(value);
}

function formatCompletionValue(
  completion: StatusCompletion,
  style: TextStyle
): string {
  if (completion.state === "ready") {
    return style.green("ready");
  }

  if (completion.state === "needs_verification") {
    return style.yellow("needs verification");
  }

  return style.red(`blocked: ${completion.blockers.join("; ")}`);
}

function appendGitLines(
  lines: string[],
  git: GitStatusSummary,
  style: TextStyle
): void {
  if (!git.available) {
    lines.push(formatRow("Status", style.red("not a Git repository"), style));
    return;
  }

  const workingTree = git.clean
    ? style.green("clean")
    : style.yellow(
        `${git.changedFiles} changed ${git.changedFiles === 1 ? "file" : "files"}`
      );
  const remote = git.upstream
    ? `${git.upstream} (${git.ahead || 0} ahead, ${git.behind || 0} behind)`
    : "not configured";
  const coloredRemote = git.upstream && git.ahead === 0 && git.behind === 0
    ? style.green(remote)
    : style.yellow(remote);

  lines.push(
    formatRow("Branch", git.branch || "unknown", style),
    formatRow("Working tree", workingTree, style),
    formatRow("Remote", coloredRemote, style)
  );

  if (git.lastCommit) {
    lines.push(`  ${style.cyan("Last commit")}`, `    ${git.lastCommit}`);
  }
}

function createTextStyle(enabled: boolean): TextStyle {
  const paint = (code: number, value: string): string =>
    enabled ? `\u001b[${code}m${value}\u001b[0m` : value;

  return {
    bold: (value) => paint(1, value),
    brightCyan: (value) => paint(96, value),
    cyan: (value) => paint(36, value),
    dim: (value) => paint(2, value),
    green: (value) => paint(32, value),
    red: (value) => paint(31, value),
    yellow: (value) => paint(33, value)
  };
}

function formatBuildPlan(buildPlan: BuildPlanSummary): StatusBuildPlan {
  return {
    completed: buildPlan.completed,
    remaining: buildPlan.remaining,
    total: buildPlan.total,
    nextItem: selectBuildPlanItem(buildPlan.nextItem),
    splitParents: buildPlan.splitParents.map((item) => ({
      id: item.id,
      title: item.title
    }))
  };
}

function formatCurrentWork(currentWork: CurrentWorkSummary): StatusCurrentWork {
  return {
    state: currentWork.state,
    type: currentWork.type,
    title: currentWork.title,
    status: currentWork.status,
    buildPlanItem: currentWork.buildPlanItem,
    completed: currentWork.completed,
    remaining: currentWork.remaining,
    total: currentWork.total,
    nextStep: currentWork.nextStep
      ? { title: currentWork.nextStep.title }
      : null
  };
}

function formatFindings(findings: FindingsSummary): StatusFindings {
  const selectFinding = (
    finding: Finding
  ): Pick<Finding, "id" | "severity" | "status" | "title"> => ({
    id: finding.id,
    severity: finding.severity,
    status: finding.status,
    title: finding.title
  });

  return {
    total: findings.total,
    byStatus: findings.byStatus,
    active: findings.items
      .filter((finding) =>
        finding.status === "unverified" ||
        finding.status === "open" ||
        finding.status === "fixed"
      )
      .map(selectFinding),
    blockers: findings.blockers.map(selectFinding)
  };
}

function selectBuildPlanItem(
  item: BuildPlanItem | null
): Pick<BuildPlanItem, "id" | "title"> | null {
  return item ? { id: item.id, title: item.title } : null;
}

function selectCompletion(
  currentWork: CurrentWorkSummary,
  findings: FindingsSummary,
  git: GitStatusSummary
): StatusCompletion {
  const blockers: string[] = [];

  if (currentWork.state !== "active") {
    blockers.push("no valid work spec is active");
  } else if (currentWork.remaining > 0) {
    blockers.push(`${currentWork.remaining} build steps remain`);
  }

  if (findings.blockers.length > 0) {
    blockers.push(
      `blocking findings ${findings.blockers.map((finding) => finding.id).join(", ")}`
    );
  }

  if (!git.available) {
    blockers.push("Git repository is unavailable");
  } else if (
    currentWork.type &&
    !isMatchingWorkBranch(git.branch, currentWork.type)
  ) {
    blockers.push(`branch does not match ${currentWork.type} work`);
  }

  if (blockers.length > 0) {
    return { state: "blocked", blockers };
  }

  return {
    state: "needs_verification",
    blockers: ["verification evidence is not persisted"]
  };
}

function selectNextAction(
  overview: StatusOverview,
  buildPlan: BuildPlanSummary,
  currentWork: CurrentWorkSummary,
  findings: FindingsSummary
): StatusNextAction {
  if (currentWork.state === "malformed") {
    return {
      command: "/doctor",
      reason: "Repair the current-work contract before continuing."
    };
  }

  if (currentWork.state === "active") {
    if (currentWork.nextStep) {
      return {
        command: "/implement",
        reason: `Resume with ${currentWork.nextStep.title}.`
      };
    }

    const openBlocker = findings.blockers.find(
      (finding) => finding.status === "open"
    );
    if (openBlocker) {
      return {
        command: "/implement",
        reason: `Repair blocking finding ${openBlocker.id}.`
      };
    }

    const fixedBlocker = findings.blockers.find(
      (finding) => finding.status === "fixed"
    );
    if (fixedBlocker) {
      return {
        command: "/audit",
        reason: `Re-review fixed finding ${fixedBlocker.id}.`
      };
    }

    return {
      command: "/check",
      reason: "All build steps are checked, but verification is not persisted."
    };
  }

  if (overview.state !== "current") {
    return {
      command: "/overview",
      reason: "Refresh the project overview before starting feature work."
    };
  }

  const openBlocker = findings.blockers.find(
    (finding) => finding.status === "open"
  );
  if (openBlocker) {
    return {
      command: `/fix ${openBlocker.id}`,
      reason: "Start a tracked repair for the blocking finding."
    };
  }

  const fixedBlocker = findings.blockers.find(
    (finding) => finding.status === "fixed"
  );
  if (fixedBlocker) {
    return {
      command: "/audit",
      reason: `Re-review fixed finding ${fixedBlocker.id}.`
    };
  }

  if (buildPlan.nextItem) {
    return {
      command: buildPlan.nextItem.id
        ? `/feature ${buildPlan.nextItem.id}`
        : `/feature "${buildPlan.nextItem.title}"`,
      reason: `Spec the next build-plan item, ${buildPlan.nextItem.title}.`
    };
  }

  if (buildPlan.total > 0 && buildPlan.remaining === 0) {
    return {
      command: null,
      reason: "The current milestone is complete. Review hardening, release, documentation, or propose a new capability."
    };
  }

  return {
    command: "/doctor",
    reason: "The build plan is not ready for feature work."
  };
}

function findDrift(
  buildPlan: BuildPlanSummary,
  currentWork: CurrentWorkSummary,
  git: GitStatusSummary
): StatusWarning[] {
  if (currentWork.state !== "active") {
    return [];
  }

  const warnings: StatusWarning[] = [];

  if (git.available && (git.branch === "main" || git.branch === "master")) {
    warnings.push({
      code: "active_work_on_default_branch",
      message: `Active ${currentWork.type || "work"} is on the default branch.`
    });
  } else if (
    git.available &&
    currentWork.type &&
    !isMatchingWorkBranch(git.branch, currentWork.type)
  ) {
    warnings.push({
      code: "work_branch_mismatch",
      message: `Active ${currentWork.type} work does not match branch ${git.branch}.`
    });
  }

  if (currentWork.total > 0 && currentWork.remaining === 0) {
    warnings.push({
      code: "completed_steps_not_completed",
      message: "All current-work steps are checked, but the work has not been completed and archived."
    });
  }

  if (currentWork.type === "feature" && currentWork.buildPlanItem) {
    const matchingItem = buildPlan.items.find(
      (item) => item.id?.toLowerCase() === currentWork.buildPlanItem
    );

    if (!matchingItem) {
      warnings.push({
        code: "current_work_missing_from_build_plan",
        message: `Active feature ${currentWork.buildPlanItem} is not present in the build plan.`
      });
    } else if (matchingItem.checked) {
      warnings.push({
        code: "active_feature_already_checked",
        message: `Active feature ${currentWork.buildPlanItem} is already checked in the build plan.`
      });
    } else if (
      buildPlan.nextItem?.id &&
      buildPlan.nextItem.id.toLowerCase() !== currentWork.buildPlanItem
    ) {
      warnings.push({
        code: "current_work_build_plan_mismatch",
        message: `Active feature ${currentWork.buildPlanItem} does not match next build-plan item ${buildPlan.nextItem.id}.`
      });
    }
  }

  return warnings;
}

function isMatchingWorkBranch(
  branch: string | null,
  type: CurrentWorkType
): boolean {
  return branch?.startsWith(`${type}/`) === true;
}

async function readOverviewStatus(
  projectRoot: string
): Promise<{ overview: StatusOverview; warnings: StatusWarning[] }> {
  const warnings: StatusWarning[] = [];
  const overview = await readFileMtime(projectRoot, OVERVIEW_PATH);
  const projectPlan = await readFileMtime(projectRoot, PROJECT_PLAN_PATH);
  const buildPlan = await readFileMtime(projectRoot, BUILD_PLAN_PATH);

  if (overview.kind !== "file") {
    const message = fileStateMessage("Project overview", overview.kind);
    warnings.push({ code: `${overview.kind}_overview`, message });
    return {
      overview: {
        state: overview.kind === "missing" ? "missing" : "unknown",
        reason: message
      },
      warnings
    };
  }

  for (const [label, result] of [
    ["Project plan", projectPlan],
    ["Build plan", buildPlan]
  ] as const) {
    if (result.kind !== "file") {
      warnings.push({
        code: `${result.kind}_${label.toLowerCase().replace(" ", "_")}`,
        message: fileStateMessage(label, result.kind)
      });
    }
  }

  const newerPlan = [projectPlan, buildPlan].some(
    (result) => result.kind === "file" && result.mtimeMs > overview.mtimeMs
  );

  if (newerPlan) {
    const message = "Project overview is older than the project or build plan.";
    warnings.push({ code: "stale_overview", message });
    return {
      overview: { state: "stale", reason: message },
      warnings
    };
  }

  if (projectPlan.kind !== "file" || buildPlan.kind !== "file") {
    return {
      overview: {
        state: "unknown",
        reason: "Overview freshness cannot be confirmed because a planning file is unavailable."
      },
      warnings
    };
  }

  return {
    overview: { state: "current", reason: null },
    warnings
  };
}

type FileMtimeResult =
  | { kind: "file"; mtimeMs: number }
  | { kind: "invalid" | "missing" | "unsafe" };

async function readFileMtime(
  projectRoot: string,
  relativePath: string
): Promise<FileMtimeResult> {
  try {
    const stats = await fs.lstat(path.join(projectRoot, relativePath));

    if (stats.isSymbolicLink()) {
      return { kind: "unsafe" };
    }

    return stats.isFile()
      ? { kind: "file", mtimeMs: stats.mtimeMs }
      : { kind: "invalid" };
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") {
      return { kind: "missing" };
    }

    throw error;
  }
}

function fileStateMessage(
  label: string,
  kind: Exclude<FileMtimeResult["kind"], "file">
): string {
  if (kind === "missing") {
    return `${label} is missing.`;
  }

  if (kind === "unsafe") {
    return `${label} is a symbolic link and was not inspected.`;
  }

  return `${label} path is not a regular file.`;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export { formatHumanStatus, readProjectStatus, shouldUseColor };

export type {
  CompletionState,
  HumanStatusOptions,
  ReadProjectStatusOptions,
  OverviewState,
  ProjectStatus,
  StatusBuildPlan,
  StatusCompletion,
  StatusCurrentWork,
  StatusFindings,
  StatusNextAction,
  StatusOverview,
  StatusWarning
};
