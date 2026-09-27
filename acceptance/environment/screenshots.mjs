import { mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sha } from "./runtime.mjs";
import { writePrivate } from "./runtime.mjs";
import { requireObservation as need } from "./assertions.mjs";
import { inflateSync } from "node:zlib";

export function imageContent(bytes) {
  need(
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "evidence_missing",
    "ENV12",
    "screenshot-not-png",
  );
  let width, height, channels;
  const chunks = [];
  for (let i = 8; i < bytes.length; ) {
    const n = bytes.readUInt32BE(i),
      kind = bytes.toString("ascii", i + 4, i + 8),
      data = bytes.subarray(i + 8, i + 8 + n);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      need(
        data[8] === 8 && [2, 6].includes(data[9]) && data[12] === 0,
        "evidence_missing",
        "ENV12",
        "unsupported-screenshot-format",
      );
      channels = data[9] === 6 ? 4 : 3;
    }
    if (kind === "IDAT") chunks.push(data);
    i += n + 12;
  }
  need(
    width > 0 && height > 0 && width * height * channels < 128 * 1024 * 1024,
    "evidence_missing",
    "ENV12",
    "screenshot-size-invalid",
  );
  const raw = inflateSync(Buffer.concat(chunks), {
    maxOutputLength: 128 * 1024 * 1024,
  });
  const stride = width * channels;
  let prior = Buffer.alloc(stride),
    offset = 0,
    masked = 0;
  const colors = new Set();
  const paeth = (a, b, c) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[offset++],
      row = Buffer.from(raw.subarray(offset, offset + stride));
    offset += stride;
    need(filter <= 4, "evidence_missing", "ENV12", "screenshot-filter-invalid");
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0,
        b = prior[x],
        c = x >= channels ? prior[x - channels] : 0;
      row[x] =
        (row[x] +
          (filter === 0
            ? 0
            : filter === 1
              ? a
              : filter === 2
                ? b
                : filter === 3
                  ? Math.floor((a + b) / 2)
                  : paeth(a, b, c))) &
        255;
    }
    for (let x = 0; x < stride; x += channels) {
      const color = (row[x] << 16) | (row[x + 1] << 8) | row[x + 2];
      if (color === 0x20252b || color === 0xff00ff) masked++;
      if (colors.size < 256) colors.add(color);
    }
    prior = row;
  }
  const result = {
    width,
    height,
    distinctColorsAtLeast: colors.size,
    maskFraction: masked / (width * height),
  };
  need(
    result.distinctColorsAtLeast >= 16 && result.maskFraction < 0.8,
    "evidence_missing",
    "ENV12",
    "essential-screenshot-unusable",
  );
  return result;
}

export function attachScreenshots(browser, root) {
  browser.page.setDefaultTimeout(15000);
  browser.evidenceRoot = root;
  const directory = join(root, "public-masked");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  browser.screenshot = async (name) => {
    need(
      /^[a-z0-9-]+$/.test(name),
      "evidence_missing",
      "ENV14",
      "invalid-image-name",
    );
    const p = browser.page;
    // Pinned TwoFactorCard puts QRCode and scan hint in this dedicated region.
    // Mask the whole region whether QRCode renders canvas, SVG, or an image.
    const qr = p
      .locator("div.flex.flex-col.items-center.gap-2")
      .filter({ has: p.locator("canvas,svg,img") });
    if (await p.locator("[data-cy=two-factor-setup-code-input]").isVisible())
      need(
        (await qr.count()) === 1 &&
          (await p.locator("input[readonly]").count()) >= 1,
        "evidence_missing",
        "ENV14",
        "secret-mask-region-drift",
      );
    const path = join(directory, name + ".png");
    need(
      !existsSync(path),
      "evidence_missing",
      "ENV14",
      "screenshot-name-reused",
    );
    const canvases = await p.locator("canvas:visible").evaluateAll((es) =>
      es.map((e) => ({
        insideQr: !!e.closest("div.flex.flex-col.items-center.gap-2"),
        decorative:
          e.parentElement === document.body &&
          e.style.position === "fixed" &&
          e.style.width === "100%" &&
          e.style.height === "100%" &&
          e.style.top === "0px" &&
          e.style.left === "0px" &&
          e.style.zIndex === "1000" &&
          e.style.pointerEvents === "none",
      })),
    );
    // js-confetti@0.13.1 creates this exact body-level decorative canvas at module load.
    // Every other visible canvas must be inside the fully masked QR region.
    need(
      canvases.every((c) => c.insideQr || c.decorative),
      "evidence_missing",
      "ENV14",
      "unclassified-visible-canvas",
    );
    const controls = p.locator(
      'input[type=password]:visible,input[readonly]:visible,input[autocomplete=one-time-code]:visible,[data-cy=two-factor-setup-code-input]:visible,img[src^="data:"]:visible',
    );
    const geometry = async (locator) =>
      locator.evaluateAll((es) =>
        es.map((e) => {
          const r = e.getBoundingClientRect();
          return {
            tag: e.tagName,
            slot: e.getAttribute("data-slot"),
            cy: e.getAttribute("data-cy"),
            type: e.getAttribute("type"),
            box: { x: r.x, y: r.y, width: r.width, height: r.height },
          };
        }),
      );
    writePrivate(join(directory, name + "-mask-geometry.json"), {
      viewport: p.viewportSize(),
      qr: await geometry(qr),
      controls: await geometry(controls),
      canvases,
    });
    await p.screenshot({
      path,
      fullPage: true,
      animations: "disabled",
      maskColor: "#20252b",
      mask: [qr, controls],
    });
    chmodSync(path, 0o600);
    const content = imageContent(readFileSync(path));
    return {
      path,
      sha256: sha(readFileSync(path)),
      privacy: "public-masked",
      maskPolicy: "source-backed-qr-region-and-visible-secret-controls",
      content,
    };
  };
  return browser;
}

export async function screenshotRegression(browser, root) {
  const p = browser.page;
  await p.setContent(
    `<html><body style="background:white;color:black"><h1>Mask regression: ordinary content remains visible</h1><p>Independent evaluator screenshot protection</p><div class="flex flex-col items-center gap-2" style="width:100px;height:100px;background:red"><svg width="100" height="100"><rect width="100" height="100" fill="lime"/></svg></div><input readonly value="synthetic-secret"><input data-cy="two-factor-setup-code-input" value="123456"><canvas style="position:fixed;width:100%;height:100%;top:0;left:0;z-index:1000;pointer-events:none"></canvas></body></html>`,
  );
  const receipt = await browser.screenshot("mask-regression");
  const geometry = JSON.parse(
    readFileSync(
      join(root, "public-masked/mask-regression-mask-geometry.json"),
    ),
  );
  need(
    geometry.qr.length === 1 &&
      geometry.controls.length === 2 &&
      geometry.canvases.length === 1 &&
      geometry.canvases[0].decorative,
    "evidence_missing",
    "ENV14",
    "mask-regression-geometry",
  );
  return receipt;
}
