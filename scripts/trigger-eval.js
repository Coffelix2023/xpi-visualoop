// Count the visual_prepare calls a transcript actually made.
//
// A transcript is JSONL: one record per line, and an assistant record carries
// `message.content` blocks. Only `{ type: "toolCall", name: "visual_prepare" }`
// is a call. Assistant prose and thinking that merely names the tool is not,
// which is why `grep -c visual_prepare` passed a case whose every hit was text.
//
// Usage: node scripts/trigger-eval.js <transcript.jsonl>
// Prints one line: calls=<n>
// Exit code: 2 without an argument, 1 on an unreadable or unparsable transcript.

import { readFileSync } from "node:fs";

const TOOL_NAME = "visual_prepare";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/trigger-eval.js <transcript.jsonl>");
  process.exit(2);
}

let text;
try {
  text = readFileSync(path, "utf8");
} catch (error) {
  console.error(`cannot read transcript: ${error.message}`);
  process.exit(1);
}

let calls = 0;
for (const [index, line] of text.split("\n").entries()) {
  if (line.trim() === "") continue;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    console.error(`transcript line ${index + 1} is not JSON`);
    process.exit(1);
  }
  const content = record?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block?.type === "toolCall" && block.name === TOOL_NAME) calls += 1;
  }
}

console.log(`calls=${calls}`);
