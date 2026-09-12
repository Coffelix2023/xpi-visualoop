import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The skill description is the only surface that carries the trigger conditions
 * for these tools, so its contract is worth pinning: a skill without a name and
 * a description is not loaded by Pi at all, and a description without a trigger
 * sentence is the bug this skill exists to fix.
 */
const skillUrl = new URL("../skills/xpi-visualoop/SKILL.md", import.meta.url);
const frontmatterPattern = /^---\n([\s\S]*?)\n---\n/;
const skillNamePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function parseFrontmatter(text: string): Record<string, string> {
  const match = frontmatterPattern.exec(text);
  if (!match?.[1]) throw new Error("SKILL.md has no frontmatter block");
  return Object.fromEntries(
    match[1]
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const separator = line.indexOf(":");
        return [
          line.slice(0, separator).trim(),
          line.slice(separator + 1).trim(),
        ];
      }),
  );
}

describe("visual loop skill", () => {
  it("declares a loadable name and a trigger-bearing description", async () => {
    const text = await readFile(skillUrl, "utf8");
    const frontmatter = parseFrontmatter(text);

    expect(frontmatter.name).toBe("xpi-visualoop");
    expect(frontmatter.name).toMatch(skillNamePattern);
    expect(frontmatter.description.length).toBeLessThanOrEqual(1024);
    expect(frontmatter.description).toContain("Use when");
    expect(frontmatter.description).toContain("Skip it for");
    expect(frontmatter["disable-model-invocation"]).toBeUndefined();
  });

  it("names every tool in the body", async () => {
    const text = await readFile(skillUrl, "utf8");
    for (const tool of [
      "visual_prepare",
      "visual_capture",
      "visual_feedback",
      "visual_verify",
      "visual_compare",
    ])
      expect(text).toContain(tool);
  });
});
