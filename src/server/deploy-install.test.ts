import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const helperPath = resolve(root, "deploy", "preserve-hashed-assets.sh");
const installSource = readFileSync(resolve(root, "deploy", "install.sh"), "utf8");
const schedulerUnitSource = readFileSync(resolve(root, "deploy", "news-radar-scheduler.service"), "utf8");
const packageSource = readFileSync(resolve(root, "scripts", "package-release.mjs"), "utf8");
const viteSource = readFileSync(resolve(root, "vite.config.ts"), "utf8");
const resetPath = resolve(root, "deploy", "reset-news-data.sh");
const resetSource = readFileSync(resetPath, "utf8");

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function linuxPath(value: string) {
  if (process.platform !== "win32") return value;
  const normalized = value.replaceAll("\\", "/");
  const drivePath = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!drivePath) throw new Error(`无法转换为 WSL 路径：${value}`);
  return `/mnt/${drivePath[1].toLowerCase()}/${drivePath[2]}`;
}

function runBash(script: string) {
  return process.platform === "win32"
    ? spawnSync("wsl.exe", ["bash", "-s"], { encoding: "utf8", input: script })
    : spawnSync("bash", ["-s"], { encoding: "utf8", input: script });
}

const bashAvailable = runBash("command -v bash >/dev/null 2>&1").status === 0;

describe("release installer static asset compatibility", () => {
  it("guards the recoverable news-data reset and preserves user configuration tables", () => {
    expect(resetSource).toContain('CONFIRMATION="${1:-}"');
    expect(resetSource).toContain('"--confirm-reset"');
    expect(resetSource).toContain(".backup '$backup'");
    expect(resetSource).toContain('sha256sum "$backup"');
    expect(resetSource).toContain("BEGIN IMMEDIATE;");
    expect(resetSource).toContain("DELETE FROM briefings;");
    expect(resetSource).toContain("DELETE FROM workflow_cases;");
    expect(resetSource).not.toContain("DELETE FROM sources;");
    expect(resetSource).not.toContain("DELETE FROM watchlists;");
    expect(resetSource).not.toContain("DELETE FROM push_subs;");
    expect(resetSource).toContain("systemctl stop news-radar-scheduler.service");
    expect(resetSource).toContain("systemctl start news-radar-scheduler.service");
    expect(resetSource).toContain('! -d "$BACKUP_ROOT"');
    expect(resetSource).toContain('拒绝覆盖已有备份');

    if (bashAvailable) {
      const result = runBash(`bash -n ${shellQuote(linuxPath(resetPath))}`);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }
  });

  it("requires and invokes the preservation helper before activating the release", () => {
    expect(installSource).toContain("deploy/preserve-hashed-assets.sh");
    expect(packageSource).toContain('"deploy/preserve-hashed-assets.sh"');
    for (const legacyAsset of ["assets/index-B2Eg34rp.js", "assets/index-b0lJDpbs.css"]) {
      expect(viteSource).toContain(legacyAsset);
      expect(installSource).toContain(`dist/client/${legacyAsset}`);
      expect(packageSource).toContain(`"dist/client/${legacyAsset}"`);
    }
    for (const migration of ["migrations/0003_flawless_blacklash.sql", "dist/migrations/0003_flawless_blacklash.sql"]) {
      expect(installSource).toContain(migration);
      expect(packageSource).toContain(`"${migration}"`);
    }
    for (const schedulerFile of ["dist/server/scheduler-worker.mjs", "deploy/news-radar-scheduler.service"]) {
      expect(installSource).toContain(schedulerFile);
      expect(packageSource).toContain(`"${schedulerFile}"`);
    }
    expect(installSource).toContain("systemctl enable news-radar-scheduler.service");
    expect(installSource).toContain("systemctl restart news-radar-scheduler.service");
    expect(installSource).toContain("systemctl set-property --runtime news-radar-scheduler.service CPUWeight=1000 IOWeight=100");
    expect(installSource).toContain("http://127.0.0.1:8787/api/ready");
    expect(installSource).toContain("json_extract(v, '$.instanceId')");
    expect(installSource).toContain('"$scheduler_instance" == "$observed_scheduler_instance"');
    expect(installSource).toContain("News Radar 调度进程未产生连续心跳");
    expect(installSource).toContain('cmp -s "$OLD_CURRENT/package-lock.json" "$RELEASE_DIR/package-lock.json"');
    expect(installSource).toContain('cp -al -- "$OLD_CURRENT/node_modules" "$RELEASE_DIR/node_modules"');
    expect(schedulerUnitSource).toContain("Nice=5");
    expect(schedulerUnitSource).toContain("CPUWeight=1000");
    expect(schedulerUnitSource).toContain("IOWeight=100");
    expect(schedulerUnitSource).toContain("IOSchedulingClass=best-effort");
    expect(schedulerUnitSource).toContain("IOSchedulingPriority=7");
    expect(schedulerUnitSource).not.toContain("IOSchedulingClass=idle");

    const sourceIndex = installSource.indexOf('source "$RELEASE_DIR/deploy/preserve-hashed-assets.sh"');
    const preserveIndex = installSource.indexOf('preserve_hashed_assets "$RELEASES_ROOT" "$RELEASE_DIR"');
    const ownershipIndex = installSource.indexOf('chown -R ubuntu:ubuntu "$RELEASE_DIR"');
    const activationIndex = installSource.indexOf('ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"');

    expect(sourceIndex).toBeGreaterThan(-1);
    expect(preserveIndex).toBeGreaterThan(sourceIndex);
    expect(preserveIndex).toBeLessThan(ownershipIndex);
    expect(preserveIndex).toBeLessThan(activationIndex);
  });

  it.skipIf(!bashAvailable)("preserves only regular hashed JS/CSS files without clobbering", () => {
    const helper = shellQuote(linuxPath(helperPath));
    const result = runBash(`
      set -Eeuo pipefail
      source ${helper}

      fixture="$(mktemp -d)"
      trap 'rm -rf -- "$fixture"' EXIT
      releases="$fixture/releases"
      old_one="$releases/20260101T000000Z"
      old_two="$releases/20260201T000000Z"
      linked_source="$fixture/linked-source"
      linked_assets="$fixture/linked-assets"
      target="$releases/20260301T000000Z"
      outside="$fixture/outside.js"

      mkdir -p "$old_one/dist/client/assets/nested" \
        "$old_two/dist/client/assets" \
        "$linked_source/dist/client/assets" \
        "$linked_assets" \
        "$target/dist/client/assets"

      printf current-js > "$target/dist/client/assets/index-B2Eg34rp.js"
      printf legacy-js > "$old_one/dist/client/assets/index-B2Eg34rp.js"
      printf legacy-css > "$old_one/dist/client/assets/index-b0lJDpbs.css"
      printf vendor-js > "$old_two/dist/client/assets/vendor-D9vGD2o_.js"
      printf invalid > "$old_one/dist/client/assets/plain.js"
      printf invalid > "$old_one/dist/client/assets/index-short.js"
      printf invalid > "$old_one/dist/client/assets/index-ABCDEFGH.map"
      printf invalid > "$old_one/dist/client/assets/index-ABCDEFGH.JS"
      printf nested > "$old_one/dist/client/assets/nested/nested-ABCDEFGH.js"
      mkdir "$old_one/dist/client/assets/directory-ABCDEFGH.js"

      printf linked-file > "$outside"
      ln -s "$outside" "$old_one/dist/client/assets/symlink-ABCDEFGH.js"
      printf linked-release > "$linked_source/dist/client/assets/linked-ABCDEFGH.js"
      ln -s "$linked_source" "$releases/linked-release"
      printf linked-assets > "$linked_assets/assets-ABCDEFGH.css"
      mkdir -p "$releases/linked-assets-release/dist/client"
      ln -s "$linked_assets" "$releases/linked-assets-release/dist/client/assets"
      ln -s "$outside" "$target/dist/client/assets/blocked-ABCDEFGH.js"
      printf blocked-source > "$old_two/dist/client/assets/blocked-ABCDEFGH.js"

      preserve_hashed_assets "$releases" "$target"

      [[ "$(cat "$target/dist/client/assets/index-B2Eg34rp.js")" == current-js ]]
      [[ "$(cat "$target/dist/client/assets/index-b0lJDpbs.css")" == legacy-css ]]
      [[ "$(cat "$target/dist/client/assets/vendor-D9vGD2o_.js")" == vendor-js ]]
      [[ "$(cat "$outside")" == linked-file ]]
      [[ "$(stat -c '%a' "$target/dist/client/assets/index-b0lJDpbs.css")" == 644 ]]
      [[ ! -e "$target/dist/client/assets/plain.js" ]]
      [[ ! -L "$target/dist/client/assets/plain.js" ]]
      [[ ! -e "$target/dist/client/assets/index-short.js" ]]
      [[ ! -L "$target/dist/client/assets/index-short.js" ]]
      [[ ! -e "$target/dist/client/assets/index-ABCDEFGH.map" ]]
      [[ ! -L "$target/dist/client/assets/index-ABCDEFGH.map" ]]
      [[ ! -e "$target/dist/client/assets/index-ABCDEFGH.JS" ]]
      [[ ! -L "$target/dist/client/assets/index-ABCDEFGH.JS" ]]
      [[ ! -e "$target/dist/client/assets/nested-ABCDEFGH.js" ]]
      [[ ! -L "$target/dist/client/assets/nested-ABCDEFGH.js" ]]
      [[ ! -e "$target/dist/client/assets/directory-ABCDEFGH.js" ]]
      [[ ! -L "$target/dist/client/assets/directory-ABCDEFGH.js" ]]
      [[ ! -e "$target/dist/client/assets/symlink-ABCDEFGH.js" ]]
      [[ ! -L "$target/dist/client/assets/symlink-ABCDEFGH.js" ]]
      [[ ! -e "$target/dist/client/assets/linked-ABCDEFGH.js" ]]
      [[ ! -L "$target/dist/client/assets/linked-ABCDEFGH.js" ]]
      [[ ! -e "$target/dist/client/assets/assets-ABCDEFGH.css" ]]
      [[ ! -L "$target/dist/client/assets/assets-ABCDEFGH.css" ]]

      printf changed-css > "$old_one/dist/client/assets/index-b0lJDpbs.css"
      preserve_hashed_assets "$releases" "$target"
      [[ "$(cat "$target/dist/client/assets/index-b0lJDpbs.css")" == legacy-css ]]

      bad_target="$releases/bad-target"
      mkdir -p "$bad_target/dist/client"
      ln -s "$linked_assets" "$bad_target/dist/client/assets"
      if preserve_hashed_assets "$releases" "$bad_target"; then
        echo "helper accepted a symlinked target assets directory" >&2
        exit 1
      fi

      outside_target="$fixture/outside-target"
      mkdir -p "$outside_target/dist/client/assets"
      if preserve_hashed_assets "$releases" "$outside_target"; then
        echo "helper accepted a target outside releases root" >&2
        exit 1
      fi

      failure_root="$fixture/failure-releases"
      failure_source="$failure_root/source"
      failure_target="$failure_root/target"
      mkdir -p "$failure_source/dist/client/assets" "$failure_target/dist/client/assets"
      printf failure > "$failure_source/dist/client/assets/failure-ABCDEFGH.js"

      assert_no_temporary_files() {
        if compgen -G "$failure_target/dist/client/assets/.preserve-asset.*" >/dev/null; then
          echo "helper left a temporary asset behind" >&2
          exit 1
        fi
      }

      mktemp() { return 1; }
      if preserve_hashed_assets "$failure_root" "$failure_target"; then exit 1; fi
      unset -f mktemp
      assert_no_temporary_files

      cp() { return 1; }
      if preserve_hashed_assets "$failure_root" "$failure_target"; then exit 1; fi
      unset -f cp
      assert_no_temporary_files

      chmod() { return 1; }
      if preserve_hashed_assets "$failure_root" "$failure_target"; then exit 1; fi
      unset -f chmod
      assert_no_temporary_files

      mv() { return 1; }
      if preserve_hashed_assets "$failure_root" "$failure_target"; then exit 1; fi
      unset -f mv
      assert_no_temporary_files
    `);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
