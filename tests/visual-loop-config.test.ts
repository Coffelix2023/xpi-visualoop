import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CDP_URL } from "../src/visual-loop/chrome.ts";
import {
  HARNESS_MIGRATION_HINT,
  loadConfig,
  parseConfigText,
  resolveCdpWebSocketUrl,
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

  it("falls back to the documented default endpoint when no configuration exists", async () => {
    const agentDir = await tempDirectory();
    const cwd = await tempDirectory();
    const result = await loadConfig(agentDir, cwd, true);
    expect(result.config?.cdpUrl).toBe(DEFAULT_CDP_URL);
    expect(result.diagnostics.join(" ")).toContain("default CDP endpoint");
  });

  it("still fails closed when a configuration file is present but unusable", async () => {
    const agentDir = await tempDirectory();
    const cwd = await tempDirectory();
    await writeFile(join(agentDir, "xpi-visualoop.json"), "{ not json");
    const result = await loadConfig(agentDir, cwd, true);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics.join(" ")).toContain("not valid JSON");
  });
});

describe("CDP endpoint discovery deadline", () => {
  it("gives up when the endpoint accepts and never answers", async () => {
    // An endpoint that completes the TCP handshake and then stays silent is
    // what wedged visual_prepare; discovery must own a deadline of its own.
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("silent endpoint has no port");
    try {
      await expect(
        resolveCdpWebSocketUrl(`http://127.0.0.1:${address.port}/`, undefined, 100),
      ).rejects.toThrow("did not answer within 100 ms");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
