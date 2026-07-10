import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as htmlManifest from "../scripts/html-to-manifest.mjs";
import * as browserRuntime from "../scripts/lib/html-layout-audit.mjs";
import { localizeHtmlRemoteAssets } from "../scripts/run-html-pipeline.mjs";

describe("Task 2 HTML remote asset security", () => {
  it("exposes remote fetching only through an explicit public CLI opt-in", async () => {
    const { buildInvocation } = await import("../scripts/pptx.mjs");
    expect(buildInvocation(["html", "input.html", "out", "--allow-remote-assets"]).args)
      .toEqual(["html", "replica", "input.html", "out", "--allow-remote-assets"]);
  });

  it("rejects remote assets by default without fetching", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-html-secure-"));
    const input = join(dir, "input.html");
    const output = join(dir, "deck.manifest.json");
    await writeFile(input, `<section class="pptx-slide"><img data-x="1" data-y="1" data-w="2" data-h="1" src="https://example.com/a.png"></section>`, "utf8");
    let fetched = false;
    await expect(htmlManifest.writeManifestFromHtml(input, output, {
      fetchRemoteAsset: async () => { fetched = true; return Buffer.from("image"); }
    })).rejects.toThrow(/--allow-remote-assets/);
    expect(fetched).toBe(false);
  });

  it("localizes opted-in remote images before browser measurement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-html-localize-"));
    const input = join(dir, "input.html");
    await writeFile(input, `<section><img src="https://assets.example.com/a.png"></section>`, "utf8");
    const localized = await localizeHtmlRemoteAssets(input, dir, {
      allowRemoteAssets: true,
      fetchRemoteAsset: async () => Buffer.from("png")
    });
    const html = await import("node:fs/promises").then((fs) => fs.readFile(localized, "utf8"));
    expect(html).not.toContain("https://");
    expect(html).toContain("assets/remote-source-001.png");
  });

  it("localizes unquoted src, srcset candidates, and SVG image href before browser measurement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-html-localize-attributes-"));
    const input = join(dir, "input.html");
    await writeFile(input, [
      "<section>",
      "<img src=https://assets.example.com/a.png>",
      "<img srcset=\"https://assets.example.com/b.png 1x, https://assets.example.com/c.png 2x\">",
      "<svg><image href='https://assets.example.com/d.svg'/></svg>",
      "</section>"
    ].join(""), "utf8");
    const fetched = [];
    const localized = await localizeHtmlRemoteAssets(input, dir, {
      allowRemoteAssets: true,
      fetchRemoteAsset: async (url) => {
        fetched.push(url);
        return Buffer.from("image");
      }
    });
    const html = await import("node:fs/promises").then((fs) => fs.readFile(localized, "utf8"));
    expect(fetched).toHaveLength(4);
    expect(html).not.toContain("https://");
    expect(html.match(/assets\/remote-source-\d{3}/g)).toHaveLength(4);
  });

  it("blocks loopback, private, and link-local destinations even with opt-in", async () => {
    expect(typeof htmlManifest.assertSafeRemoteAssetUrl).toBe("function");
    for (const url of [
      "http://127.0.0.1/a.png",
      "http://localhost/a.png",
      "http://10.0.0.1/a.png",
      "http://172.16.0.1/a.png",
      "http://192.168.1.1/a.png",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/a.png",
      "http://[::ffff:127.0.0.1]/a.png",
      "http://[::ffff:10.0.0.1]/a.png",
      "http://[0:0:0:0:0:0:0:1]/a.png",
      "http://[0:0:0:0:0:ffff:7f00:1]/a.png",
      "http://[fe80::1]/a.png"
    ]) expect(() => htmlManifest.assertSafeRemoteAssetUrl(url)).toThrow(/blocked destination/i);
  });

  it("blocks public hostnames that resolve to private addresses", async () => {
    expect(typeof htmlManifest.assertPublicRemoteResolution).toBe("function");
    await expect(htmlManifest.assertPublicRemoteResolution(
      new URL("https://assets.example.com/a.png"),
      async () => [{ address: "10.1.2.3", family: 4 }]
    )).rejects.toThrow(/resolved to 10\.1\.2\.3/);
    await expect(htmlManifest.assertPublicRemoteResolution(
      new URL("https://assets.example.com/a.png"),
      async () => [{ address: "0:0:0:0:0:ffff:7f00:1", family: 6 }]
    )).rejects.toThrow(/resolved to 0:0:0:0:0:ffff:7f00:1/);
  });

  it("revalidates redirect destinations before following them", async () => {
    expect(typeof htmlManifest.fetchRemoteAssetSecure).toBe("function");
    let calls = 0;
    await expect(htmlManifest.fetchRemoteAssetSecure("https://93.184.216.34/a.png", {
      transport: async () => {
        calls += 1;
        return { status: 302, headers: { location: "http://127.0.0.1/private.png" }, body: Buffer.alloc(0) };
      }
    })).rejects.toThrow(/blocked destination/);
    expect(calls).toBe(1);
  });

  it("applies one total timeout to DNS resolution and the complete redirect chain", async () => {
    await expect(htmlManifest.fetchRemoteAssetSecure("https://assets.example.com/a.png", {
      timeoutMs: 20,
      resolver: async () => new Promise(() => {})
    })).rejects.toThrow(/total timeout/i);

    let requests = 0;
    await expect(htmlManifest.fetchRemoteAssetSecure("https://assets.example.com/a.png", {
      timeoutMs: 30,
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => {
        requests += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        return { status: 302, headers: { location: `/redirect-${requests}.png` }, body: Buffer.alloc(0) };
      }
    })).rejects.toThrow(/total timeout/i);
    expect(requests).toBeLessThanOrEqual(2);
  });

  it("pins the vetted DNS result into the transport to prevent rebinding", async () => {
    let pinned;
    const body = await htmlManifest.fetchRemoteAssetSecure("https://assets.example.com/a.png", {
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async (_url, options) => {
        pinned = options.address;
        return {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "3" },
          body: Buffer.from("png")
        };
      }
    });
    expect(pinned).toEqual({ address: "93.184.216.34", family: 4 });
    expect(body.toString()).toBe("png");
  });

  it("enforces response content type and maximum bytes", () => {
    expect(typeof htmlManifest.validateRemoteAssetResponse).toBe("function");
    expect(() => htmlManifest.validateRemoteAssetResponse({
      contentType: "text/html", contentLength: 8, body: Buffer.from("notimage")
    })).toThrow(/content type/i);
    expect(() => htmlManifest.validateRemoteAssetResponse({
      contentType: "image/png", contentLength: 11, body: Buffer.alloc(11)
    }, { maxBytes: 10 })).toThrow(/maximum bytes/i);
  });
});

describe("Task 2 browser execution defaults", () => {
  it("disables scripts and network and defines a total timeout", () => {
    expect(browserRuntime.HTML_BROWSER_DEFAULTS).toMatchObject({
      javaScriptEnabled: false,
      networkEnabled: false
    });
    expect(browserRuntime.HTML_BROWSER_DEFAULTS.totalTimeoutMs).toBeGreaterThan(0);
  });

  it("aborts every browser network request by default", async () => {
    expect(typeof browserRuntime.installBrowserSecurity).toBe("function");
    const decisions = [];
    const page = {
      route: async (_pattern, handler) => {
        await handler({ abort: async () => decisions.push("abort"), continue: async () => decisions.push("continue") });
      }
    };
    await browserRuntime.installBrowserSecurity(page);
    expect(decisions).toEqual(["abort"]);
  });
});
