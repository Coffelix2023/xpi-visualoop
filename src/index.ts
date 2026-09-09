import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VERSION = "0.1.0";

export default function xpiVisualoop(pi: ExtensionAPI): void {
  pi.registerCommand("xpi-visualoop", {
    description: "Show xpi-visualoop status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`xpi-visualoop ${VERSION} loaded`);
    },
  });
}
