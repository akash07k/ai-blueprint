import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CONTROL_DIR = "blueprint/.state";
const MANIFEST_PATH = `${CONTROL_DIR}/manifest.json`;
const MANIFEST_SCHEMA_VERSION = 2;
const PACKAGE_NAME = "@akash07k/create-ai-blueprint";
const EXACT_PACKAGE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SKILL_IGNORE_BEGIN = "# BEGIN AI BLUEPRINT MANAGED SKILLS";
const SKILL_IGNORE_END = "# END AI BLUEPRINT MANAGED SKILLS";
const GENERATED_SKILL_ROOTS = [".agents/skills", ".claude/skills"] as const;
type Adapter = "codex" | "claude" | "copilot";
type AdapterMode = Adapter | "all";

interface TemplateFile {
  source: string;
  hash: string;
}

interface Manifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  packageName: typeof PACKAGE_NAME;
  version: string;
  adapters: Adapter[];
  managedFiles: Record<string, string>;
}

interface LegacyManifest {
  schemaVersion: 1;
  version: string;
  adapters: Adapter[];
  managedFiles: Record<string, string>;
}

type ManifestRecord = Manifest | LegacyManifest;

type FileState =
  | { type: "missing" | "symbolic link" | "directory" | "non-regular file" }
  | { type: "file"; hash: string };

interface DesiredOperation {
  path: string;
  desired: TemplateFile;
}

interface ExistingOperation extends DesiredOperation {
  current: FileState;
}

interface RemoveOperation {
  path: string;
  current: FileState;
}

interface ConflictOperation {
  path: string;
  desired: TemplateFile | null;
  current: FileState;
  operation: "replace" | "remove";
  reason: string;
}

interface UpdatePlan {
  add: DesiredOperation[];
  update: ExistingOperation[];
  remove: RemoveOperation[];
  conflicts: ConflictOperation[];
  unchanged: ExistingOperation[];
}

interface TextFileState {
  exists: boolean;
  content: string;
}

interface PreparedUpdate {
  targetDir: string;
  templateRoot: string;
  version: string;
  previousVersion: string;
  manifest: ManifestRecord | null;
  manifestState: TextFileState;
  desiredManifest: Manifest;
  adapters: Adapter[];
  templateFiles: Map<string, TemplateFile>;
  rootGitIgnore: TextFileState;
  desiredRootGitIgnore: string;
  plan: UpdatePlan;
}

interface ApplyUpdateOptions {
  replaceConflicts?: boolean;
  now?: () => Date;
}

interface SyncPackage {
  packageName: string;
  version: string;
}

interface PreparedSync {
  targetDir: string;
  templateRoot: string;
  manifest: ManifestRecord;
  manifestState: TextFileState;
  desiredManifest: Manifest;
  skillTemplateFiles: Map<string, TemplateFile>;
  shouldMigrateManifest: boolean;
  plan: UpdatePlan;
}

interface ApplySyncOptions {
  replaceConflicts?: boolean;
  now?: () => Date;
}

interface UpdateResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  backupDir: string | null;
}

interface GeneratedSkillHealth {
  legacy: boolean;
  missing: string[];
  modified: string[];
  unsafe: string[];
  version: string | null;
}

interface RootGitIgnoreWrite {
  wrote: boolean;
  content: string | null;
}

interface InstallManifestOptions {
  targetDir: string;
  templateRoot: string;
  version: string;
  adapter: AdapterMode;
}

const MANAGED_ROOTS: Record<Adapter | "common", readonly string[]> = {
  common: ["blueprint/README.md"],
  codex: [".agents/skills"],
  claude: [".claude/skills"],
  copilot: [".agents/skills"]
};

function adapterListFromMode(adapter: AdapterMode): Adapter[] {
  if (adapter === "all") {
    return ["codex", "claude", "copilot"];
  }

  return [adapter];
}

function createManifest(
  version: string,
  adapters: readonly Adapter[],
  templateFiles: ReadonlyMap<string, TemplateFile>
): Manifest {
  const managedFiles: Record<string, string> = {};

  for (const [relativePath, file] of [...templateFiles.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    managedFiles[relativePath] = file.hash;
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    packageName: PACKAGE_NAME,
    version,
    adapters: [...adapters].sort(),
    managedFiles
  };
}

async function collectManagedTemplateFiles(
  templateRoot: string,
  adapters: readonly Adapter[]
): Promise<Map<string, TemplateFile>> {
  const files = new Map<string, TemplateFile>();
  const roots = [
    ...MANAGED_ROOTS.common,
    ...adapters.flatMap((adapter) => MANAGED_ROOTS[adapter] || [])
  ];

  for (const relativeRoot of roots) {
    const sourceRoot = path.join(templateRoot, ...relativeRoot.split("/"));
    await collectSourceFiles(sourceRoot, relativeRoot, files);
  }

  return files;
}

async function collectSourceFiles(
  sourcePath: string,
  relativePath: string,
  files: Map<string, TemplateFile>
): Promise<void> {
  const stats = await fs.lstat(sourcePath);

  if (stats.isSymbolicLink()) {
    throw new Error(`Managed template path cannot be a symbolic link: ${relativePath}`);
  }

  if (stats.isDirectory()) {
    const children = (await fs.readdir(sourcePath)).sort();

    for (const child of children) {
      await collectSourceFiles(
        path.join(sourcePath, child),
        `${relativePath}/${child}`,
        files
      );
    }

    return;
  }

  if (!stats.isFile()) {
    throw new Error(`Managed template path is not a regular file: ${relativePath}`);
  }

  files.set(relativePath, {
    source: sourcePath,
    hash: await hashFile(sourcePath)
  });
}

async function readManifest(targetDir: string): Promise<ManifestRecord | null> {
  try {
    const state = await readTextFileState(targetDir, MANIFEST_PATH, "Blueprint manifest");

    if (!state.exists) {
      return null;
    }

    return parseManifest(state.content);
  } catch (error: unknown) {
    throw error;
  }
}

async function inspectGeneratedSkillHealth(targetDir: string): Promise<GeneratedSkillHealth> {
  const manifest = await readManifest(targetDir);

  if (!manifest) {
    return {
      legacy: false,
      missing: [],
      modified: [],
      unsafe: [],
      version: null
    };
  }

  const missing: string[] = [];
  const modified: string[] = [];
  const unsafe: string[] = [];

  for (const [relativePath, expectedHash] of Object.entries(manifest.managedFiles).sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    if (!isGeneratedSkillPath(relativePath)) {
      continue;
    }

    let current: FileState;

    try {
      current = await getTargetFileState(targetDir, relativePath);
    } catch (error: unknown) {
      if (isUnsafeGeneratedSkillParentError(error)) {
        unsafe.push(relativePath);
        continue;
      }

      throw error;
    }

    if (current.type === "missing") {
      missing.push(relativePath);
    } else if (current.type !== "file" || current.hash !== expectedHash) {
      modified.push(relativePath);
    }
  }

  return {
    legacy: manifest.schemaVersion === 1,
    missing,
    modified,
    unsafe,
    version: manifest.version
  };
}

function parseManifest(content: string): ManifestRecord {
  try {
    const manifest = JSON.parse(content);
    validateManifest(manifest);
    return manifest;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid Blueprint manifest JSON: ${MANIFEST_PATH}`);
    }

    throw error;
  }
}

function validateManifest(manifest: unknown): asserts manifest is ManifestRecord {
  const validAdapters: readonly Adapter[] = ["codex", "claude", "copilot"];
  const schemaVersion = isRecord(manifest) ? manifest.schemaVersion : null;
  const validManagedFiles =
    isRecord(manifest) &&
    isRecord(manifest.managedFiles) &&
    Object.entries(manifest.managedFiles).every(
      ([relativePath, hash]) =>
        isSafeRelativePath(relativePath) &&
        typeof hash === "string" &&
        /^[a-f0-9]{64}$/.test(hash)
    );
  const manifestAdapters: unknown[] = isRecord(manifest) && Array.isArray(manifest.adapters)
    ? manifest.adapters
    : [];
  const adaptersAreValid = manifestAdapters.every(
    (adapter): adapter is Adapter => validAdapters.includes(adapter as Adapter)
  );
  const uniqueAdapters = new Set(manifestAdapters);

  if (
    !isRecord(manifest) ||
    (schemaVersion !== 1 && schemaVersion !== MANIFEST_SCHEMA_VERSION) ||
    (schemaVersion === MANIFEST_SCHEMA_VERSION && manifest.packageName !== PACKAGE_NAME) ||
    !isExactPackageVersion(manifest.version) ||
    !Array.isArray(manifest.adapters) ||
    manifest.adapters.length === 0 ||
    !adaptersAreValid ||
    uniqueAdapters.size !== manifestAdapters.length ||
    !validManagedFiles
  ) {
    throw new Error(`Unsupported or invalid Blueprint manifest: ${MANIFEST_PATH}`);
  }
}

function isExactPackageVersion(value: unknown): value is string {
  return typeof value === "string" && EXACT_PACKAGE_VERSION.test(value);
}

async function prepareUpdate({
  targetDir,
  templateRoot,
  version
}: {
  targetDir: string;
  templateRoot: string;
  version: string;
}): Promise<PreparedUpdate> {
  const realTargetDir = await fs.realpath(targetDir);
  const manifestState = await readTextFileState(
    realTargetDir,
    MANIFEST_PATH,
    "Blueprint manifest"
  );
  const manifest = manifestState.exists ? parseManifest(manifestState.content) : null;
  const rootGitIgnore = await readRootGitIgnore(realTargetDir);
  const adapters = await detectInstalledAdapters(realTargetDir, manifest);

  if (adapters.length === 0) {
    throw new Error(
      "No installed Codex or Claude Blueprint skills were found in the target directory."
    );
  }

  const templateFiles = await collectManagedTemplateFiles(templateRoot, adapters);
  const desiredManifest = createManifest(version, adapters, templateFiles);
  const desiredRootGitIgnore = replaceSkillIgnoreBlock(
    rootGitIgnore.content,
    skillIgnoreEntries(desiredManifest.managedFiles)
  );
  const plan: UpdatePlan = {
    add: [],
    update: [],
    remove: [],
    conflicts: [],
    unchanged: []
  };

  for (const [relativePath, desired] of templateFiles) {
    const current = await getTargetFileState(realTargetDir, relativePath);

    if (current.type === "missing") {
      plan.add.push({ path: relativePath, desired });
      continue;
    }

    if (current.type !== "file") {
      plan.conflicts.push({
        path: relativePath,
        desired,
        current,
        operation: "replace",
        reason: `target is ${current.type}`
      });
      continue;
    }

    if (current.hash === desired.hash) {
      plan.unchanged.push({ path: relativePath, desired, current });
      continue;
    }

    const previousHash = manifest?.managedFiles[relativePath];

    if (previousHash && current.hash === previousHash) {
      plan.update.push({ path: relativePath, desired, current });
      continue;
    }

    plan.conflicts.push({
      path: relativePath,
      desired,
      current,
      operation: "replace",
      reason: previousHash ? "managed file was modified locally" : "legacy file has no baseline"
    });
  }

  if (manifest) {
    for (const [relativePath, previousHash] of Object.entries(manifest.managedFiles)) {
      if (templateFiles.has(relativePath) || !isManagedPath(relativePath, adapters)) {
        continue;
      }

      const current = await getTargetFileState(realTargetDir, relativePath);

      if (current.type === "missing") {
        continue;
      }

      if (current.type === "file" && current.hash === previousHash) {
        plan.remove.push({ path: relativePath, current });
        continue;
      }

      plan.conflicts.push({
        path: relativePath,
        desired: null,
        current,
        operation: "remove",
        reason:
          current.type === "file"
            ? "obsolete managed file was modified locally"
            : `obsolete target is ${current.type}`
      });
    }
  }

  sortPlan(plan);

  return {
    targetDir: realTargetDir,
    templateRoot,
    version,
    previousVersion: manifest?.version || "legacy",
    manifest,
    manifestState,
    desiredManifest,
    adapters,
    templateFiles,
    rootGitIgnore,
    desiredRootGitIgnore,
    plan
  };
}

async function prepareSync({
  targetDir,
  templateRoot,
  packageName,
  version
}: {
  targetDir: string;
  templateRoot: string;
} & SyncPackage): Promise<PreparedSync> {
  if (packageName !== PACKAGE_NAME) {
    throw new Error("Running package identity does not match the Blueprint sync contract.");
  }

  const realTargetDir = await fs.realpath(targetDir);
  const manifestState = await readTextFileState(
    realTargetDir,
    MANIFEST_PATH,
    "Blueprint manifest"
  );

  if (!manifestState.exists) {
    throw new Error(`Blueprint manifest is required for sync: ${MANIFEST_PATH}`);
  }

  const manifest = parseManifest(manifestState.content);

  if (manifest.version !== version) {
    throw new Error(
      `Running package version ${version} does not match manifest version ${manifest.version}.`
    );
  }

  const templateFiles = await collectManagedTemplateFiles(templateRoot, manifest.adapters);
  const desiredManifest = createManifest(version, manifest.adapters, templateFiles);

  if (!matchesManifestLock(manifest, desiredManifest)) {
    throw new Error("Bundled Blueprint template does not match the manifest lock.");
  }

  const skillTemplateFiles = collectSkillTemplateFiles(templateFiles);
  const plan: UpdatePlan = {
    add: [],
    update: [],
    remove: [],
    conflicts: [],
    unchanged: []
  };

  for (const [relativePath, desired] of skillTemplateFiles) {
    const current = await getTargetFileState(realTargetDir, relativePath);

    if (current.type === "missing") {
      plan.add.push({ path: relativePath, desired });
      continue;
    }

    if (current.type !== "file") {
      plan.conflicts.push({
        path: relativePath,
        desired,
        current,
        operation: "replace",
        reason: `target is ${current.type}`
      });
      continue;
    }

    if (current.hash === desired.hash) {
      plan.unchanged.push({ path: relativePath, desired, current });
      continue;
    }

    plan.conflicts.push({
      path: relativePath,
      desired,
      current,
      operation: "replace",
      reason: "managed skill was modified locally"
    });
  }

  sortPlan(plan);

  return {
    targetDir: realTargetDir,
    templateRoot,
    manifest,
    manifestState,
    desiredManifest,
    skillTemplateFiles,
    shouldMigrateManifest: manifest.schemaVersion === 1,
    plan
  };
}

async function applyPreparedSync(
  prepared: PreparedSync,
  { replaceConflicts = false, now = () => new Date() }: ApplySyncOptions = {}
): Promise<UpdateResult> {
  const { plan } = prepared;
  const unsafeConflict = plan.conflicts.find((conflict) => conflict.current.type !== "file");

  if (unsafeConflict) {
    throw new Error(
      `Refusing to sync ${unsafeConflict.path}: ${unsafeConflict.reason}. Remove or replace that path manually.`
    );
  }

  if (plan.conflicts.length > 0 && !replaceConflicts) {
    throw new Error(
      `${plan.conflicts.length} managed skill conflict${plan.conflicts.length === 1 ? "" : "s"} must be resolved or explicitly replaced.`
    );
  }

  const replacements: ExistingOperation[] = [
    ...plan.update,
    ...plan.conflicts.filter(isReplaceConflict)
  ];
  const existingOperations = replacements;
  const identifier = `${formatTimestamp(now())}-sync-${sanitizeSegment(
    prepared.manifest.version
  )}-${crypto.randomBytes(4).toString("hex")}`;
  const backupDir = existingOperations.length
    ? targetPath(prepared.targetDir, `${CONTROL_DIR}/backups/${identifier}`)
    : null;
  const previousManifestFile = targetPath(prepared.targetDir, MANIFEST_PATH);
  const writtenAdds: DesiredOperation[] = [];
  const writtenReplacements: ExistingOperation[] = [];
  let manifestWritten = false;

  await assertPreparedSyncManifest(prepared);
  await assertPreparedSyncTemplate(prepared);
  await assertSyncTargetState(prepared);
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-blueprint-sync-"));

  try {
    await assertNoSymlinkParents(
      prepared.targetDir,
      `${CONTROL_DIR}/backups/${identifier}/placeholder`
    );

    for (const operation of [...plan.add, ...replacements]) {
      const stageFile = path.join(stagingDir, ...operation.path.split("/"));
      await fs.mkdir(path.dirname(stageFile), { recursive: true });
      await fs.copyFile(operation.desired.source, stageFile);

      if ((await hashFile(stageFile)) !== operation.desired.hash) {
        throw new Error(
          `Blueprint template changed after the sync plan was created: ${operation.path}`
        );
      }
    }

    await assertPreparedSyncManifest(prepared);
    await assertSyncTargetState(prepared);

    if (backupDir) {
      for (const operation of existingOperations) {
        await assertSyncTargetState(prepared, [operation]);
        const backupFile = path.join(backupDir, "files", ...operation.path.split("/"));
        await assertNoSymlinkParents(
          prepared.targetDir,
          `${CONTROL_DIR}/backups/${identifier}/files/${operation.path}`
        );
        await fs.mkdir(path.dirname(backupFile), { recursive: true });
        await fs.copyFile(targetPath(prepared.targetDir, operation.path), backupFile);
      }

      await assertPreparedSyncManifest(prepared);
      await assertNoSymlinkParents(
        prepared.targetDir,
        `${CONTROL_DIR}/backups/${identifier}/manifest.json`
      );
      await fs.copyFile(previousManifestFile, path.join(backupDir, "manifest.json"));
      await fs.writeFile(
        path.join(backupDir, "backup.json"),
        `${JSON.stringify(
          {
            fromVersion: prepared.manifest.version,
            toVersion: prepared.manifest.version,
            replaced: replacements.map((operation) => operation.path),
            removed: []
          },
          null,
          2
        )}\n`
      );
    }

    for (const operation of plan.add) {
      const stageFile = path.join(stagingDir, ...operation.path.split("/"));
      await writeSyncTargetFile(prepared, operation, stageFile);
      writtenAdds.push(operation);
    }

    for (const operation of replacements) {
      const stageFile = path.join(stagingDir, ...operation.path.split("/"));
      let rollbackRegistered = false;
      await writeSyncTargetFile(prepared, operation, stageFile, async () => {
        await assertSyncTargetState(prepared, [operation]);
        writtenReplacements.push(operation);
        rollbackRegistered = true;
      });

      if (!rollbackRegistered) {
        writtenReplacements.push(operation);
      }
    }

    if (prepared.shouldMigrateManifest) {
      await assertPreparedSyncManifest(prepared);
      await writeManifest(prepared.targetDir, prepared.desiredManifest);
      manifestWritten = true;
    }
  } catch (error: unknown) {
    try {
      const rollbackConflicts = await rollbackSyncFiles(
        prepared.targetDir,
        writtenAdds,
        writtenReplacements,
        backupDir
      );

      if (manifestWritten) {
        const currentManifest = await readTextFileState(
          prepared.targetDir,
          MANIFEST_PATH,
          "Blueprint manifest"
        );

        if (currentManifest.content === serializeManifest(prepared.desiredManifest)) {
          await restoreTextFileState(prepared.targetDir, MANIFEST_PATH, prepared.manifestState);
        } else {
          rollbackConflicts.push(MANIFEST_PATH);
        }
      }

      if (rollbackConflicts.length > 0) {
        throw new Error(
          `Rollback conflicts preserved externally changed paths: ${rollbackConflicts.join(", ")}`
        );
      }
    } catch (rollbackError: unknown) {
      throw new Error(
        `Blueprint sync failed: ${getErrorMessage(error)}. Rollback also failed: ${getErrorMessage(rollbackError)}`
      );
    }

    throw new Error(`Blueprint sync failed and was rolled back: ${getErrorMessage(error)}`);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }

  return {
    added: plan.add.length,
    updated: replacements.length,
    removed: 0,
    unchanged: plan.unchanged.length,
    backupDir
  };
}

async function applyPreparedUpdate(
  prepared: PreparedUpdate,
  { replaceConflicts = false, now = () => new Date() }: ApplyUpdateOptions = {}
): Promise<UpdateResult> {
  const { plan } = prepared;
  const unsafeConflict = plan.conflicts.find((conflict) => conflict.current.type !== "file");

  if (unsafeConflict) {
    throw new Error(
      `Refusing to update ${unsafeConflict.path}: ${unsafeConflict.reason}. Remove or replace that path manually.`
    );
  }

  if (plan.conflicts.length > 0 && !replaceConflicts) {
    throw new Error(
      `${plan.conflicts.length} managed file conflict${plan.conflicts.length === 1 ? "" : "s"} must be resolved or explicitly replaced.`
    );
  }

  const replacements: ExistingOperation[] = [
    ...plan.update,
    ...plan.conflicts.filter(isReplaceConflict)
  ];
  const removals = [
    ...plan.remove,
    ...plan.conflicts.filter((conflict) => conflict.operation === "remove")
  ];
  const existingOperations = [...replacements, ...removals];
  const identifier = `${formatTimestamp(now())}-${sanitizeSegment(
    prepared.previousVersion
  )}-to-${sanitizeSegment(prepared.version)}-${crypto
    .randomBytes(4)
    .toString("hex")}`;
  const backupDir = existingOperations.length
    ? targetPath(prepared.targetDir, `${CONTROL_DIR}/backups/${identifier}`)
    : null;
  const stagingDir = targetPath(prepared.targetDir, `${CONTROL_DIR}/staging/${identifier}`);
  let rootGitIgnoreWrite: RootGitIgnoreWrite | null = null;
  const writtenAdds: DesiredOperation[] = [];
  const writtenReplacements: ExistingOperation[] = [];
  const writtenRemovals: (RemoveOperation | ConflictOperation)[] = [];
  let wroteManifest = false;

  await assertPreparedUpdateManifest(prepared);
  await assertPreparedUpdateTargetState(prepared);
  await assertNoSymlinkParents(
    prepared.targetDir,
    `${CONTROL_DIR}/backups/${identifier}/placeholder`
  );

  try {
    await fs.mkdir(stagingDir, { recursive: true });

    for (const operation of [...plan.add, ...replacements]) {
      const stageFile = path.join(stagingDir, ...operation.path.split("/"));
      await fs.mkdir(path.dirname(stageFile), { recursive: true });
      await fs.copyFile(operation.desired.source, stageFile);

      if ((await hashFile(stageFile)) !== operation.desired.hash) {
        throw new Error(
          `Blueprint template changed after the update plan was created: ${operation.path}`
        );
      }
    }

    await assertPreparedUpdateManifest(prepared);
    await assertPreparedUpdateTargetState(prepared);

    if (backupDir) {
      for (const operation of existingOperations) {
        await assertPreparedUpdateTargetState(prepared, [operation]);
        const backupFile = path.join(backupDir, "files", ...operation.path.split("/"));
        await fs.mkdir(path.dirname(backupFile), { recursive: true });
        await fs.copyFile(targetPath(prepared.targetDir, operation.path), backupFile);
      }

      await assertPreparedUpdateManifest(prepared);
      if (prepared.manifestState.exists) {
        await fs.copyFile(
          targetPath(prepared.targetDir, MANIFEST_PATH),
          path.join(backupDir, "manifest.json")
        );
      }
      await fs.writeFile(
        path.join(backupDir, "backup.json"),
        `${JSON.stringify(
          {
            fromVersion: prepared.previousVersion,
            toVersion: prepared.version,
            replaced: replacements.map((operation) => operation.path),
            removed: removals.map((operation) => operation.path)
          },
          null,
          2
        )}\n`
      );
    }

    for (const operation of plan.add) {
      const stageFile = path.join(stagingDir, ...operation.path.split("/"));
      await writeUpdateTargetFile(prepared, operation, stageFile);
      writtenAdds.push(operation);
    }

    for (const operation of replacements) {
      const stageFile = path.join(stagingDir, ...operation.path.split("/"));
      let rollbackRegistered = false;
      await writeUpdateTargetFile(prepared, operation, stageFile, async () => {
        await assertPreparedUpdateTargetState(prepared, [operation]);
        writtenReplacements.push(operation);
        rollbackRegistered = true;
      });

      if (!rollbackRegistered) {
        writtenReplacements.push(operation);
      }
    }

    for (const operation of removals) {
      await assertPreparedUpdateTargetState(prepared, [operation]);
      await assertNoSymlinkParents(prepared.targetDir, operation.path);
      await assertPreparedUpdateTargetState(prepared, [operation]);
      await fs.rm(targetPath(prepared.targetDir, operation.path), { force: true });
      writtenRemovals.push(operation);
    }

    await assertPreparedUpdateManifest(prepared);
    await writeManifest(prepared.targetDir, prepared.desiredManifest);
    wroteManifest = true;
    await writeControlIgnore(prepared.targetDir);
    rootGitIgnoreWrite = await writeSkillIgnoreBlock(
      prepared.targetDir,
      prepared.rootGitIgnore,
      prepared.desiredRootGitIgnore
    );
  } catch (error: unknown) {
    try {
      const rollbackConflicts: string[] = [];

      for (const operation of writtenAdds) {
        if (!(await removeUpdateAddedTargetFile(prepared, operation))) {
          rollbackConflicts.push(operation.path);
        }
      }

      if (backupDir) {
        for (const operation of writtenReplacements) {
          const backupFile = path.join(backupDir, "files", ...operation.path.split("/"));
          if (!(await restoreUpdateTargetFile(prepared, operation, backupFile))) {
            rollbackConflicts.push(operation.path);
          }
        }

        for (const operation of writtenRemovals) {
          const backupFile = path.join(backupDir, "files", ...operation.path.split("/"));
          if (!(await restoreRemovedUpdateTargetFile(prepared, operation, backupFile))) {
            rollbackConflicts.push(operation.path);
          }
        }
      }

      if (wroteManifest) {
        const currentManifest = await readTextFileState(
          prepared.targetDir,
          MANIFEST_PATH,
          "Blueprint manifest"
        );

        if (
          currentManifest.exists &&
          currentManifest.content === serializeManifest(prepared.desiredManifest)
        ) {
          await restoreTextFileState(prepared.targetDir, MANIFEST_PATH, prepared.manifestState);
        } else if (
          currentManifest.exists !== prepared.manifestState.exists ||
          currentManifest.content !== prepared.manifestState.content
        ) {
          rollbackConflicts.push(MANIFEST_PATH);
        }
      }

      if (rootGitIgnoreWrite?.wrote && rootGitIgnoreWrite.content !== null) {
        await restoreRootGitIgnore(
          prepared.targetDir,
          prepared.rootGitIgnore,
          rootGitIgnoreWrite.content
        );
      }

      if (rollbackConflicts.length > 0) {
        throw new Error(
          `Preserved concurrent changes during rollback: ${rollbackConflicts.join(", ")}`
        );
      }
    } catch (rollbackError: unknown) {
      throw new Error(
        `Blueprint update failed: ${getErrorMessage(error)}. Rollback also failed: ${getErrorMessage(rollbackError)}`
      );
    }

    throw new Error(`Blueprint update failed and was rolled back: ${getErrorMessage(error)}`);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }

  return {
    added: plan.add.length,
    updated: replacements.length,
    removed: removals.length,
    unchanged: plan.unchanged.length,
    backupDir
  };
}

async function writeInstallManifest({
  targetDir,
  templateRoot,
  version,
  adapter
}: InstallManifestOptions): Promise<Manifest> {
  const rootGitIgnore = await readRootGitIgnore(targetDir);
  const previousManifest = await readTextFileState(targetDir, MANIFEST_PATH, "Blueprint manifest");
  const previousControlIgnore = await readTextFileState(
    targetDir,
    `${CONTROL_DIR}/.gitignore`,
    "Blueprint state ignore file"
  );
  const adapters = adapterListFromMode(adapter);
  const templateFiles = await collectManagedTemplateFiles(templateRoot, adapters);
  const manifest = createManifest(version, adapters, templateFiles);
  const desiredRootGitIgnore = replaceSkillIgnoreBlock(
    rootGitIgnore.content,
    skillIgnoreEntries(manifest.managedFiles)
  );
  let rootGitIgnoreWrite: RootGitIgnoreWrite | null = null;

  try {
    await writeManifest(targetDir, manifest);
    await writeControlIgnore(targetDir);
    rootGitIgnoreWrite = await writeSkillIgnoreBlock(
      targetDir,
      rootGitIgnore,
      desiredRootGitIgnore
    );
  } catch (error: unknown) {
    try {
      if (rootGitIgnoreWrite?.wrote && rootGitIgnoreWrite.content !== null) {
        await restoreRootGitIgnore(targetDir, rootGitIgnore, rootGitIgnoreWrite.content);
      }

      await restoreTextFileState(targetDir, MANIFEST_PATH, previousManifest);
      await restoreTextFileState(
        targetDir,
        `${CONTROL_DIR}/.gitignore`,
        previousControlIgnore
      );
    } catch (rollbackError: unknown) {
      throw new Error(
        `Blueprint install manifest write failed: ${getErrorMessage(error)}. Rollback also failed: ${getErrorMessage(rollbackError)}`
      );
    }

    throw new Error(`Blueprint install manifest write failed and was rolled back: ${getErrorMessage(error)}`);
  }

  return manifest;
}

async function detectInstalledAdapters(
  targetDir: string,
  manifest: ManifestRecord | null
): Promise<Adapter[]> {
  if (manifest) {
    return [...manifest.adapters];
  }

  const adapters = new Set<Adapter>();

  if (await pathExists(targetPath(targetDir, ".agents/skills"))) {
    adapters.add("codex");
  }

  if (await pathExists(targetPath(targetDir, ".claude/skills"))) {
    adapters.add("claude");
  }

  return (["codex", "claude"] as const).filter((adapter) => adapters.has(adapter));
}

async function writeManifest(targetDir: string, manifest: ManifestRecord): Promise<void> {
  await assertNoSymlinkParents(targetDir, MANIFEST_PATH);
  await atomicWrite(targetPath(targetDir, MANIFEST_PATH), serializeManifest(manifest));
}

function serializeManifest(manifest: ManifestRecord): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function writeControlIgnore(targetDir: string): Promise<void> {
  await assertNoSymlinkParents(targetDir, `${CONTROL_DIR}/.gitignore`);
  await atomicWrite(
    targetPath(targetDir, `${CONTROL_DIR}/.gitignore`),
    "backups/\nstaging/\n"
  );
}

async function writeSkillIgnoreBlock(
  targetDir: string,
  expectedState: TextFileState,
  desired: string
): Promise<RootGitIgnoreWrite> {
  const current = await readRootGitIgnore(targetDir);

  if (current.exists !== expectedState.exists || current.content !== expectedState.content) {
    throw new Error("Root .gitignore changed before the managed-skills block was written.");
  }

  if (desired !== current.content) {
    await atomicWrite(targetPath(targetDir, ".gitignore"), desired);
    return { wrote: true, content: desired };
  }

  return { wrote: false, content: null };
}

async function readRootGitIgnore(targetDir: string): Promise<TextFileState> {
  return readTextFileState(targetDir, ".gitignore", "root .gitignore");
}

async function readTextFileState(
  targetDir: string,
  relativePath: string,
  label: string
): Promise<TextFileState> {
  await assertNoSymlinkParents(targetDir, relativePath);
  const filePath = targetPath(targetDir, relativePath);

  try {
    const stats = await fs.lstat(filePath);

    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to replace symbolic-link ${label}.`);
    }

    if (!stats.isFile()) {
      throw new Error(`${label} is not a regular file.`);
    }

    return { exists: true, content: await fs.readFile(filePath, "utf8") };
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") {
      return { exists: false, content: "" };
    }

    throw error;
  }
}

async function restoreRootGitIgnore(
  targetDir: string,
  previous: TextFileState,
  writtenContent: string
): Promise<void> {
  const current = await readRootGitIgnore(targetDir);

  if (!current.exists || current.content !== writtenContent) {
    return;
  }

  await restoreTextFileState(targetDir, ".gitignore", previous);
}

async function restoreTextFileState(
  targetDir: string,
  relativePath: string,
  previous: TextFileState
): Promise<void> {
  const filePath = targetPath(targetDir, relativePath);

  if (previous.exists) {
    await atomicWrite(filePath, previous.content);
    return;
  }

  await fs.rm(filePath, { force: true });
}

function replaceSkillIgnoreBlock(content: string, entries: readonly string[]): string {
  const beginMarkers = findLineMarkers(content, SKILL_IGNORE_BEGIN);
  const endMarkers = findLineMarkers(content, SKILL_IGNORE_END);
  const block = `${SKILL_IGNORE_BEGIN}\n${entries.join("\n")}\n${SKILL_IGNORE_END}\n`;

  if (beginMarkers.length === 0 && endMarkers.length === 0) {
    if (content.length === 0) {
      return block;
    }

    return `${content}${content.endsWith("\n") ? "\n" : "\n\n"}${block}`;
  }

  if (
    beginMarkers.length !== 1 ||
    endMarkers.length !== 1 ||
    endMarkers[0] < beginMarkers[0]
  ) {
    throw new Error("Malformed AI Blueprint managed-skills block in root .gitignore.");
  }

  return `${content.slice(0, beginMarkers[0])}${block}${content.slice(
    markerLineEnd(content, endMarkers[0], SKILL_IGNORE_END)
  )}`;
}

function findLineMarkers(content: string, marker: string): number[] {
  const positions: number[] = [];
  let index = content.indexOf(marker);

  while (index !== -1) {
    const afterMarker = index + marker.length;
    const startsLine = index === 0 || content[index - 1] === "\n";
    const endsLine =
      afterMarker === content.length ||
      content[afterMarker] === "\n" ||
      (content[afterMarker] === "\r" && content[afterMarker + 1] === "\n");

    if (startsLine && endsLine) {
      positions.push(index);
    }

    index = content.indexOf(marker, afterMarker);
  }

  return positions;
}

function markerLineEnd(content: string, markerStart: number, marker: string): number {
  const afterMarker = markerStart + marker.length;

  if (content[afterMarker] === "\r" && content[afterMarker + 1] === "\n") {
    return afterMarker + 2;
  }

  return content[afterMarker] === "\n" ? afterMarker + 1 : afterMarker;
}

function skillIgnoreEntries(managedFiles: Record<string, string>): string[] {
  const entries = new Set<string>();

  for (const relativePath of Object.keys(managedFiles)) {
    const normalizedPath = normalizeRelativePath(relativePath);

    for (const root of GENERATED_SKILL_ROOTS) {
      if (!normalizedPath.startsWith(`${root}/`)) {
        continue;
      }

      const segments = normalizedPath.slice(root.length + 1).split("/");

      if (segments.length > 1 && segments[0]) {
        entries.add(`/${root}/${segments[0]}/`);
      }
    }
  }

  return [...entries].sort((left, right) => left.localeCompare(right));
}

function collectSkillTemplateFiles(
  templateFiles: ReadonlyMap<string, TemplateFile>
): Map<string, TemplateFile> {
  return new Map(
    [...templateFiles.entries()].filter(([relativePath]) => isGeneratedSkillPath(relativePath))
  );
}

function isGeneratedSkillPath(relativePath: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);

  return GENERATED_SKILL_ROOTS.some((root) => {
    if (!normalizedPath.startsWith(`${root}/`)) {
      return false;
    }

    return normalizedPath.slice(root.length + 1).split("/").length > 1;
  });
}

function matchesManifestLock(manifest: ManifestRecord, desired: Manifest): boolean {
  if (manifest.version !== desired.version || manifest.adapters.length !== desired.adapters.length) {
    return false;
  }

  const manifestAdapters = new Set(manifest.adapters);

  if (desired.adapters.some((adapter) => !manifestAdapters.has(adapter))) {
    return false;
  }

  const manifestEntries = Object.entries(manifest.managedFiles);
  const desiredEntries = Object.entries(desired.managedFiles);

  return (
    manifestEntries.length === desiredEntries.length &&
    desiredEntries.every(([relativePath, hash]) => manifest.managedFiles[relativePath] === hash)
  );
}

async function getTargetFileState(targetDir: string, relativePath: string): Promise<FileState> {
  await assertNoSymlinkParents(targetDir, relativePath);
  const absolutePath = targetPath(targetDir, relativePath);

  try {
    const stats = await fs.lstat(absolutePath);

    if (stats.isSymbolicLink()) {
      return { type: "symbolic link" };
    }

    if (stats.isDirectory()) {
      return { type: "directory" };
    }

    if (!stats.isFile()) {
      return { type: "non-regular file" };
    }

    return { type: "file", hash: await hashFile(absolutePath) };
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") {
      return { type: "missing" };
    }

    throw error;
  }
}

async function assertNoSymlinkParents(targetDir: string, relativePath: string): Promise<void> {
  const parts = normalizeRelativePath(relativePath).split("/");
  let current = targetDir;

  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);

    try {
      const stats = await fs.lstat(current);

      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to write through symbolic-link directory: ${current}`);
      }

      if (!stats.isDirectory()) {
        throw new Error(`Managed path parent is not a directory: ${current}`);
      }
    } catch (error: unknown) {
      if (getErrorCode(error) === "ENOENT") {
        return;
      }

      throw error;
    }
  }

}

function isUnsafeGeneratedSkillParentError(error: unknown): boolean {
  const message = getErrorMessage(error);

  return (
    message.startsWith("Refusing to write through symbolic-link directory:") ||
    message.startsWith("Managed path parent is not a directory:")
  );
}

function isManagedPath(relativePath: string, adapters: readonly Adapter[]): boolean {
  const roots = [
    ...MANAGED_ROOTS.common,
    ...adapters.flatMap((adapter) => MANAGED_ROOTS[adapter] || [])
  ];

  return roots.some(
    (root) => relativePath === root || relativePath.startsWith(`${root}/`)
  );
}

function sortPlan(plan: UpdatePlan): void {
  for (const operations of [plan.add, plan.update, plan.remove, plan.conflicts, plan.unchanged]) {
    operations.sort((a, b) => a.path.localeCompare(b.path));
  }
}

async function assertPreparedUpdateTargetState(
  prepared: PreparedUpdate,
  operations: readonly (DesiredOperation | ExistingOperation | RemoveOperation | ConflictOperation)[] = [
    ...prepared.plan.add,
    ...prepared.plan.update,
    ...prepared.plan.remove,
    ...prepared.plan.conflicts,
    ...prepared.plan.unchanged
  ]
): Promise<void> {
  for (const operation of operations) {
    const current = await getTargetFileState(prepared.targetDir, operation.path);
    const changed =
      "current" in operation
        ? current.type !== operation.current.type ||
          (current.type === "file" &&
            operation.current.type === "file" &&
            current.hash !== operation.current.hash)
        : current.type !== "missing";

    if (changed) {
      throw new Error(
        `Managed path changed after the update plan was created: ${operation.path}`
      );
    }
  }
}

async function assertPreparedUpdateManifest(prepared: PreparedUpdate): Promise<void> {
  const current = await readTextFileState(
    prepared.targetDir,
    MANIFEST_PATH,
    "Blueprint manifest"
  );

  if (
    current.exists !== prepared.manifestState.exists ||
    current.content !== prepared.manifestState.content
  ) {
    throw new Error("Blueprint manifest changed after the update plan was created.");
  }
}

async function assertSyncTargetState(
  prepared: PreparedSync,
  operations: readonly (DesiredOperation | ExistingOperation | ConflictOperation)[] = [
    ...prepared.plan.add,
    ...prepared.plan.update,
    ...prepared.plan.conflicts,
    ...prepared.plan.unchanged
  ]
): Promise<void> {
  for (const operation of operations) {
    const current = await getTargetFileState(prepared.targetDir, operation.path);

    const changed =
      "current" in operation
        ? current.type !== operation.current.type ||
          (current.type === "file" &&
            operation.current.type === "file" &&
            current.hash !== operation.current.hash)
        : current.type !== "missing";

    if (changed) {
      throw new Error(`Managed skill changed after the sync plan was created: ${operation.path}`);
    }
  }
}

async function assertPreparedSyncManifest(prepared: PreparedSync): Promise<void> {
  const current = await readTextFileState(
    prepared.targetDir,
    MANIFEST_PATH,
    "Blueprint manifest"
  );

  if (!current.exists || current.content !== prepared.manifestState.content) {
    throw new Error("Blueprint manifest changed after the sync plan was created.");
  }
}

async function assertPreparedSyncTemplate(prepared: PreparedSync): Promise<void> {
  const templateFiles = await collectManagedTemplateFiles(
    prepared.templateRoot,
    prepared.manifest.adapters
  );
  const currentManifest = createManifest(
    prepared.manifest.version,
    prepared.manifest.adapters,
    templateFiles
  );

  if (
    !matchesManifestLock(prepared.manifest, currentManifest) ||
    !matchesManifestLock(prepared.desiredManifest, currentManifest)
  ) {
    throw new Error("Bundled Blueprint template changed after the sync plan was created.");
  }
}

async function rollbackSyncFiles(
  targetDir: string,
  writtenAdds: readonly DesiredOperation[],
  writtenReplacements: readonly ExistingOperation[],
  backupDir: string | null
): Promise<string[]> {
  const conflicts: string[] = [];

  for (const operation of writtenAdds) {
    if (await targetMatchesTemplateFile(targetDir, operation.path, operation.desired)) {
      await fs.rm(targetPath(targetDir, operation.path), { force: true });
    } else {
      conflicts.push(operation.path);
    }
  }

  for (const operation of writtenReplacements) {
    if (!backupDir) {
      throw new Error(`Missing sync backup for ${operation.path}.`);
    }

    const backupFile = path.join(backupDir, "files", ...operation.path.split("/"));
    const restoration = await restoreSyncTargetFile(targetDir, operation, backupFile);

    if (restoration === "conflict") {
      conflicts.push(operation.path);
    }
  }

  return conflicts;
}

async function targetMatchesTemplateFile(
  targetDir: string,
  relativePath: string,
  desired: TemplateFile
): Promise<boolean> {
  const current = await getTargetFileState(targetDir, relativePath);
  return current.type === "file" && current.hash === desired.hash;
}

async function writeSyncTargetFile(
  prepared: PreparedSync,
  operation: DesiredOperation | ExistingOperation,
  source: string,
  beforeDestructiveReplace?: () => Promise<void>
): Promise<void> {
  const content = await fs.readFile(source);
  const target = targetPath(prepared.targetDir, operation.path);
  await assertSyncTargetState(prepared, [operation]);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await assertSyncTargetState(prepared, [operation]);

  if ("current" in operation) {
    await atomicWriteSyncTarget(
      prepared.targetDir,
      operation.path,
      target,
      content,
      {
        beforeMutation: () => assertSyncTargetState(prepared, [operation]),
        beforeDestructiveReplace,
        beforeFallbackRename: () => assertTargetIsMissing(prepared.targetDir, operation.path)
      }
    );
    return;
  }

  await atomicCreateSyncTargetIfMissing(prepared.targetDir, operation.path, target, content, {
    beforeMutation: () => assertSyncTargetState(prepared, [operation])
  });
}

async function restoreSyncTargetFile(
  targetDir: string,
  operation: ExistingOperation,
  source: string
): Promise<"restored" | "unchanged" | "conflict"> {
  const content = await fs.readFile(source);
  const target = targetPath(targetDir, operation.path);

  const beforeMkdir = await getTargetFileState(targetDir, operation.path);

  if (matchesFileState(beforeMkdir, operation.current)) {
    return "unchanged";
  }

  if (!isSyncRollbackWriteState(beforeMkdir, operation.desired)) {
    return "conflict";
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  const afterMkdir = await getTargetFileState(targetDir, operation.path);

  if (matchesFileState(afterMkdir, operation.current)) {
    return "unchanged";
  }

  if (!isSyncRollbackWriteState(afterMkdir, operation.desired)) {
    return "conflict";
  }

  await atomicWriteSyncTarget(targetDir, operation.path, target, content, {
    beforeMutation: () => assertSyncRollbackWriteState(targetDir, operation),
    beforeFallbackRename: () => assertTargetIsMissing(targetDir, operation.path)
  });
  return "restored";
}

function matchesFileState(current: FileState, expected: FileState): boolean {
  return (
    current.type === expected.type &&
    (current.type !== "file" ||
      expected.type !== "file" ||
      current.hash === expected.hash)
  );
}

function isSyncRollbackWriteState(current: FileState, desired: TemplateFile): boolean {
  return current.type === "missing" || (current.type === "file" && current.hash === desired.hash);
}

async function writeUpdateTargetFile(
  prepared: PreparedUpdate,
  operation: DesiredOperation | ExistingOperation,
  source: string,
  beforeDestructiveReplace?: () => Promise<void>
): Promise<void> {
  const content = await fs.readFile(source);
  const target = targetPath(prepared.targetDir, operation.path);
  await assertPreparedUpdateTargetState(prepared, [operation]);
  await assertNoSymlinkParents(prepared.targetDir, operation.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await assertPreparedUpdateTargetState(prepared, [operation]);

  if ("current" in operation) {
    await atomicWriteUpdateTarget(
      prepared.targetDir,
      operation.path,
      target,
      content,
      {
        beforeMutation: () => assertPreparedUpdateTargetState(prepared, [operation]),
        beforeDestructiveReplace,
        beforeFallbackRename: () => assertUpdateTargetIsMissing(prepared.targetDir, operation.path)
      }
    );
    return;
  }

  await atomicCreateUpdateTargetIfMissing(prepared.targetDir, operation.path, target, content, {
    beforeMutation: () => assertPreparedUpdateTargetState(prepared, [operation])
  });
}

async function removeUpdateAddedTargetFile(
  prepared: PreparedUpdate,
  operation: DesiredOperation
): Promise<boolean> {
  const current = await getTargetFileState(prepared.targetDir, operation.path);

  if (current.type === "missing") {
    return true;
  }

  if (current.type !== "file" || current.hash !== operation.desired.hash) {
    return false;
  }

  await assertNoSymlinkParents(prepared.targetDir, operation.path);
  const finalState = await getTargetFileState(prepared.targetDir, operation.path);

  if (finalState.type === "missing") {
    return true;
  }

  if (finalState.type !== "file" || finalState.hash !== operation.desired.hash) {
    return false;
  }

  await fs.rm(targetPath(prepared.targetDir, operation.path), { force: true });
  return true;
}

async function restoreUpdateTargetFile(
  prepared: PreparedUpdate,
  operation: ExistingOperation,
  source: string
): Promise<boolean> {
  const content = await fs.readFile(source);
  const target = targetPath(prepared.targetDir, operation.path);
  const beforeMkdir = await getTargetFileState(prepared.targetDir, operation.path);

  if (matchesFileState(beforeMkdir, operation.current)) {
    return true;
  }

  if (!isSyncRollbackWriteState(beforeMkdir, operation.desired)) {
    return false;
  }

  await assertNoSymlinkParents(prepared.targetDir, operation.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const afterMkdir = await getTargetFileState(prepared.targetDir, operation.path);

  if (matchesFileState(afterMkdir, operation.current)) {
    return true;
  }

  if (!isSyncRollbackWriteState(afterMkdir, operation.desired)) {
    return false;
  }

  await atomicWriteUpdateTarget(prepared.targetDir, operation.path, target, content, {
    beforeMutation: () => assertUpdateRollbackWriteState(prepared.targetDir, operation),
    beforeFallbackRename: () => assertUpdateTargetIsMissing(prepared.targetDir, operation.path)
  });
  return true;
}

async function restoreRemovedUpdateTargetFile(
  prepared: PreparedUpdate,
  operation: RemoveOperation | ConflictOperation,
  source: string
): Promise<boolean> {
  const content = await fs.readFile(source);
  const target = targetPath(prepared.targetDir, operation.path);
  const beforeMkdir = await getTargetFileState(prepared.targetDir, operation.path);

  if (matchesFileState(beforeMkdir, operation.current)) {
    return true;
  }

  if (beforeMkdir.type !== "missing") {
    return false;
  }

  await assertNoSymlinkParents(prepared.targetDir, operation.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const afterMkdir = await getTargetFileState(prepared.targetDir, operation.path);

  if (matchesFileState(afterMkdir, operation.current)) {
    return true;
  }

  if (afterMkdir.type !== "missing") {
    return false;
  }

  await atomicCreateUpdateTargetIfMissing(prepared.targetDir, operation.path, target, content, {
    beforeMutation: () => assertUpdateTargetIsMissing(prepared.targetDir, operation.path)
  });
  return true;
}

async function atomicWrite(target: string, content: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteToReadyParent(target, content);
}

async function atomicWriteToReadyParent(
  target: string,
  content: string | Uint8Array,
  { beforeDestructiveReplace }: { beforeDestructiveReplace?: () => Promise<void> } = {}
): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.blueprint-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  );
  await fs.writeFile(temporary, content);

  try {
    await fs.rename(temporary, target);
  } catch (error: unknown) {
    if (!["EEXIST", "EPERM"].includes(getErrorCode(error) ?? "")) {
      await fs.rm(temporary, { force: true });
      throw error;
    }

    await beforeDestructiveReplace?.();
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
  }
}

async function atomicWriteSyncTarget(
  targetRoot: string,
  relativePath: string,
  target: string,
  content: string | Uint8Array,
  {
    beforeMutation,
    beforeDestructiveReplace,
    beforeFallbackRename
  }: {
    beforeMutation: () => Promise<void>;
    beforeDestructiveReplace?: () => Promise<void>;
    beforeFallbackRename?: () => Promise<void>;
  }
): Promise<void> {
  const temporary = createAtomicTemporaryPath(target);
  await assertReadySyncTargetParent(targetRoot, relativePath, target);
  await beforeMutation();
  await fs.writeFile(temporary, content);

  try {
    await assertReadySyncTargetParent(targetRoot, relativePath, target);
    await beforeMutation();
    await fs.rename(temporary, target);
  } catch (error: unknown) {
    if (!["EEXIST", "EPERM"].includes(getErrorCode(error) ?? "")) {
      await fs.rm(temporary, { force: true });
      throw error;
    }

    try {
      await beforeDestructiveReplace?.();
      await assertReadySyncTargetParent(targetRoot, relativePath, target);
      await fs.rm(target, { force: true });
      await assertReadySyncTargetParent(targetRoot, relativePath, target);
      await beforeFallbackRename?.();
      await fs.rename(temporary, target);
    } catch (fallbackError: unknown) {
      await fs.rm(temporary, { force: true });
      throw fallbackError;
    }
  }
}

async function atomicWriteUpdateTarget(
  targetRoot: string,
  relativePath: string,
  target: string,
  content: string | Uint8Array,
  {
    beforeMutation,
    beforeDestructiveReplace,
    beforeFallbackRename
  }: {
    beforeMutation: () => Promise<void>;
    beforeDestructiveReplace?: () => Promise<void>;
    beforeFallbackRename?: () => Promise<void>;
  }
): Promise<void> {
  const temporary = createAtomicTemporaryPath(target);
  await assertReadyUpdateTargetParent(targetRoot, relativePath, target);
  await beforeMutation();
  await fs.writeFile(temporary, content);

  try {
    await assertReadyUpdateTargetParent(targetRoot, relativePath, target);
    await beforeMutation();
    await fs.rename(temporary, target);
  } catch (error: unknown) {
    if (!["EEXIST", "EPERM"].includes(getErrorCode(error) ?? "")) {
      await fs.rm(temporary, { force: true });
      throw error;
    }

    try {
      await assertReadyUpdateTargetParent(targetRoot, relativePath, target);
      await beforeDestructiveReplace?.();
      await fs.rm(target, { force: true });
      await assertReadyUpdateTargetParent(targetRoot, relativePath, target);
      await beforeFallbackRename?.();
      await fs.rename(temporary, target);
    } catch (fallbackError: unknown) {
      await fs.rm(temporary, { force: true });
      throw fallbackError;
    }
  }
}

async function atomicCreateUpdateTargetIfMissing(
  targetRoot: string,
  relativePath: string,
  target: string,
  content: string | Uint8Array,
  { beforeMutation }: { beforeMutation: () => Promise<void> }
): Promise<void> {
  const temporary = createAtomicTemporaryPath(target);
  await assertReadyUpdateTargetParent(targetRoot, relativePath, target);
  await beforeMutation();
  await fs.writeFile(temporary, content);

  try {
    await assertReadyUpdateTargetParent(targetRoot, relativePath, target);
    await beforeMutation();
    await fs.link(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function atomicCreateSyncTargetIfMissing(
  targetRoot: string,
  relativePath: string,
  target: string,
  content: string | Uint8Array,
  { beforeMutation }: { beforeMutation: () => Promise<void> }
): Promise<void> {
  const temporary = createAtomicTemporaryPath(target);
  await assertReadySyncTargetParent(targetRoot, relativePath, target);
  await beforeMutation();
  await fs.writeFile(temporary, content);

  try {
    await assertReadySyncTargetParent(targetRoot, relativePath, target);
    await beforeMutation();
    await fs.link(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function createAtomicTemporaryPath(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.blueprint-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  );
}

async function assertReadySyncTargetParent(
  targetRoot: string,
  relativePath: string,
  target: string
): Promise<void> {
  await assertNoSymlinkParents(targetRoot, relativePath);
  const [canonicalRoot, canonicalParent] = await Promise.all([
    fs.realpath(targetRoot),
    fs.realpath(path.dirname(target))
  ]);
  const relativeParent = path.relative(canonicalRoot, canonicalParent);

  if (
    relativeParent === ".." ||
    relativeParent.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeParent)
  ) {
    throw new Error(`Sync target parent escaped the Blueprint project: ${relativePath}`);
  }
}

async function assertReadyUpdateTargetParent(
  targetRoot: string,
  relativePath: string,
  target: string
): Promise<void> {
  await assertNoSymlinkParents(targetRoot, relativePath);
  const [canonicalRoot, canonicalParent] = await Promise.all([
    fs.realpath(targetRoot),
    fs.realpath(path.dirname(target))
  ]);
  const relativeParent = path.relative(canonicalRoot, canonicalParent);

  if (
    relativeParent === ".." ||
    relativeParent.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeParent)
  ) {
    throw new Error(`Update target parent escaped the Blueprint project: ${relativePath}`);
  }
}

async function assertTargetIsMissing(targetDir: string, relativePath: string): Promise<void> {
  const current = await getTargetFileState(targetDir, relativePath);

  if (current.type !== "missing") {
    throw new Error(`Managed target changed before the sync write completed: ${relativePath}`);
  }
}

async function assertUpdateTargetIsMissing(targetDir: string, relativePath: string): Promise<void> {
  const current = await getTargetFileState(targetDir, relativePath);

  if (current.type !== "missing") {
    throw new Error(`Managed path changed before the update write completed: ${relativePath}`);
  }
}

async function assertSyncRollbackWriteState(
  targetDir: string,
  operation: ExistingOperation
): Promise<void> {
  const current = await getTargetFileState(targetDir, operation.path);

  if (!isSyncRollbackWriteState(current, operation.desired)) {
    throw new Error(`Managed target changed before the sync rollback completed: ${operation.path}`);
  }
}

async function assertUpdateRollbackWriteState(
  targetDir: string,
  operation: ExistingOperation
): Promise<void> {
  const current = await getTargetFileState(targetDir, operation.path);

  if (!isSyncRollbackWriteState(current, operation.desired)) {
    throw new Error(`Managed path changed before the update rollback completed: ${operation.path}`);
  }
}

async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function targetPath(targetDir: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  return path.join(targetDir, ...normalized.split("/"));
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = path.posix.normalize(String(relativePath).replaceAll("\\", "/"));

  if (!isSafeRelativePath(normalized)) {
    throw new Error(`Unsafe Blueprint path: ${relativePath}`);
  }

  return normalized;
}

function isSafeRelativePath(relativePath: unknown): relativePath is string {
  return (
    typeof relativePath === "string" &&
    relativePath.length > 0 &&
    relativePath !== "." &&
    !relativePath.includes("\\") &&
    path.posix.normalize(relativePath) === relativePath &&
    !path.posix.isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !relativePath.includes("/../")
  );
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
}

function sanitizeSegment(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReplaceConflict(operation: ConflictOperation): operation is ConflictOperation & {
  desired: TemplateFile;
  operation: "replace";
} {
  return operation.operation === "replace" && operation.desired !== null;
}

export {
  CONTROL_DIR,
  MANAGED_ROOTS,
  MANIFEST_PATH,
  PACKAGE_NAME,
  adapterListFromMode,
  applyPreparedSync,
  applyPreparedUpdate,
  collectManagedTemplateFiles,
  createManifest,
  inspectGeneratedSkillHealth,
  prepareSync,
  prepareUpdate,
  readManifest,
  writeInstallManifest
};

export type {
  Adapter,
  AdapterMode,
  ApplySyncOptions,
  ApplyUpdateOptions,
  GeneratedSkillHealth,
  Manifest,
  PreparedSync,
  PreparedUpdate,
  SyncPackage,
  UpdateResult
};
