import { createHash } from "node:crypto";
import { passAssets } from "./assets";
import { fmtShortDate, fmtTimeWithZone } from "../format";
import type { PassRow } from "./row";

export interface PassConfig {
  passTypeId: string;
  teamId: string;
}

/** The pass.json body. Pure — no env, no database. */
export function buildPassJson(row: PassRow, cfg: PassConfig): Record<string, unknown> {
  // The single dark-mode predicate — identical in google-pass.ts and in
  // TicketsPage.tsx:15, so all three renderings of one event agree.
  const dark = row.event.passStyle !== "light";
  return {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeId,
    teamIdentifier: cfg.teamId,
    organizationName: "ScottyLabs",
    serialNumber: row.ticket.serial,
    description: `Scotty Invite — ${row.event.title}`,
    logoText: "Scotty invite",
    foregroundColor: dark ? "rgb(255,255,255)" : "rgb(30,30,30)",
    backgroundColor: dark ? "rgb(10,10,10)" : "rgb(255,255,255)",
    labelColor: dark ? "rgb(158,177,194)" : "rgb(95,111,127)",
    barcodes: [
      {
        format: "PKBarcodeFormatQR",
        message: row.ticket.serial,
        messageEncoding: "iso-8859-1",
        altText: row.ticket.serial,
      },
    ],
    relevantDate: row.event.startAt.toISOString(),
    eventTicket: {
      headerFields: [{ key: "num", label: "Nº", value: String(row.ticket.number).padStart(3, "0") }],
      primaryFields: [{ key: "event", label: row.committee.name.toUpperCase(), value: row.event.title }],
      secondaryFields: [
        { key: "date", label: "DATE", value: fmtShortDate(row.event.startAt) },
        { key: "doors", label: "DOORS", value: fmtTimeWithZone(row.event.startAt) },
      ],
      auxiliaryFields: [
        { key: "loc", label: "LOCATION", value: row.event.location },
        {
          key: "guest",
          label: "GUEST",
          value: (row.user.name ?? row.user.email) + (row.ticket.kind === "plus_one" ? " +1" : ""),
        },
      ],
      backFields: [
        { key: "serial", label: "Serial", value: row.ticket.serial },
        { key: "contact", label: "Questions?", value: row.event.contactEmail },
      ],
    },
  };
}

/**
 * Everything the manifest must hash. Order matters only for the test's sake.
 * manifest.json and signature are deliberately NOT here — they are appended at
 * zip time, and the manifest never hashes itself.
 */
export function bundleEntries(passJson: Record<string, unknown>): { name: string; data: Buffer }[] {
  return [{ name: "pass.json", data: Buffer.from(JSON.stringify(passJson)) }, ...passAssets()];
}

/** SHA-1 per entry, hex, exactly as Wallet recomputes it on open. */
export function manifestFor(entries: { name: string; data: Buffer }[]): Record<string, string> {
  const manifest: Record<string, string> = {};
  for (const entry of entries) manifest[entry.name] = createHash("sha1").update(entry.data).digest("hex");
  return manifest;
}

/**
 * Detached PKCS#7 signature over the manifest, with the WWDR intermediate
 * included. node-forge is imported lazily so the dependency is only touched
 * when certificates exist. Returns null when a PEM cannot be parsed — the
 * caller turns that into an actionable 503 rather than letting forge's DER
 * error surface as a generic 500.
 */
export async function signManifest(
  manifest: Buffer,
  pem: { cert: string; key: string; wwdr: string },
): Promise<Buffer | null> {
  try {
    const forge = await import("node-forge");
    const p7 = forge.default.pkcs7.createSignedData();
    p7.content = forge.default.util.createBuffer(manifest.toString("binary"));
    const cert = forge.default.pki.certificateFromPem(pem.cert.replace(/\\n/g, "\n"));
    const key = forge.default.pki.privateKeyFromPem(pem.key.replace(/\\n/g, "\n"));
    const wwdr = forge.default.pki.certificateFromPem(pem.wwdr.replace(/\\n/g, "\n"));
    p7.addCertificate(wwdr);
    p7.addCertificate(cert);
    p7.addSigner({
      key,
      certificate: cert,
      digestAlgorithm: forge.default.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.default.pki.oids.contentType, value: forge.default.pki.oids.data },
        { type: forge.default.pki.oids.messageDigest },
        { type: forge.default.pki.oids.signingTime, value: new Date() as unknown as string },
      ],
    });
    p7.sign({ detached: true });
    return Buffer.from(forge.default.asn1.toDer(p7.toAsn1()).getBytes(), "binary");
  } catch (err) {
    console.error("[wallet] apple pkpass signing failed", err);
    return null;
  }
}
