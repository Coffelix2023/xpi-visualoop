import { describe, expect, it } from "vitest";
import { candidatesScript, MAX_CANDIDATES } from "../src/visual-loop/cdp-actions.ts";

interface Candidate {
  bounds: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  role: string;
  selector: string;
  text: string;
  visibleBounds: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
}

interface ElementOptions {
  attributes?: Record<string, string>;
  className?: string;
  height?: number;
  id?: string;
  left?: number;
  style?: Record<string, string>;
  text?: string;
  top?: number;
  width?: number;
}

/**
 * The picker script runs inside the page, so the only honest way to test it is to run
 * it against a fixture DOM. The fixture implements exactly the surface the script
 * touches, which keeps this a test of the real filter rather than of a copy of it.
 */
function element(tag: string, options: ElementOptions = {}) {
  const attributes = options.attributes ?? {};
  const rect = {
    height: options.height ?? 40,
    left: options.left ?? 0,
    top: options.top ?? 0,
    width: options.width ?? 100,
  };
  return {
    className: options.className ?? "",
    id: options.id ?? "",
    innerText: options.text ?? "",
    style: options.style ?? {},
    tagName: tag.toUpperCase(),
    textContent: options.text ?? "",
    getAttribute: (name: string) => attributes[name] ?? null,
    getBoundingClientRect: () => ({
      bottom: rect.top + rect.height,
      height: rect.height,
      left: rect.left,
      right: rect.left + rect.width,
      top: rect.top,
      width: rect.width,
    }),
  };
}

function run(nodes: ReturnType<typeof element>[]): Candidate[] {
  const document = {
    querySelectorAll: () => nodes,
  };
  const getComputedStyle = (node: { style: Record<string, string> }) => node.style;
  // The script reads these as page globals, so they are injected as parameters.
  const factory = new Function(
    "document",
    "getComputedStyle",
    "innerWidth",
    "innerHeight",
    "scrollX",
    "scrollY",
    `return ${candidatesScript()}`,
  );
  return factory(document, getComputedStyle, 800, 600, 0, 0) as Candidate[];
}

describe("picker candidates", () => {
  it("caps the list even when the page is larger", () => {
    const nodes = Array.from(
      {
        length: MAX_CANDIDATES + 20,
      },
      (_, index) =>
        element("button", {
          top: index,
        }),
    );
    expect(run(nodes)).toHaveLength(MAX_CANDIDATES);
  });

  it("keeps only visible, sizeable, on-screen elements", () => {
    const found = run([
      element("button", {
        id: "keep",
      }),
      element("button", {
        height: 4,
        id: "too-small",
        width: 4,
      }),
      element("button", {
        id: "hidden",
        style: {
          display: "none",
        },
      }),
      element("button", {
        id: "invisible",
        style: {
          visibility: "hidden",
        },
      }),
      element("button", {
        id: "transparent",
        style: {
          opacity: "0",
        },
      }),
      element("button", {
        id: "offscreen",
        left: 900,
      }),
    ]);
    expect(found.map((item) => item.selector)).toEqual([
      "#keep",
    ]);
  });

  it("names every candidate on a page with no ARIA at all", () => {
    const found = run([
      element("button"),
      element("h1", {
        top: 50,
      }),
      element("dialog", {
        top: 100,
      }),
      element("x-widget", {
        top: 150,
      }),
    ]);
    expect(found.map((item) => item.role)).toEqual([
      "button",
      "heading",
      "dialog",
      "x-widget",
    ]);
    for (const item of found) {
      expect(item.role.length).toBeGreaterThan(0);
      expect(item.selector.length).toBeGreaterThan(0);
    }
  });

  it("prefers a declared role, then an id, a test id, a class, and the tag", () => {
    const found = run([
      element("div", {
        id: "declared",
        attributes: {
          role: "tab",
        },
      }),
      element("button", {
        id: "save-button",
        top: 50,
      }),
      element("button", {
        top: 100,
        attributes: {
          "data-testid": "save",
        },
      }),
      element("div", {
        className: "card row",
        top: 150,
      }),
      element("span", {
        top: 200,
      }),
    ]);
    expect(found.map((item) => item.role)).toEqual([
      "tab",
      "button",
      "button",
      "div",
      "span",
    ]);
    expect(found.map((item) => item.selector)).toEqual([
      "#declared",
      "#save-button",
      'button[data-testid="save"]',
      "div.card",
      "span",
    ]);
  });

  it("keeps document order", () => {
    const found = run([
      element("button", {
        id: "first",
      }),
      element("button", {
        id: "second",
        top: 50,
      }),
      element("button", {
        id: "third",
        top: 100,
      }),
    ]);
    expect(found.map((item) => item.selector)).toEqual([
      "#first",
      "#second",
      "#third",
    ]);
  });

  it("clamps only the visible rectangle and keeps the real box", () => {
    const found = run([
      element("button", {
        left: -20,
        top: -10,
      }),
    ]);
    expect(found).toHaveLength(1);
    const [candidate] = found;
    // The element box is reported as it is; only the visible rectangle is clamped.
    expect(candidate?.bounds).toEqual({
      height: 40,
      width: 100,
      x: -20,
      y: -10,
    });
    expect(candidate?.visibleBounds).toEqual({
      height: 30,
      width: 80,
      x: 0,
      y: 0,
    });
  });
});
