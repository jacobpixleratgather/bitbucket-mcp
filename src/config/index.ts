import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { StoredConfig, StoredTokens } from "../types.ts";

const storedTokensSchema: z.ZodType<StoredTokens> = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  scopes: z.array(z.string()),
});

const storedConfigSchema: z.ZodType<StoredConfig> = z.object({
  clientKey: z.string().optional(),
  clientSecret: z.string().optional(),
  tokens: storedTokensSchema.optional(),
});

/**
 * Returns the full path to the config file. Honors XDG_CONFIG_HOME if set,
 * else falls back to ~/.config/bitbucket-mcp/config.json.
 */
export function configPath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "bitbucket-mcp", "config.json");
}

/**
 * Reads the config from disk. Returns empty {} if the file does not exist.
 * Throws Error on JSON parse failure or schema mismatch with a clear message
 * pointing to the file path.
 */
export async function readConfig(): Promise<StoredConfig> {
  const p = configPath();
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`bitbucket-mcp: failed to parse config file at ${p}: ${msg}`);
  }
  const result = storedConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `bitbucket-mcp: config file at ${p} has invalid shape: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Deep-merges `partial` into existing config and writes atomically.
 * Ensures mode 0o600 on the file and 0o700 on the parent directory.
 * Does not clobber fields absent from `partial`.
 */
export async function writeConfig(partial: Partial<StoredConfig>): Promise<void> {
  const p = configPath();
  const dir = path.dirname(p);

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // On some platforms mkdir may not set mode when the dir already exists.
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Ignore chmod errors on non-POSIX filesystems.
  }

  const existing = await readConfig();
  const merged = mergeConfig(existing, partial);

  const serialized = `${JSON.stringify(merged, null, 2)}\n`;

  // Atomic write: write to a uniquely-named temp file in the same directory,
  // then rename. Rename is atomic on POSIX within a single filesystem.
  const tmp = path.join(dir, `.config.json.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
  // 0o600 on the temp file so the secret is never readable via an interim state.
  await fs.writeFile(tmp, serialized, { mode: 0o600 });
  try {
    await fs.chmod(tmp, 0o600);
  } catch {
    // Best effort on non-POSIX.
  }
  try {
    await fs.rename(tmp, p);
  } catch (err) {
    // Clean up the temp file if rename failed.
    try {
      await fs.unlink(tmp);
    } catch {
      // Ignore.
    }
    throw err;
  }
  // Ensure the final file has 0o600 (rename preserves source perms, but be
  // defensive in case umask or fs quirks altered it).
  try {
    await fs.chmod(p, 0o600);
  } catch {
    // Best effort.
  }
}

/** Removes the `tokens` field but keeps `clientKey` / `clientSecret`. */
export async function clearTokens(): Promise<void> {
  const existing = await readConfig();
  const next: StoredConfig = { ...existing };
  delete next.tokens;
  // Write the whole object without doing a merge (which would restore tokens).
  await writeWhole(next);
}

function mergeConfig(base: StoredConfig, patch: Partial<StoredConfig>): StoredConfig {
  const out: StoredConfig = { ...base };
  if (patch.clientKey !== undefined) {
    out.clientKey = patch.clientKey;
  }
  if (patch.clientSecret !== undefined) {
    out.clientSecret = patch.clientSecret;
  }
  if (patch.tokens !== undefined) {
    out.tokens = { ...base.tokens, ...patch.tokens } as StoredTokens;
  }
  return out;
}

async function writeWhole(value: StoredConfig): Promise<void> {
  const p = configPath();
  const dir = path.dirname(p);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Best effort.
  }
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = path.join(dir, `.config.json.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
  await fs.writeFile(tmp, serialized, { mode: 0o600 });
  try {
    await fs.chmod(tmp, 0o600);
  } catch {
    // Best effort.
  }
  try {
    await fs.rename(tmp, p);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // Ignore.
    }
    throw err;
  }
  try {
    await fs.chmod(p, 0o600);
  } catch {
    // Best effort.
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
