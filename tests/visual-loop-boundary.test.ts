import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VisualLoopManager } from "../src/visual-loop/context.ts";

const SRC_ROOT = new URL("../src", import.meta.url).pathname;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {
    withFileTypes: true,
  });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : Promise.resolve(
            path.endsWith(".ts")
              ? [
                  path,
                ]
              : [],
          );
    }),
  );
  return files.flat();
}

/** The only CDP methods the four read-only actions may send. */
const ALLOWED_CDP_METHODS = new Set([
  "Emulation.setDeviceMetricsOverride",
  "Log.enable",
  "Network.enable",
  "Page.captureScreenshot",
  "Page.navigate",
  "Runtime.enable",
  "Runtime.evaluate",
  "Target.attachToTarget",
  "Target.closeTarget",
  "Target.createTarget",
  "Target.detachFromTarget",
  "Target.getTargetInfo",
]);

/** The exact tool surface the extension registers. */
const EXPECTED_TOOL_NAMES = new Set([
  "visual_capture",
  "visual_feedback",
  "visual_prepare",
  "visual_verify",
]);

/** Methods that would break the read-only boundary if they appeared. */
/** Dynamic execution is forbidden everywhere in the source tree. */
const NO_DYNAMIC_EXEC = /worker_threads|\bvm\./;
const NO_EVAL = /\beval\(|new Function|runInThisContext/;
/** Spawning a process is allowed in exactly one module; see the test below. */
const NO_SPAWN = /child_process/;
const SPAWN_OWNER = "chrome.ts";
const FORBIDDEN_MANAGER_METHOD =
  /click|input|type|navigate|eval|exec|script|key|scroll/i;

describe("read-only boundary", () => {
  it("exposes exactly the four-action manager surface", () => {
    const methods = Object.getOwnPropertyNames(VisualLoopManager.prototype).filter(
      (name) => name !== "constructor",
    );
    for (const name of methods) {
      expect(name, `manager method must not imply page control: ${name}`).not.toMatch(
        FORBIDDEN_MANAGER_METHOD,
      );
    }
    for (const required of [
      "prepare",
      "capture",
      "verify",
      "addFeedback",
      "disconnect",
    ]) {
      expect(methods, `missing read-only action: ${required}`).toContain(required);
    }
  });

  it("registers exactly the four read-only tools", async () => {
    const [entry] = await sourceFiles(SRC_ROOT).then((files) =>
      files.filter((file) => file.endsWith("/index.ts")),
    );
    const text = await readFile(entry, "utf8");
    const names = [
      ...text.matchAll(/name:\s*"([a-z_]+)"/g),
    ].map((match) => match[1] ?? "");
    const tools = names.filter((name) => name.startsWith("visual_"));
    expect(new Set(tools)).toEqual(EXPECTED_TOOL_NAMES);
    expect(tools).toHaveLength(EXPECTED_TOOL_NAMES.size);
  });

  it("sends only whitelisted CDP methods and never input or evaluation APIs", async () => {
    const texts = await Promise.all(
      (await sourceFiles(SRC_ROOT)).map((file) => readFile(file, "utf8")),
    );
    const sent = new Set<string>();
    for (const text of texts) {
      for (const match of text.matchAll(/\.send\(\s*"([A-Za-z]+\.[A-Za-z]+)"/g)) {
        sent.add(match[1] ?? "");
      }
    }
    expect(sent.size).toBeGreaterThan(0);
    const sentList = Array.from(sent).sort();
    const allowedList = Array.from(ALLOWED_CDP_METHODS).sort();
    expect(sentList).toEqual(allowedList);
    expect(sentList.some((method) => method.startsWith("Input."))).toBe(false);
  });

  it("keeps page evaluation out of every module and spawning inside the browser launcher", async () => {
    const files = await sourceFiles(SRC_ROOT);
    const evaluateFiles: string[] = [];
    const spawnFiles: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (text.includes("Runtime.evaluate")) evaluateFiles.push(file);
      if (NO_SPAWN.test(text)) spawnFiles.push(file);
      expect(text).not.toMatch(NO_DYNAMIC_EXEC);
      expect(text).not.toMatch(NO_EVAL);
    }
    // Fixed read-only scripts only; exactly one source file evaluates pages.
    expect(evaluateFiles).toHaveLength(1);
    // The extension starts its own browser from one module and nowhere else,
    // so the launch path stays auditable.
    expect(spawnFiles.map((file) => file.split("/").pop())).toEqual([
      SPAWN_OWNER,
    ]);
  });
});
