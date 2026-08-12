// 服务端打包：esbuild 将 src/server 打成单文件，better-sqlite3 保持外部依赖
import { buildSync } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";

function copyDirectory(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = `${source}/${entry.name}`;
    const destinationPath = `${destination}/${entry.name}`;
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) copyFileSync(sourcePath, destinationPath);
    else throw new Error(`构建资源包含不支持的文件类型：${sourcePath}`);
  }
}

for (const directory of ["dist/server", "dist/migrations", "dist/seeds"]) {
  rmSync(directory, { recursive: true, force: true });
}
mkdirSync("dist/server", { recursive: true });

buildSync({
  entryPoints: {
    index: "src/server/index.ts",
    "scheduler-worker": "src/server/scheduler-worker.ts",
  },
  outdir: "dist/server",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["better-sqlite3"],
  banner: {
    // esm 下补齐 require（部分依赖在 node 平台会引用）
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

// 迁移文件与来源种子随构建产物分发
mkdirSync("dist/migrations", { recursive: true });
copyDirectory("migrations", "dist/migrations");
copyDirectory("seeds", "dist/seeds");
console.log("服务端构建完成: dist/server/index.mjs, dist/server/scheduler-worker.mjs");
