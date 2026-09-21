import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("legacy Pages redirect", () => {
  it("keeps hash routes and filters without accepting a different target origin", async () => {
    const html = await readFile(new URL("../pages-redirect/index.html", import.meta.url), "utf8");
    const href = /id="dashboard" href="([^"]+)"/.exec(html)?.[1];
    const script = /<script>([\s\S]+?)<\/script>/.exec(html)?.[1];
    if (!href || !script) throw new Error("Missing dashboard link or redirect.");
    for (const hash of ["#/emitter?draft=true", "#/sdk-prs?search=core", "#//attacker.example", ""]) {
      const link = new URL(href);
      const replace = vi.fn();
      runInNewContext(script, {
        document: { getElementById: () => link },
        window: { location: { hash, replace } },
      });
      expect(link.origin).toBe("https://ca-sdk-js-worker.ambitiouspond-79d04e69.eastus2.azurecontainerapps.io");
      expect(link.hash).toBe(hash);
      expect(replace).toHaveBeenCalledWith(link.href);
    }
  });
});
