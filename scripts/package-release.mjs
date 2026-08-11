import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
const defaultReleaseId = new Date().toISOString().replace(/[-:.]/g, "");
const releaseId = (process.env.RELEASE_ID || defaultReleaseId).trim();
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)) {
  throw new Error("RELEASE_ID 只能包含字母、数字、点、下划线和连字符");
}

const stage = resolve(root, `.release-stage-${process.pid}`);
const archive = resolve(root, "..", `${manifest.name}-release-${manifest.version}-${releaseId}.tgz`);
const archiveTemp = `${archive}.${process.pid}.tmp`;
const checksum = `${archive}.sha256`;
const checksumTemp = `${checksum}.${process.pid}.tmp`;
const entries = [
  "package-lock.json",
  "dist/client",
  "dist/server",
  "dist/migrations",
  "dist/seeds",
  "migrations",
  "seeds",
  "deploy",
  "README.md",
];
const requiredReleaseFiles = [
  "package.json",
  "package-lock.json",
  "dist/server/index.mjs",
  "dist/server/scheduler-worker.mjs",
  "dist/client/index.html",
  "dist/client/sw.js",
  "dist/client/assets/index-B2Eg34rp.js",
  "dist/client/assets/index-b0lJDpbs.css",
  "deploy/preserve-hashed-assets.sh",
  "migrations/0000_tiny_nightcrawler.sql",
  "migrations/0001_massive_george_stacy.sql",
  "migrations/0002_careful_the_santerians.sql",
  "migrations/0003_flawless_blacklash.sql",
  "migrations/meta/_journal.json",
  "dist/migrations/0000_tiny_nightcrawler.sql",
  "dist/migrations/0001_massive_george_stacy.sql",
  "dist/migrations/0002_careful_the_santerians.sql",
  "dist/migrations/0003_flawless_blacklash.sql",
  "dist/migrations/meta/_journal.json",
  "deploy/install.sh",
  "deploy/nginx-news",
  "deploy/news-radar.service",
  "deploy/news-radar-scheduler.service",
  "deploy/news-radar-certwatch.sh",
  "deploy/news-radar-certwatch.service",
  "deploy/news-radar-certwatch.timer",
];

function stagedFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...stagedFiles(absolute));
    else files.push(relative(stage, absolute).replaceAll("\\", "/"));
  }
  return files;
}

try {
  rmSync(stage, { recursive: true, force: true });
  rmSync(archiveTemp, { force: true });
  rmSync(checksumTemp, { force: true });
  mkdirSync(stage, { recursive: true });

  for (const name of Object.keys(manifest.scripts || {})) {
    if (name.startsWith("tmp:ssh:")) delete manifest.scripts[name];
  }
  writeFileSync(resolve(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const entry of entries) {
    const source = resolve(root, entry);
    const destination = resolve(stage, entry);
    if (!existsSync(source)) throw new Error(`发布源缺少必需路径：${entry}`);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  for (const required of requiredReleaseFiles) {
    if (!existsSync(resolve(stage, required))) throw new Error(`发布暂存区缺少必需文件：${required}`);
  }
  const forbidden = stagedFiles(stage).filter((file) =>
    /(^|\/)(?:\.env(?:\.|$)|\.run-data(?:\/|$)|data-smoke(?:\/|$))/i.test(file)
    || /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i.test(file)
    || /\.(?:pem|key|p12|pfx)$/i.test(file)
  );
  if (forbidden.length) throw new Error(`发布暂存区包含敏感或运行时文件：${forbidden.join(", ")}`);

  const result = spawnSync("tar", ["-czf", archiveTemp, "-C", stage, "."], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`tar 被信号 ${result.signal} 终止`);
  if (result.status !== 0) throw new Error(`tar 退出码：${result.status}`);

  const digest = createHash("sha256").update(readFileSync(archiveTemp)).digest("hex");
  writeFileSync(checksumTemp, `${digest}  ${basename(archive)}\n`);
  renameSync(archiveTemp, archive);
  renameSync(checksumTemp, checksum);
} finally {
  rmSync(stage, { recursive: true, force: true });
  rmSync(archiveTemp, { force: true });
  rmSync(checksumTemp, { force: true });
}
console.log(`发布包已生成：${archive}`);
console.log(`校验文件已生成：${checksum}`);
