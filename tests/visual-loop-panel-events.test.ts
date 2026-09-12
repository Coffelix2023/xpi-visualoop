import { describe, expect, it } from "vitest";
import { renderFeedbackPanel } from "../src/visual-loop/feedback.ts";

/**
 * The panel's pointer handling depends on real browser event semantics: the stage
 * captures the pointer on pointerdown, and a captured pointer retargets `click` to
 * the capturing element, so the hotspot's own click listener never fires. A string
 * assertion cannot catch that, and neither can a test of a copy of the logic — so
 * this runs the generated script against a fixture DOM and drives the same pointer
 * sequence a browser sends.
 */
type Handler = (event: Record<string, unknown>) => void;

interface FakeNode {
  addEventListener: (type: string, handler: Handler) => void;
  attributes: Record<string, string>;
  clientHeight?: number;
  clientWidth?: number;
  closest: (selector: string) => FakeNode | null;
  dataset: Record<string, string>;
  focus: () => void;
  getBoundingClientRect: () => {
    height: number;
    left: number;
    top: number;
    width: number;
  };
  height?: number;
  hidden?: boolean;
  style: Record<string, string>;
  textContent?: string;
  value?: string;
  width?: number;
  setPointerCapture: (pointerId: number) => void;
  setAttribute: (name: string, value: string) => void;
  fire: (type: string, event: Record<string, unknown>) => void;
}

function fakeNode(extra: Partial<FakeNode> = {}): FakeNode {
  const listeners = new Map<string, Handler[]>();
  const node: FakeNode = {
    addEventListener: (type, handler) => {
      listeners.set(type, [
        ...(listeners.get(type) ?? []),
        handler,
      ]);
    },
    attributes: {},
    closest: () => null,
    dataset: {},
    fire: (type, event) => {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    setPointerCapture: () => undefined,
    setAttribute: (name, value) => {
      node.attributes[name] = String(value);
    },
    focus: () => undefined,
    getBoundingClientRect: () => ({
      height: 200,
      left: 0,
      top: 0,
      width: 300,
    }),
    style: {},
    ...extra,
  };
  return node;
}

const IMAGE_RECT = {
  height: 200,
  left: 0,
  top: 0,
  width: 300,
};

function harness() {
  const box = {
    height: 40,
    width: 100,
    x: 20,
    y: 30,
  };
  const hotspot = fakeNode({
    closest: (selector) => (selector === "[data-hotspot]" ? hotspot : null),
    dataset: {
      hotspot: "0",
    },
    getBoundingClientRect: () => ({
      height: box.height,
      left: box.x,
      top: box.y,
      width: box.width,
    }),
  });
  const stage = fakeNode();
  const image = fakeNode({
    clientHeight: 200,
    clientWidth: 300,
    getBoundingClientRect: () => IMAGE_RECT,
    height: 200,
    width: 300,
  });
  const selection = fakeNode();
  const fields: Record<string, FakeNode> = {
    height: fakeNode({
      value: "1",
    }),
    width: fakeNode({
      value: "1",
    }),
    x: fakeNode({
      value: "0",
    }),
    y: fakeNode({
      value: "0",
    }),
  };
  const label = fakeNode();
  const nodes: Record<string, FakeNode> = {
    "cancel-dialog": fakeNode({
      hidden: true,
    }),
    "cancel-never": fakeNode(),
    "cancel-reopen": fakeNode(),
    "cancel-skip": fakeNode(),
    cancel: fakeNode(),
    error: fakeNode(),
    "evidence-image": image,
    "feedback-comment": fakeNode({
      value: "",
    }),
    "hotspot-label": label,
    "image-stage": stage,
    "region-height": fields.height ?? fakeNode(),
    "region-width": fields.width ?? fakeNode(),
    "region-x": fields.x ?? fakeNode(),
    "region-y": fields.y ?? fakeNode(),
    selection,
    submit: fakeNode(),
    "zoom-in": fakeNode(),
    "zoom-out": fakeNode(),
    "zoom-reset": fakeNode(),
  };

  const sent: Record<string, unknown>[] = [];
  const document = {
    addEventListener: () => undefined,
    body: {
      style: {},
    },
    elementFromPoint: (x: number, y: number) => {
      const inside =
        x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
      return inside ? hotspot : stage;
    },
    getElementById: (id: string) => nodes[id],
    querySelector: () => undefined,
    querySelectorAll: (selector: string) =>
      selector === "[data-hotspot]" ? [
        hotspot,
      ] : [],
  };
  const window = {
    glimpse: {
      send: (message: Record<string, unknown>) => sent.push(message),
    },
  };

  const html = renderFeedbackPanel({
    candidates: [
      {
        bounds: box,
        documentBounds: box,
        role: "button",
        selector: "#save-button",
        text: "Save changes",
        visibleBounds: box,
      },
    ],
    capturedAt: "2026-09-12T00:00:00.000Z",
    captureId: "capture-pick",
    image: {
      height: 200,
      path: "/tmp/pick.png",
      width: 300,
    },
    pageTitle: "Pick",
    pageUrl: "http://127.0.0.1:8765/",
    readiness: "ready",
    readinessReasons: [],
  });
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error("the panel rendered without a script");
  // biome-ignore lint/security/noGlobalEval: the test runs the panel's own generated script.
  new Function("document", "window", script)(document, window);

  const pointer = (type: string, x: number, y: number) => {
    const event = {
      clientX: x,
      clientY: y,
      pointerId: 1,
      preventDefault: () => undefined,
      target: stage,
    };
    stage.fire(type, event);
    hotspot.fire(type, event);
  };

  return {
    fields,
    hotspot,
    pointer,
    selection,
    sent,
    stage,
  };
}

describe("feedback panel pointer events", () => {
  it("turns a press on a hotspot into that element's region", () => {
    const panel = harness();
    // The centre of the #save-button hotspot, in image coordinates.
    panel.pointer("pointerdown", 70, 50);
    panel.pointer("pointerup", 70, 50);

    expect(panel.fields.x?.value).toBe("20");
    expect(panel.fields.y?.value).toBe("30");
    expect(panel.fields.width?.value).toBe("100");
    expect(panel.fields.height?.value).toBe("40");
    expect(panel.hotspot.attributes["aria-current"]).toBe("true");
    expect(panel.selection.style.display).toBe("block");
  });

  it("still lets a drag beat the hotspot it started on", () => {
    const panel = harness();
    // Pick first, so the drag has something to take back.
    panel.pointer("pointerdown", 70, 50);
    panel.pointer("pointerup", 70, 50);
    expect(panel.hotspot.attributes["aria-current"]).toBe("true");

    panel.pointer("pointerdown", 70, 50);
    panel.pointer("pointermove", 120, 90);
    panel.pointer("pointerup", 120, 90);

    // The dragged rectangle wins, and the press does not come back as a pick.
    expect(panel.fields.x?.value).toBe("70");
    expect(panel.fields.y?.value).toBe("50");
    expect(panel.fields.width?.value).toBe("50");
    expect(panel.fields.height?.value).toBe("40");
    expect(panel.hotspot.attributes["aria-current"]).toBe("false");
  });
});
