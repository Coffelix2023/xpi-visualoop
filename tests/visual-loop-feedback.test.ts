import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Capture } from "../src/visual-loop/evidence.ts";
import {
  displayRegionToImageRegion,
  embedFeedbackImage,
  feedbackPanelInput,
  loadGlimpse,
  renderFeedbackPanel,
  validateFeedbackBridgeMessage,
  validateFeedbackDraft,
  waitForFeedbackPanel,
} from "../src/visual-loop/feedback.ts";

describe("embedded feedback evidence", () => {
  it("embeds the registered PNG bytes for WebView rendering", async () => {
    const directory = await mkdtemp(`${tmpdir()}/xpi-feedback-test-`);
    try {
      const imagePath = `${directory}/capture.png`;
      await writeFile(
        imagePath,
        Buffer.from([
          137,
          80,
          78,
          71,
        ]),
      );
      const input = {
        capturedAt: "2026-09-09T00:00:00.000Z",
        captureId: "capture-embedded",
        image: {
          height: 1,
          path: imagePath,
          width: 1,
        },
        imagePath,
        pageTitle: "Test",
        pageUrl: "http://127.0.0.1:8765/",
        readiness: "ready" as const,
        readinessReasons: [],
      };
      await expect(embedFeedbackImage(input)).resolves.toMatchObject({
        imageData: "data:image/png;base64,iVBORw==",
      });
    } finally {
      await rm(directory, {
        force: true,
        recursive: true,
      });
    }
  });
});

describe("visual feedback evidence binding", () => {
  it("keeps the panel image path from the immutable capture", () => {
    const capture = {
      captureId: "capture-bound",
      startedAt: "2026-09-09T00:00:00.000Z",
      image: {
        byteLength: 10,
        crop: undefined,
        height: 10,
        path: "/tmp/capture-bound.png",
        width: 10,
        coordinateScale: {
          x: 1,
          y: 1,
        },
        raw: {
          byteLength: 10,
          height: 10,
          width: 10,
        },
        sourceRegion: {
          height: 10,
          width: 10,
          x: 0,
          y: 0,
        },
      },
      page: {
        height: 10,
        scrollX: 0,
        scrollY: 0,
        title: "Bound capture",
        url: "http://127.0.0.1:8765/",
        width: 10,
      },
      readiness: {
        reasons: [],
        status: "ready" as const,
      },
    } as unknown as Capture;
    expect(feedbackPanelInput(capture).imagePath).toBe(capture.image.path);
  });

  it("hands the picker candidates through to the panel unchanged", () => {
    const candidates = [
      "#pick-0",
      "#pick-1",
      "#pick-2",
    ].map((selector, index) => ({
      role: "button",
      bounds: {
        height: 40,
        width: 100,
        x: 20,
        y: 30 + index,
      },
      documentBounds: {
        height: 40,
        width: 100,
        x: 20,
        y: 30 + index,
      },
      selector,
      text: "Target",
      visibleBounds: {
        height: 40,
        width: 100,
        x: 20,
        y: 30 + index,
      },
    }));
    const capture = {
      candidates,
      captureId: "capture-candidates",
      startedAt: "2026-09-09T00:00:00.000Z",
      image: {
        height: 10,
        path: "/tmp/capture-candidates.png",
        width: 10,
      },
      page: {
        title: "Candidates",
        url: "http://127.0.0.1:8765/",
      },
      readiness: {
        reasons: [],
        status: "ready" as const,
      },
    } as unknown as Capture;

    const input = feedbackPanelInput(capture);
    // The cap belongs to the CDP layer; this one only has to lose nothing.
    expect(input.candidates).toBe(candidates);
    expect(input.candidates).toHaveLength(3);
    expect(input.candidates?.[0]?.selector).toBe("#pick-0");
  });
});

describe("visual feedback coordinates", () => {
  it("maps a reversed drag after display scaling back to source pixels", () => {
    expect(
      displayRegionToImageRegion(
        {
          height: -120,
          width: -200,
          x: 440,
          y: 360,
        },
        {
          height: 600,
          width: 1000,
          x: 0,
          y: 0,
        },
        0.5,
      ),
    ).toEqual({
      height: 240,
      width: 400,
      x: 480,
      y: 480,
    });
  });

  it("accounts for a scrolled image viewport through its image rect", () => {
    expect(
      displayRegionToImageRegion(
        {
          height: 50,
          width: 75,
          x: 125,
          y: 225,
        },
        {
          height: 800,
          width: 1200,
          x: -80,
          y: -140,
        },
        1,
      ),
    ).toEqual({
      height: 50,
      width: 75,
      x: 205,
      y: 365,
    });
  });

  it("rejects empty, non-finite, zero-area, and out-of-bounds regions", () => {
    expect(() =>
      validateFeedbackDraft({
        comment: "  ",
        source: "drag",
        image: {
          height: 100,
          width: 100,
        },
        region: {
          height: 1,
          width: 1,
          x: 0,
          y: 0,
        },
      }),
    ).toThrow("comment");
    expect(() =>
      validateFeedbackDraft({
        comment: "fix",
        source: "drag",
        image: {
          height: 100,
          width: 100,
        },
        region: {
          height: 0,
          width: 1,
          x: 0,
          y: 0,
        },
      }),
    ).toThrow("positive");
    expect(() =>
      validateFeedbackDraft({
        comment: "fix",
        source: "drag",
        image: {
          height: 100,
          width: 100,
        },
        region: {
          height: 2,
          width: 2,
          x: 99,
          y: 0,
        },
      }),
    ).toThrow("bounds");
  });
});

describe("visual feedback panel HTML", () => {
  it("escapes dynamic text and contains only the controlled image resource", () => {
    const html = renderFeedbackPanel({
      capturedAt: "2026-09-09T00:00:00.000Z",
      captureId: "capture-<unsafe>",
      imagePath: "/tmp/capture & review.png",
      pageTitle: '<img src=x onerror="alert(1)">',
      pageUrl: 'http://127.0.0.1:8765/?q="unsafe"',
      readiness: "degraded",
      image: {
        height: 200,
        width: 300,
      },
      readinessReasons: [
        "font <not ready>",
      ],
    });
    expect(html).toContain("capture-&lt;unsafe&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<script src=");
    expect(html).not.toContain("https://");
    expect(html).toContain("window.glimpse.send");
    expect(html).toContain('id="feedback-comment"');
    expect(html).toContain("if (!sent)");
  });

  it("blocks the native image drag on every panel image", () => {
    const single = renderFeedbackPanel({
      capturedAt: "2026-09-09T00:00:00.000Z",
      captureId: "capture-single",
      imagePath: "/tmp/single.png",
      pageTitle: "Single",
      pageUrl: "http://127.0.0.1:8765/",
      readiness: "ready",
      readinessReasons: [],
      image: {
        height: 200,
        width: 300,
      },
    });
    const comparison = renderFeedbackPanel({
      capturedAt: "2026-09-09T00:00:01.000Z",
      captureId: "capture-after",
      pageTitle: "After",
      pageUrl: "http://127.0.0.1:8765/",
      readiness: "ready",
      readinessReasons: [],
      comparison: {
        beforeCaptureId: "capture-before",
        comparisonId: "comparison-drag",
        reasons: [],
        status: "comparable",
        beforeImage: {
          height: 200,
          path: "/tmp/before.png",
          width: 300,
        },
      },
      image: {
        height: 200,
        path: "/tmp/after.png",
        width: 300,
      },
    });
    for (const html of [
      single,
      comparison,
    ]) {
      expect(html).toContain("-webkit-user-drag: none");
      expect(html).toContain('addEventListener("dragstart"');
      expect(html).toContain("event.preventDefault()");
      expect(html).toContain("start = sourcePoint(event)");
      // Counting rather than spot-checking: a panel image added later without
      // the attribute fails this even if the CSS rule is still in place.
      expect(html.match(/draggable="false"/g)?.length).toBe(
        html.match(/<img /g)?.length,
      );
    }
  });

  it("renders a structured choice without requiring a region", () => {
    const html = renderFeedbackPanel({
      capturedAt: "2026-09-09T00:00:00.000Z",
      captureId: "capture-choice",
      imagePath: "/tmp/choice.png",
      pageTitle: "Choice",
      pageUrl: "http://127.0.0.1:8765/",
      question: 'Pick one <img src=x onerror="alert(1)">',
      readiness: "ready",
      readinessReasons: [],
      image: {
        height: 200,
        width: 300,
      },
      options: [
        "Fix <script>alert(1)</script>",
        "Ship as is",
      ],
    });
    expect(html).toContain('type="radio"');
    expect(html).toContain('name="choice"');
    expect(html).toContain("Submit choice");
    expect(html).toContain("const choiceMode = true;");
    expect(html).toContain('answer = { type: "choice"');
    // The question and its options are data, never markup.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<img src=x onerror");
    // Autofocus would steal the focus from the options.
    expect(html).not.toContain("autofocus");
    expect(html).toContain("Pick one option");
  });

  it("leaves the region form alone when no options are given", () => {
    const html = renderFeedbackPanel({
      capturedAt: "2026-09-09T00:00:00.000Z",
      captureId: "capture-region",
      imagePath: "/tmp/region.png",
      pageTitle: "Region",
      pageUrl: "http://127.0.0.1:8765/",
      readiness: "ready",
      readinessReasons: [],
      image: {
        height: 200,
        width: 300,
      },
    });
    expect(html).toContain("const choiceMode = false;");
    expect(html).toContain("Submit feedback");
    expect(html).toContain("autofocus");
    expect(html).not.toContain('type="radio"');
    expect(html).toContain("Drag on the target image");
  });

  it("names comparison sides with the caller's labels, then positionally", () => {
    const comparison = {
      beforeCaptureId: "capture-b1",
      comparisonId: "comparison-labels",
      mode: "variant" as const,
      status: "comparable" as const,
      beforeImage: {
        height: 200,
        path: "/tmp/b1.png",
        width: 300,
      },
      reasons: [
        "page URL changed",
      ],
    };
    const base = {
      capturedAt: "2026-09-09T00:00:01.000Z",
      captureId: "capture-b2",
      pageTitle: "B2",
      pageUrl: "http://127.0.0.1:8765/variant-b2",
      readiness: "ready" as const,
      readinessReasons: [],
      image: {
        height: 200,
        path: "/tmp/b2.png",
        width: 300,
      },
    };

    const labelled = renderFeedbackPanel({
      ...base,
      comparison: {
        ...comparison,
        labels: [
          "B1 紧凑",
          "B2 宽松",
        ],
      },
    });
    expect(labelled).toContain("B1 紧凑");
    expect(labelled).toContain("B2 宽松");
    expect(labelled).toContain("Accept B2 宽松");
    expect(labelled).not.toContain("Before");
    expect(labelled).not.toContain("After");

    const unlabelled = renderFeedbackPanel({
      ...base,
      comparison,
    });
    // A variant without labels is positional, never a claim about order.
    expect(unlabelled).toContain("Left");
    expect(unlabelled).toContain("Right");
    expect(unlabelled).not.toContain("Before");
    expect(unlabelled).not.toContain("After");
    expect(unlabelled).toContain("Accept Right");

    const regression = renderFeedbackPanel({
      ...base,
      comparison: {
        ...comparison,
        mode: "regression",
      },
    });
    expect(regression).toContain("Before");
    expect(regression).toContain("After");
    expect(regression).toContain("Accept result");
  });

  it("scales candidate boxes into image pixels", () => {
    const candidate = {
      role: "button",
      selector: "#save-button",
      text: "Save changes",
      bounds: {
        height: 80,
        width: 200,
        x: 100,
        y: 40,
      },
      documentBounds: {
        height: 80,
        width: 200,
        x: 100,
        y: 40,
      },
      visibleBounds: {
        height: 80,
        width: 200,
        x: 100,
        y: 40,
      },
    };
    const base = {
      capturedAt: "2026-09-09T00:00:00.000Z",
      captureId: "capture-hotspots",
      pageTitle: "Hotspots",
      pageUrl: "http://127.0.0.1:8765/",
      readiness: "ready" as const,
      readinessReasons: [],
      candidates: [
        candidate,
      ],
    };

    const scaled = renderFeedbackPanel({
      ...base,
      image: {
        height: 100,
        path: "/tmp/hotspots.png",
        width: 150,
        coordinateScale: {
          x: 0.5,
          y: 0.5,
        },
      },
    });
    // The exported image is half the page's pixels, so the box halves with it and a
    // pick lands on the same place the element occupies in the picture.
    expect(scaled).toContain("height:40px;left:50px;top:20px;width:100px");
    expect(scaled).toContain('data-hotspot="0"');
    expect(scaled).toContain('data-candidate="0"');
    expect(scaled).toContain("#save-button");
    expect(scaled).toContain("Save changes");

    const unscaled = renderFeedbackPanel({
      ...base,
      image: {
        height: 100,
        path: "/tmp/hotspots.png",
        width: 150,
      },
    });
    expect(unscaled).toContain("height:80px;left:100px;top:40px;width:200px");

    const none = renderFeedbackPanel({
      ...base,
      candidates: [],
      image: {
        height: 100,
        path: "/tmp/hotspots.png",
        width: 150,
      },
    });
    expect(none).not.toContain("data-hotspot=");
    expect(none).not.toContain('class="picker"');
  });
});

it("renders immutable before and after versions without an automatic pass", () => {
  const html = renderFeedbackPanel({
    capturedAt: "2026-09-09T00:00:01.000Z",
    captureId: "capture-after",
    pageTitle: "After",
    pageUrl: "http://127.0.0.1:8765/",
    readiness: "ready",
    readinessReasons: [],
    comparison: {
      beforeCaptureId: "capture-before",
      comparisonId: "comparison-review",
      reasons: [],
      status: "comparable",
      beforeImage: {
        height: 200,
        path: "/tmp/before.png",
        width: 300,
      },
    },
    image: {
      height: 200,
      path: "/tmp/after.png",
      width: 300,
    },
  });
  expect(html).toContain("comparison-review");
  expect(html).toContain("capture-before");
  expect(html).toContain("capture-after");
  expect(html).toContain('id="before-image"');
  expect(html).toContain('id="evidence-image"');
  expect(html).toContain('id="accept"');
  expect(html).toContain("Not reviewed");
  expect(html).not.toContain("PASS");
});

describe("optional glimpse loading", () => {
  it("fails closed when the optional module path is unavailable", async () => {
    await expect(
      loadGlimpse("/tmp/visual-loop-missing-glimpse.mjs"),
    ).resolves.toBeNull();
  });
});

describe("visual feedback bridge messages", () => {
  const image = {
    height: 100,
    width: 200,
  };

  it("maps close and cancel to cancelled without a draft", async () => {
    expect(validateFeedbackBridgeMessage(null, image)).toEqual({
      status: "cancelled",
    });
    expect(
      validateFeedbackBridgeMessage(
        {
          type: "cancel",
        },
        image,
      ),
    ).toEqual({
      status: "cancelled",
    });
  });

  it("accepts only an explicit comparison acceptance message", () => {
    expect(
      validateFeedbackBridgeMessage(
        {
          type: "accept",
        },
        image,
        "comparison",
      ),
    ).toEqual({
      status: "accepted",
    });
    expect(() =>
      validateFeedbackBridgeMessage(
        {
          type: "accept",
        },
        image,
      ),
    ).toThrow("accept");
  });

  it("takes a choice answer only from a choice panel", () => {
    expect(
      validateFeedbackBridgeMessage(
        {
          choice: "B1",
          type: "choice",
        },
        image,
        "choice",
      ),
    ).toEqual({
      choice: "B1",
      status: "chosen",
    });
    expect(() =>
      validateFeedbackBridgeMessage(
        {
          choice: "B1",
          type: "choice",
        },
        image,
      ),
    ).toThrow("choice is only valid");
    expect(() =>
      validateFeedbackBridgeMessage(
        {
          choice: "",
          type: "choice",
        },
        image,
        "choice",
      ),
    ).toThrow("non-empty");
    // A choice panel answers the question; it does not submit a region on its own.
    expect(() =>
      validateFeedbackBridgeMessage(
        {
          comment: "Only a region",
          type: "submit",
          region: {
            height: 1,
            width: 1,
            x: 0,
            y: 0,
          },
        },
        image,
        "choice",
      ),
    ).toThrow("not a region");
  });

  it("carries an optional region and comment alongside a choice", () => {
    const bare = validateFeedbackBridgeMessage(
      {
        choice: "B2",
        type: "choice",
      },
      image,
      "choice",
    );
    expect(bare).toEqual({
      choice: "B2",
      status: "chosen",
    });

    const annotated = validateFeedbackBridgeMessage(
      {
        choice: "B2",
        comment: "This one keeps the footer padding.",
        type: "choice",
        region: {
          height: 20,
          width: 40,
          x: 5,
          y: 6,
        },
      },
      image,
      "choice",
    );
    expect(annotated).toMatchObject({
      choice: "B2",
      status: "chosen",
    });
    expect(annotated).toHaveProperty("draft.region", {
      height: 20,
      width: 40,
      x: 5,
      y: 6,
    });
  });
  it("carries an element identity only when the region was picked", () => {
    const region = {
      height: 10,
      width: 20,
      x: 1,
      y: 2,
    };
    const picked = validateFeedbackBridgeMessage(
      {
        comment: "Tighten this button.",
        region,
        source: "pick",
        type: "submit",
        target: {
          role: "button",
          selector: "#save-button",
          text: "Save changes",
        },
      },
      image,
      "capture",
    );
    expect(picked).toMatchObject({
      status: "submitted",
      draft: {
        source: "pick",
        target: {
          role: "button",
          selector: "#save-button",
          text: "Save changes",
        },
      },
    });

    const dragged = validateFeedbackBridgeMessage(
      {
        comment: "Tighten this area.",
        region,
        source: "drag",
        type: "submit",
      },
      image,
      "capture",
    );
    expect(dragged).toMatchObject({
      status: "submitted",
      draft: {
        source: "drag",
      },
    });
    expect(dragged).not.toHaveProperty("draft.target");

    // A panel that predates the field still means "shaped by hand".
    const silent = validateFeedbackBridgeMessage(
      {
        comment: "No source field.",
        region,
        type: "submit",
      },
      image,
      "capture",
    );
    expect(silent).toMatchObject({
      draft: {
        source: "drag",
      },
    });

    // Claiming an element without picking one, and picking without an element, are
    // both broken messages rather than hand-made regions.
    for (const message of [
      {
        comment: "Claims an element",
        region,
        source: "drag",
        type: "submit",
        target: {
          role: "button",
          selector: "#x",
          text: "",
        },
      },
      {
        comment: "Picks nothing",
        region,
        source: "pick",
        type: "submit",
      },
    ]) {
      expect(() => validateFeedbackBridgeMessage(message, image, "capture")).toThrow();
    }
  });

  it("validates one submitted message against the source image", () => {
    expect(
      validateFeedbackBridgeMessage(
        {
          comment: "Keep this spacing.",
          type: "submit",
          region: {
            height: 20,
            width: 40,
            x: 10,
            y: 15,
          },
        },
        image,
      ),
    ).toMatchObject({
      status: "submitted",
      draft: {
        comment: "Keep this spacing.",
        region: {
          height: 20,
          width: 40,
          x: 10,
          y: 15,
        },
      },
    });
  });

  it("rejects malformed, invalid, blank, and oversized submissions", () => {
    expect(() =>
      validateFeedbackBridgeMessage(
        {
          type: "unknown",
        },
        image,
      ),
    ).toThrow("type");
    expect(() =>
      validateFeedbackBridgeMessage(
        {
          comment: "bad",
          type: "submit",
          region: {
            height: 20,
            width: Number.NaN,
            x: 10,
            y: 15,
          },
        },
        image,
      ),
    ).toThrow("finite");
    expect(() =>
      validateFeedbackBridgeMessage(
        {
          comment: " ",
          type: "submit",
          region: {
            height: 20,
            width: 40,
            x: 10,
            y: 15,
          },
        },
        image,
      ),
    ).toThrow("blank");
    expect(() =>
      validateFeedbackBridgeMessage(
        {
          comment: "x".repeat(2001),
          type: "submit",
          region: {
            height: 20,
            width: 40,
            x: 10,
            y: 15,
          },
        },
        image,
      ),
    ).toThrow("2000");
    expect(() =>
      validateFeedbackBridgeMessage(
        {
          comment: "bad",
          type: "submit",
          region: {
            height: 20,
            width: 40,
            x: 180,
            y: 15,
          },
        },
        image,
      ),
    ).toThrow("bounds");
  });
});

describe("feedback panel lifecycle", () => {
  it("cancels and closes on abort, ignoring late messages", async () => {
    let message: ((value: unknown) => void) | undefined;
    let closed: (() => void) | undefined;
    let closeCount = 0;
    const result = waitForFeedbackPanel(
      {
        open: () => ({
          close: () => {
            closeCount += 1;
          },
          on: (event: "closed" | "message", listener: (value?: unknown) => void) => {
            if (event === "message") message = listener;
            else closed = listener as () => void;
          },
        }),
      },
      "<html>",
      {
        timeout: 1000,
      },
      (() => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 5);
        return controller.signal;
      })(),
      () => undefined,
    );
    await expect(result).resolves.toBeNull();
    expect(closeCount).toBe(1);
    message?.({
      type: "submit",
    });
    closed?.();
    expect(closeCount).toBe(1);
  });

  it("closes only once when the window closes before the timer", async () => {
    let closed: (() => void) | undefined;
    let closeCount = 0;
    const result = waitForFeedbackPanel(
      {
        open: () => ({
          close: () => {
            closeCount += 1;
          },
          on: (event: "closed" | "message", listener: (value?: unknown) => void) => {
            if (event === "closed") closed = listener as () => void;
          },
        }),
      },
      "<html>",
      {
        timeout: 1000,
      },
      new AbortController().signal,
      () => undefined,
    );
    closed?.();
    await expect(result).resolves.toBeNull();
    expect(closeCount).toBe(0);
  });
});
