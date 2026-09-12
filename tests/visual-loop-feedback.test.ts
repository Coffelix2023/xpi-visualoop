import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Capture } from "../src/visual-loop/evidence.ts";
import {
  displayRegionToImageRegion,
  embedFeedbackImage,
  feedbackPanelInput,
  loadGlimpse,
  PANEL_COPY,
  renderFeedbackPanel,
  resolvePanelLanguage,
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

  it("gives a comparison that asks a question exactly one answer channel", () => {
    // Found by acceptance: the panel used to offer the accept button and the option
    // list at once, and the bridge refuses `accept` in a choice panel — so pressing
    // the visible button failed the whole call instead of answering the question.
    const html = renderFeedbackPanel({
      capturedAt: "2026-09-09T00:00:01.000Z",
      captureId: "capture-after",
      pageTitle: "After",
      pageUrl: "http://127.0.0.1:8765/",
      question: "Which version?",
      readiness: "ready",
      readinessReasons: [],
      comparison: {
        beforeCaptureId: "capture-before",
        comparisonId: "comparison-choice",
        mode: "variant",
        reasons: [],
        status: "comparable",
        beforeImage: {
          height: 200,
          path: "/tmp/before.png",
          width: 300,
        },
        labels: [
          "B1",
          "B2",
        ],
      },
      image: {
        height: 200,
        path: "/tmp/after.png",
        width: 300,
      },
      options: [
        "B1",
        "B2",
      ],
    });
    expect(html).toContain('type="radio"');
    expect(html).toContain("Submit choice");
    expect(html).not.toContain('id="accept"');
    // The variant wording still names both sides, so the question is answerable.
    expect(html).toContain("B1 · capture-before");
    expect(html).toContain("B2 · capture-after");
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

  it("returns the cancel follow-up answer inside the same cancelled status", () => {
    // Reopening, skipping, and not asking again are three answers to one question.
    // The cancel status is already settled when the answer arrives, so the answer
    // can only refine it.
    expect(
      validateFeedbackBridgeMessage(
        {
          reopenRequested: true,
          suppressForRound: false,
          type: "cancel",
        },
        image,
      ),
    ).toEqual({
      reopenRequested: true,
      status: "cancelled",
      suppressForRound: false,
    });
    expect(
      validateFeedbackBridgeMessage(
        {
          reopenRequested: false,
          suppressForRound: false,
          type: "cancel",
        },
        image,
      ),
    ).toEqual({
      reopenRequested: false,
      status: "cancelled",
      suppressForRound: false,
    });
    expect(
      validateFeedbackBridgeMessage(
        {
          reopenRequested: false,
          suppressForRound: true,
          type: "cancel",
        },
        image,
      ),
    ).toEqual({
      reopenRequested: false,
      status: "cancelled",
      suppressForRound: true,
    });
    // Half an answer, or a contradictory one, is a broken message rather than a
    // fourth answer.
    expect(() =>
      validateFeedbackBridgeMessage(
        {
          reopenRequested: true,
          type: "cancel",
        },
        image,
      ),
    ).toThrow("together");
    expect(() =>
      validateFeedbackBridgeMessage(
        {
          reopenRequested: true,
          suppressForRound: true,
          type: "cancel",
        },
        image,
      ),
    ).toThrow("cannot both");
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

describe("panel copy and theme", () => {
  const base = {
    capturedAt: "2026-09-09T00:00:00.000Z",
    captureId: "capture-copy",
    pageTitle: "Copy",
    pageUrl: "http://127.0.0.1:8765/",
    readiness: "ready" as const,
    readinessReasons: [],
    image: {
      height: 100,
      path: "/tmp/copy.png",
      width: 150,
    },
  };

  it("resolves a declared language, refuses an unknown one, and infers from the locale", () => {
    expect(resolvePanelLanguage("zh-CN")).toBe("zh-CN");
    expect(resolvePanelLanguage("en", "zh-CN")).toBe("en");
    expect(resolvePanelLanguage(undefined, "zh-Hans-CN")).toBe("zh-CN");
    expect(resolvePanelLanguage(undefined, "de-DE")).toBe("en");
    expect(() => resolvePanelLanguage("fr")).toThrow("en or zh-CN");
  });

  it("fills every fixed string in both languages and mixes neither", () => {
    for (const language of [
      "en",
      "zh-CN",
    ] as const) {
      const copy = PANEL_COPY[language];
      for (const [key, value] of Object.entries(copy)) {
        expect(value.length, `${language}.${key} is empty`).toBeGreaterThan(0);
      }
      const other = PANEL_COPY[language === "en" ? "zh-CN" : "en"];
      const html = renderFeedbackPanel({
        ...base,
        language,
      });
      // Presence is asserted against the markup rather than the whole document:
      // "width" and "comment" also occur as identifiers (clientWidth, #feedback-comment),
      // so a bare substring search would pass without the label being rendered.
      expect(html).toContain(
        `<button id="cancel" type="button">${copy.cancel}</button>`,
      );
      expect(html).toContain(`<label>${copy.comment}<textarea id="feedback-comment"`);
      expect(html).toContain(`<label>${copy.width}<input id="region-width"`);
      expect(html).toContain(`<label>${copy.height}<input id="region-height"`);
      expect(html).toContain(`aria-label="${copy.regionSelector}"`);
      expect(html).toContain(`aria-label="${copy.zoomControls}"`);
      expect(html).toContain(`>${copy.submitFeedback}</button>`);

      // Phrases cannot be mistaken for identifiers, so they carry the leak check.
      for (const key of [
        "commentPlaceholder",
        "dragHint",
        "regionSelector",
        "submitFeedback",
        "zoomControls",
      ]) {
        expect(html, `${language} leaked ${key}`).not.toContain(other[key]);
      }
    }
  });

  it("keeps the choice and comparison wording in the same language", () => {
    const choice = renderFeedbackPanel({
      ...base,
      language: "zh-CN",
      question: "选哪个?",
      options: [
        "B1",
        "B2",
      ],
    });
    expect(choice).toContain(PANEL_COPY["zh-CN"].submitChoice);
    expect(choice).toContain(PANEL_COPY["zh-CN"].pickHint);
    expect(choice).not.toContain(PANEL_COPY.en.submitChoice);

    const comparison = renderFeedbackPanel({
      ...base,
      language: "zh-CN",
      comparison: {
        beforeCaptureId: "capture-before",
        comparisonId: "comparison-copy",
        mode: "variant",
        reasons: [],
        status: "comparable",
        beforeImage: {
          height: 100,
          path: "/tmp/before.png",
          width: 150,
        },
        labels: [
          "B1",
          "B2",
        ],
      },
    });
    expect(comparison).toContain(
      PANEL_COPY["zh-CN"].acceptSide.replace("{side}", "B2"),
    );
    expect(comparison).toContain(PANEL_COPY["zh-CN"].feedbackTarget);
    expect(comparison).not.toContain(PANEL_COPY.en.accept);
  });

  it("renders caller text verbatim, in whatever language the caller wrote it", () => {
    const html = renderFeedbackPanel({
      ...base,
      language: "en",
      question: "这两版选哪个?",
      options: [
        "先修间距",
        "直接发布",
      ],
    });
    expect(html).toContain("这两版选哪个?");
    expect(html).toContain("先修间距");
    expect(html).toContain("直接发布");
    // The panel's own copy stays English even when the caller writes Chinese.
    expect(html).toContain(PANEL_COPY.en.submitChoice);
  });

  it("settles the cancel first, then asks what to do next in the same window", () => {
    const html = renderFeedbackPanel(base);
    // Three distinguishable answers to one question, all carrying the cancel status
    // the panel already settled.
    expect(html).toContain('id="cancel-dialog"');
    expect(html).toContain('id="cancel-reopen"');
    expect(html).toContain('id="cancel-skip"');
    expect(html).toContain('id="cancel-never"');
    expect(html).toContain(PANEL_COPY.en.cancelTitle);
    expect(html).toContain(PANEL_COPY.en.cancelBody);
    expect(html).toContain("answerCancel(true, false)");
    expect(html).toContain("answerCancel(false, false)");
    expect(html).toContain("answerCancel(false, true)");
    expect(html).toContain('addEventListener("click", openCancel)');

    // Esc on the follow-up closes only the follow-up: that branch sends nothing, so
    // the panel stays open and unsubmitted instead of producing a second answer.
    const guard = html.slice(
      html.indexOf("if (!dialog.hidden)"),
      html.indexOf('else if (event.key === "Enter"'),
    );
    expect(guard).toContain("closeCancel()");
    expect(guard).not.toContain("send(");
  });

  it("carries both palettes and never pairs a transparent surface with a secondary foreground", () => {
    const html = renderFeedbackPanel(base);
    // Dark values in :root, the light set behind the media query.
    expect(html.match(/--background:/g)).toHaveLength(2);
    expect(html).toContain("@media (prefers-color-scheme: light)");
    expect(html).toContain("oklch(0.2679 0.0036 106.6427)");
    expect(html).toContain("oklch(0.9818 0.0054 95.0986)");
    // Every colour is a token now, so no stray hex can fight the theme.
    expect(html).not.toContain("#2a2a2a");
    expect(html).not.toContain("#1e1e1e");
    expect(html).not.toContain("#000");
    // The rule the prototype taught us, locked in so an edit cannot undo it.
    expect(html).toContain(
      ".picker button { align-items: center; background: transparent; border: 0; color: var(--foreground)",
    );
    expect(html).not.toContain("--secondary-foreground");
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
