import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot, toolchainDir } from "./adapters/depcruiser.ts";

export const DEP_CRUISER_SPEC = "dependency-cruiser@18.7.0";
export const MARKER_NAME = ".bootstrap-in-progress";
export const LOCK_NAME = "toolchain.lock.json";

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function listTmpDirs(root: string): string[] {
  return readdirSync(root).filter((e) => e.startsWith("toolchain.tmp-")).map((e) => join(root, e));
}

/** Уборка после прерванного bootstrap: tmp-каталоги, битый toolchain без lock, маркер. */
export function sweepInterrupted(root: string, toolchain: string, marker: string): void {
  const hadMarker = existsSync(marker);
  for (const tmp of listTmpDirs(root)) rmSync(tmp, { recursive: true, force: true });
  if (hadMarker && existsSync(toolchain) && !existsSync(join(toolchain, LOCK_NAME))) {
    rmSync(toolchain, { recursive: true, force: true });
  }
  if (hadMarker) rmSync(marker, { force: true });
}

export function runNpmInstall(prefix: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const cmdline = `npm install --prefix "${prefix}" ${DEP_CRUISER_SPEC}`;
    // npm на Windows — npm.cmd (.cmd без shell не запускается); одна строка команды — без DEP0190.
    const child = spawn(cmdline, { shell: true, windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8000) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        child.kill();
      } catch {
        /* уже завершился */
      }
    }, 600_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`npm install failed: ${String(err)}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`npm install failed (exit ${code}):\n${stderr.slice(-4000)}`));
      }
    });
  });
}

/**
 * Атомарная установка toolchain:
 * tmp `toolchain.tmp-<pid>` → npm install --prefix → toolchain.lock.json → rename tmp→toolchain.
 * Повторный запуск идемпотентен; прерванный не оставляет toolchain без lock.
 */
export async function bootstrap(root = packageRoot()): Promise<number> {
  const toolchain = toolchainDir(root);
  const marker = join(root, MARKER_NAME);
  const lockPath = join(toolchain, LOCK_NAME);

  sweepInterrupted(root, toolchain, marker);

  if (existsSync(lockPath)) {
    const nodeModules = join(toolchain, "node_modules", "dependency-cruiser");
    if (existsSync(nodeModules)) {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { version?: string };
      console.log(`bootstrap: already installed (idempotent), dependency-cruiser ${lock.version ?? "?"} at ${toolchain}`);
      return 0;
    }
    // lock есть, а пакета нет — битое состояние, переустанавливаем
    rmSync(toolchain, { recursive: true, force: true });
  }

  const tmp = join(root, `toolchain.tmp-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(marker, new Date().toISOString(), "utf8");

  try {
    console.log(`bootstrap: npm install --prefix ${tmp} ${DEP_CRUISER_SPEC}`);
    await runNpmInstall(tmp);

    const pkgLock = join(tmp, "package-lock.json");
    const lock = {
      package: "dependency-cruiser",
      version: "18.7.0",
      installedAt: new Date().toISOString(),
      packageLockSha256: existsSync(pkgLock) ? sha256File(pkgLock) : null,
    };
    writeFileSync(join(tmp, LOCK_NAME), JSON.stringify(lock, null, 2) + "\n", "utf8");

    if (existsSync(toolchain)) rmSync(toolchain, { recursive: true, force: true });
    // Атомарное переименование tmp → toolchain: toolchain появляется только целиком, с lock.
    // Маркер снимается ПОСЛЕ rename: падение до rename → на старте маркер+tmp убираются,
    // падение после rename → toolchain c lock остаётся, маркер снимается при следующем запуске.
    renameSync(tmp, toolchain);
    rmSync(marker, { force: true });
    console.log(`bootstrap: ok, toolchain at ${toolchain}, lock written`);
    return 0;
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(marker, { force: true });
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
