import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPassJson, bundleEntries, manifestFor, type PassConfig } from "./pass-bundle";
import type { PassRow } from "./row";

const ROW: PassRow = {
  ticket: { id: "6f1c7f7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", serial: "SIT-001-EUGENEO", number: 1, kind: "primary" },
  event: {
    title: "ScottyLabs Fall Kickoff",
    location: "Rashid Auditorium, Gates Hillman Center",
    shortCode: "abcdmnp",
    startAt: new Date("2026-09-11T23:00:00.000Z"),
    endAt: new Date("2026-09-12T02:00:00.000Z"),
    passStyle: "dark",
    contactEmail: "hello@scottylabs.org",
  },
  user: { name: "Eugene O", email: "eugeneo@andrew.cmu.edu" },
  committee: { name: "ScottyLabs" },
};

const CFG: PassConfig = {
  passTypeId: "pass.org.scottylabs.invite",
  teamId: "ABCDE12345",
};

describe("pkpass bundle", () => {
  it("carries the icon and logo images alongside pass.json", () => {
    const names = bundleEntries(buildPassJson(ROW, CFG)).map((e) => e.name);
    expect(names).toEqual([
      "pass.json",
      "icon.png",
      "icon@2x.png",
      "icon@3x.png",
      "logo.png",
      "logo@2x.png",
      "logo@3x.png",
    ]);
  });

  it("ships real PNG bytes for every image entry", () => {
    const images = bundleEntries(buildPassJson(ROW, CFG)).filter((e) => e.name.endsWith(".png"));
    expect(images).toHaveLength(6);
    for (const image of images) {
      expect(Array.from(image.data.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  });

  it("hashes every bundle entry into the manifest", () => {
    const entries = bundleEntries(buildPassJson(ROW, CFG));
    const manifest = manifestFor(entries);
    expect(Object.keys(manifest).sort()).toEqual(entries.map((e) => e.name).sort());
    for (const entry of entries) {
      expect(manifest[entry.name]).toBe(createHash("sha1").update(entry.data).digest("hex"));
    }
  });

  it("identifies the pass with the configured pass type and team", () => {
    const passJson = buildPassJson(ROW, CFG);
    expect(passJson.passTypeIdentifier).toBe("pass.org.scottylabs.invite");
    expect(passJson.teamIdentifier).toBe("ABCDE12345");
    expect(passJson.serialNumber).toBe("SIT-001-EUGENEO");
  });

  it("does not advertise a pass web service, because /api/passes does not exist", () => {
    const passJson = buildPassJson(ROW, CFG);
    expect(passJson.webServiceURL).toBeUndefined();
    expect(passJson.authenticationToken).toBeUndefined();
  });
});
