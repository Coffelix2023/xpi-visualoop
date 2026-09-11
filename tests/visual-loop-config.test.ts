import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HARNESS_MIGRATION_HINT,
  loadConfig,
  parseConfigText,
  validateEndpoint,
  validateLocalPageUrl,
} from "../src/visual-loop/config.ts";

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xpi-visual-loop-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("visual loop config validation", () => {
  it("rejects the removed backend path, unknown fields, and unsafe endpoints", () => {
    expect(() =>
      parseConfigText(
        '{"cdpUrl":"http://127.0.0.1:9333","harnessPath":"browser-harness"}',
        "test",
      ),
    ).toThrow("harnessPath has been removed");
    expect(() =>
      parseConfigText('{"cdpUrl":"http://127.0.0.1:9333","extra":true}', "test"),
    ).toThrow("unknown field");
    expect(() => validateEndpoint("http://example.invalid:9333")).toThrow("loopback");
    const userInfoUrl = new URL("http://127.0.0.1:9333");
    userInfoUrl.username = "operator";
    userInfoUrl.password = "placeholder";
    expect(() => validateEndpoint(userInfoUrl.toString())).toThrow("user information");
    expect(() => validateLocalPageUrl("file:///tmp/page.html")).toThrow(
      "http or https",
    );
    expect(() => validateLocalPageUrl("http://127.0.0.1.evil.example/page")).toThrow(
      "loopback",
    );
  });

  it("names the migration for the legacy backend path", () => {
    expect(HARNESS_MIGRATION_HINT).toContain("harnessPath has been removed");
    expect(HARNESS_MIGRATION_HINT).toContain("delete the harnessPath key");
  });

  it("fails closed on a legacy backend path in either configuration file", async () => {
    const agentDir = await tempDirectory();
    const cwd = await tempDirectory();
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(agentDir, "xpi-visualoop.json"),
      JSON.stringify({
        cdpUrl: "http://127.0.0.1:9333",
        harnessPath: "browser-harness",
      }),
    );

    const legacy = await loadConfig(agentDir, cwd, true);
    expect(legacy.config).toBeUndefined();
    expect(legacy.diagnostics.join(" ")).toContain("harnessPath has been removed");
  });

  it("uses the project file only after trust is established", async () => {
    const agentDir = await tempDirectory();
    const cwd = await tempDirectory();
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(agentDir, "xpi-visualoop.json"),
      JSON.stringify({
        cdpUrl: "http://127.0.0.1:9333",
      }),
    );
    await writeFile(
      join(cwd, ".pi", "xpi-visualoop.json"),
      JSON.stringify({
        cdpUrl: "http://127.0.0.1:9444",
      }),
    );

    const untrusted = await loadConfig(agentDir, cwd, false);
    expect(untrusted.config?.cdpUrl).toBe("http://127.0.0.1:9333/");
    expect(untrusted.diagnostics).toContain(
      "project configuration ignored because the project is untrusted",
    );

    const trusted = await loadConfig(agentDir, cwd, true);
    expect(trusted.config?.cdpUrl).toBe("http://127.0.0.1:9444/");
  });

  it("fails closed when required user configuration is absent", async () => {
    const agentDir = await tempDirectory();
    const cwd = await tempDirectory();
    const result = await loadConfig(agentDir, cwd, true);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics.join(" ")).toContain("not configured");
  });
});
