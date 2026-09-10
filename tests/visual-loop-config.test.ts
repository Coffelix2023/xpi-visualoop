import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
  it("rejects unknown fields and unsafe endpoints", () => {
    expect(() =>
      parseConfigText(
        '{"cdpUrl":"http://127.0.0.1:9333","harnessPath":"browser-harness","extra":true}',
        "test",
      ),
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

  it("uses the project file only after trust is established", async () => {
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
    await writeFile(
      join(cwd, ".pi", "xpi-visualoop.json"),
      JSON.stringify({
        cdpUrl: "http://127.0.0.1:9444",
        harnessPath: "project-harness",
      }),
    );

    const untrusted = await loadConfig(agentDir, cwd, false);
    expect(untrusted.config?.cdpUrl).toBe("http://127.0.0.1:9333/");
    expect(untrusted.config?.harnessPath).toBe("browser-harness");
    expect(untrusted.diagnostics).toContain(
      "project configuration ignored because the project is untrusted",
    );

    const trusted = await loadConfig(agentDir, cwd, true);
    expect(trusted.config?.cdpUrl).toBe("http://127.0.0.1:9444/");
    expect(trusted.config?.harnessPath).toBe("project-harness");
  });

  it("fails closed when required user configuration is absent", async () => {
    const agentDir = await tempDirectory();
    const cwd = await tempDirectory();
    const result = await loadConfig(agentDir, cwd, true);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics.join(" ")).toContain("not configured");
  });
});
