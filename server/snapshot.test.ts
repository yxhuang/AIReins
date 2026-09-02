import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SnapshotCwdError,
  SnapshotPathError,
  SnapshotSpaceError,
  assertSafeSnapshotDeletion,
  createSnapshotIfNeeded,
  preflightSnapshot,
  scanDirectory,
  snapshotPathFor,
} from "./snapshot.js";

const fixture = await mkdtemp(join(tmpdir(), "workbench-snapshot-test-"));

// Git 仓库的任意子目录都跳过扫描和复制。
const gitRepo = join(fixture, "git-repo");
const gitNested = join(gitRepo, "papers", "draft");
const gitSnapshots = join(fixture, "git-snapshots");
await mkdir(join(gitRepo, ".git"), { recursive: true });
await writeFile(join(gitRepo, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
await mkdir(gitNested, { recursive: true });
let gitCopyCalls = 0;
const gitPreflight = await preflightSnapshot(gitNested, {
  snapshotRoot: gitSnapshots,
  getFreeBytes: async () => {
    throw new Error("git 目录不应查询空间");
  },
});
assert.deepEqual(gitPreflight, {
  isGit: true,
  needed: false,
  exceeds: false,
  existing: false,
  freeSpaceOk: false,
  snapshotPath: null,
});
assert.equal(await createSnapshotIfNeeded(gitNested, {
  snapshotRoot: gitSnapshots,
  copyDirectory: async () => {
    gitCopyCalls += 1;
  },
}), null);
assert.equal(gitCopyCalls, 0);

// 非 git 目录会生成稳定、可辨认且不碰撞的全量副本（不是硬链接）。
const plainCwd = join(fixture, "plain-work");
const plainSnapshots = join(fixture, "plain-snapshots");
await mkdir(plainCwd, { recursive: true });
await writeFile(join(plainCwd, "draft.txt"), "version one", "utf8");
const plainPath = await createSnapshotIfNeeded(plainCwd, {
  snapshotRoot: plainSnapshots,
  getFreeBytes: async () => Number.MAX_SAFE_INTEGER,
});
assert.equal(plainPath, snapshotPathFor(plainCwd, plainSnapshots));
assert.equal(await readFile(join(plainPath!, "draft.txt"), "utf8"), "version one");
assert.notEqual((await stat(join(plainCwd, "draft.txt"))).ino, (await stat(join(plainPath!, "draft.txt"))).ino);
assert.equal(snapshotPathFor(plainCwd, plainSnapshots), snapshotPathFor(plainCwd, plainSnapshots));
assert.notEqual(
  snapshotPathFor(join(fixture, "one", "same-name"), plainSnapshots),
  snapshotPathFor(join(fixture, "two", "same-name"), plainSnapshots),
);
await writeFile(join(plainCwd, "draft.txt"), "version two", "utf8");
assert.equal(await createSnapshotIfNeeded(plainCwd, {
  snapshotRoot: plainSnapshots,
  getFreeBytes: async () => Number.MAX_SAFE_INTEGER,
}), plainPath);
assert.equal(await readFile(join(plainPath!, "draft.txt"), "utf8"), "version two");
await assert.rejects(stat(`${plainPath}.tmp`), { code: "ENOENT" });
await assert.rejects(stat(`${plainPath}.old`), { code: "ENOENT" });
const existingPreflight = await preflightSnapshot(plainCwd, {
  snapshotRoot: plainSnapshots,
  getFreeBytes: async () => Number.MAX_SAFE_INTEGER,
});
assert.equal(existingPreflight.existing, true);
assert.equal(existingPreflight.freeSpaceOk, true);
await assert.rejects(preflightSnapshot("relative/path"), SnapshotCwdError);
await assert.rejects(preflightSnapshot(join(fixture, "missing-workdir")), SnapshotCwdError);
await assert.rejects(preflightSnapshot(join(plainCwd, "draft.txt")), SnapshotCwdError);

// 撞到阈值后必须立即退出，不能继续遍历整个目录。
const oversized = join(fixture, "oversized");
await mkdir(oversized, { recursive: true });
await Promise.all(Array.from({ length: 200 }, (_, index) => (
  writeFile(join(oversized, `file-${String(index).padStart(3, "0")}.txt`), "x", "utf8")
)));
const earlyExit = await scanDirectory(oversized, { maxBytes: 1024, maxFiles: 5 });
assert.equal(earlyExit.exceeds, true);
assert.equal(earlyExit.fileCount, 6);
assert.ok(earlyExit.fileCount < 200 / 10, `实际遍历了 ${earlyExit.fileCount} 个文件，未足够早退出`);
const earlySizeExit = await scanDirectory(oversized, { maxBytes: 1, maxFiles: 1_000 });
assert.equal(earlySizeExit.exceeds, true);
assert.equal(earlySizeExit.fileCount, 2);

// 原子替换的第二次 rename 失败时，旧快照必须回到原路径且内容不变。
const atomicCwd = join(fixture, "atomic-work");
const atomicRoot = join(fixture, "atomic-snapshots");
const atomicTarget = snapshotPathFor(atomicCwd, atomicRoot);
await mkdir(atomicCwd, { recursive: true });
await writeFile(join(atomicCwd, "state.txt"), "new", "utf8");
await mkdir(atomicTarget, { recursive: true });
await writeFile(join(atomicTarget, "state.txt"), "old", "utf8");
let injectedRenameFailure = false;
await assert.rejects(
  createSnapshotIfNeeded(atomicCwd, {
    snapshotRoot: atomicRoot,
    getFreeBytes: async () => Number.MAX_SAFE_INTEGER,
    renamePath: async (source, destination) => {
      if (!injectedRenameFailure && source === `${atomicTarget}.tmp` && destination === atomicTarget) {
        injectedRenameFailure = true;
        throw new Error("injected rename failure");
      }
      await rename(source, destination);
    },
  }),
  /injected rename failure/,
);
assert.equal(await readFile(join(atomicTarget, "state.txt"), "utf8"), "old");
await assert.rejects(stat(`${atomicTarget}.tmp`), { code: "ENOENT" });
await assert.rejects(stat(`${atomicTarget}.old`), { code: "ENOENT" });

// 删除守卫：正常直属目录通过；穿越、符号链接逃逸和根目录本身全部拒绝。
const guardRoot = join(fixture, "guard-snapshots");
const guardOwned = join(guardRoot, "owned-dir");
const guardOutside = join(fixture, "guard-outside");
await mkdir(guardOwned, { recursive: true });
await mkdir(guardOutside, { recursive: true });
await assert.doesNotReject(assertSafeSnapshotDeletion(guardOwned, guardRoot));
await assert.rejects(
  assertSafeSnapshotDeletion(join(guardRoot, "..", "guard-outside"), guardRoot),
  SnapshotPathError,
);
const escapingLink = join(guardRoot, "escaping-link");
await symlink(guardOutside, escapingLink, "dir");
await assert.rejects(assertSafeSnapshotDeletion(escapingLink, guardRoot), SnapshotPathError);
await assert.rejects(assertSafeSnapshotDeletion(guardRoot, guardRoot), SnapshotPathError);

// 同一 cwd 的并发请求复用同一个进行中 Promise，只执行一次复制。
const concurrentCwd = join(fixture, "concurrent-work");
const concurrentRoot = join(fixture, "concurrent-snapshots");
await mkdir(concurrentCwd, { recursive: true });
await writeFile(join(concurrentCwd, "data.txt"), "concurrent", "utf8");
let concurrentCopies = 0;
let releaseCopy!: () => void;
let markCopyStarted!: () => void;
const copyGate = new Promise<void>((resolveGate) => { releaseCopy = resolveGate; });
const copyStarted = new Promise<void>((resolveStarted) => { markCopyStarted = resolveStarted; });
const concurrentOptions = {
  snapshotRoot: concurrentRoot,
  getFreeBytes: async () => Number.MAX_SAFE_INTEGER,
  copyDirectory: async (source: string, destination: string) => {
    concurrentCopies += 1;
    markCopyStarted();
    await copyGate;
    await cp(source, destination, { recursive: true });
  },
};
const concurrentFirst = createSnapshotIfNeeded(concurrentCwd, concurrentOptions);
await copyStarted;
const concurrentSecond = createSnapshotIfNeeded(concurrentCwd, concurrentOptions);
await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
assert.equal(concurrentCopies, 1);
releaseCopy();
const [firstPath, secondPath] = await Promise.all([concurrentFirst, concurrentSecond]);
assert.equal(firstPath, secondPath);
assert.equal(concurrentCopies, 1);

// 空间不足必须在 copy 之前失败。
const noSpaceCwd = join(fixture, "no-space-work");
const noSpaceRoot = join(fixture, "no-space-snapshots");
await mkdir(noSpaceCwd, { recursive: true });
await writeFile(join(noSpaceCwd, "large-enough.txt"), "requires some space", "utf8");
let noSpaceCopyCalls = 0;
await assert.rejects(
  createSnapshotIfNeeded(noSpaceCwd, {
    snapshotRoot: noSpaceRoot,
    getFreeBytes: async () => 0,
    copyDirectory: async () => {
      noSpaceCopyCalls += 1;
    },
  }),
  SnapshotSpaceError,
);
assert.equal(noSpaceCopyCalls, 0);

console.log(JSON.stringify({
  fixture,
  gitSkipped: true,
  earlyExitVisitedFiles: earlyExit.fileCount,
  atomicRollbackPreserved: true,
  guardCases: 4,
  concurrentCopies,
  noSpaceCopyCalls,
}));
