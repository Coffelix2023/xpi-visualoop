import { describe, expect, it } from "vitest";
import { VisualLoopManager } from "../src/visual-loop/context.ts";

const root = process.env.TASK2_REAL_ROOT;
const cdpUrl = process.env.TASK2_REAL_CDP_URL ?? "http://127.0.0.1:9333/";
const harnessPath = process.env.TASK2_REAL_HARNESS;

type TestContext = Parameters<VisualLoopManager["prepare"]>[0];

function context(cwd: string, signal?: AbortSignal): TestContext {
  return {
    cwd,
    isProjectTrusted: () => true,
    signal,
  } as TestContext;
}

describe.skipIf(!root || !harnessPath)("Task 2 real Chrome lifecycle", () => {
  it("owns one tab, rejects contention, fails closed after close, and releases on disconnect", async () => {
    const manager = new VisualLoopManager();
    const contender = new VisualLoopManager();
    const cwd = root as string;
    const input = {
      dpr: 2,
      stateLabel: "initial",
      url: "http://127.0.0.1:8765/index.html",
      viewport: {
        height: 360,
        width: 640,
      },
    };

    const first = await manager.prepare(context(cwd), input);
    expect(first.result.page.url).toBe(input.url);
    expect(manager.status().state).toBe("ready");

    await expect(contender.prepare(context(cwd), input)).rejects.toThrow(
      "already owned",
    );

    const second = await manager.prepare(context(cwd), {
      ...input,
      stateLabel: "updated",
      url: "http://127.0.0.1:8765/second.html",
    });
    expect(second.result.targetId).toBe(first.result.targetId);
    expect(second.result.page.url).toBe("http://127.0.0.1:8765/second.html");

    const closeResponse = await fetch(`${cdpUrl}json/close/${first.result.targetId}`);
    expect(closeResponse.ok).toBe(true);
    await expect(manager.prepare(context(cwd), input)).rejects.toThrow();
    expect(manager.status().targetId).toBe(first.result.targetId);

    await manager.disconnect();
    expect(manager.status().state).toBe("disconnected");

    const replacement = new VisualLoopManager();
    const prepared = await replacement.prepare(context(cwd), input);
    const targetId = prepared.result.targetId;
    expect(targetId).not.toBe("");
    await replacement.disconnect();
    expect(
      (await (await fetch(`${cdpUrl}json/list`)).json()).some(
        (target: { id: string }) => target.id === targetId,
      ),
    ).toBe(false);
  });

  it("cancels an in-flight prepare during session reset", async () => {
    const manager = new VisualLoopManager();
    const controller = new AbortController();
    const promise = manager.prepare(
      context(root as string, controller.signal),
      {
        url: "http://127.0.0.1:8765/index.html",
        viewport: {
          height: 360,
          width: 640,
        },
      },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    await manager.resetSession();
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(manager.status().state).toBe("disconnected");
  });
});
