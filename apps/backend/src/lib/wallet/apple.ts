import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../../db/client";
import { env } from "../../env";
import { buildZip } from "./zip";
import { fmtShortDate, fmtTimeWithZone } from "../format";

/**
 * Signed .pkpass generation (pass type pass.org.scottylabs.invite). Activates
 * when APPLE_PASS_CERT_PEM / APPLE_PASS_KEY_PEM / APPLE_WWDR_CERT_PEM /
 * APPLE_TEAM_ID are configured; PKCS#7 signing uses node-forge, imported
 * lazily so the dependency is only touched when certs exist.
 */
export async function buildPkpass(
  ticketId: string,
  userId: string,
): Promise<{ ok: true; buffer: Buffer; filename: string } | { ok: false; status: 404 | 503; message: string }> {
  if (!env.applePassCert || !env.applePassKey || !env.appleWwdrCert || !env.appleTeamId) {
    return {
      ok: false,
      status: 503,
      message:
        "Apple Wallet passes aren't configured yet — set APPLE_PASS_CERT_PEM, APPLE_PASS_KEY_PEM, APPLE_WWDR_CERT_PEM and APPLE_TEAM_ID.",
    };
  }

  const rows = await db
    .select({ ticket: schema.tickets, event: schema.events, user: schema.users, committee: schema.committees })
    .from(schema.tickets)
    .innerJoin(schema.events, eq(schema.tickets.eventId, schema.events.id))
    .innerJoin(schema.users, eq(schema.tickets.userId, schema.users.id))
    .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
    .where(and(eq(schema.tickets.id, ticketId), eq(schema.tickets.userId, userId), isNull(schema.tickets.revokedAt)));
  const row = rows[0];
  if (!row) return { ok: false, status: 404, message: "Ticket not found" };

  const dark = row.event.passStyle === "dark";
  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: env.applePassTypeId,
    teamIdentifier: env.appleTeamId,
    organizationName: "ScottyLabs",
    serialNumber: row.ticket.serial,
    description: `Scotty Invite — ${row.event.title}`,
    logoText: "Scotty invite",
    foregroundColor: dark ? "rgb(255,255,255)" : "rgb(30,30,30)",
    backgroundColor: dark ? "rgb(10,10,10)" : "rgb(255,255,255)",
    labelColor: dark ? "rgb(158,177,194)" : "rgb(95,111,127)",
    webServiceURL: `${env.apiUrl}/api/passes`,
    authenticationToken: createHash("sha256").update(`${env.transferLinkSecret}:${row.ticket.id}`).digest("hex").slice(0, 32),
    barcodes: [{ format: "PKBarcodeFormatQR", message: row.ticket.serial, messageEncoding: "iso-8859-1", altText: row.ticket.serial }],
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
        { key: "guest", label: "GUEST", value: (row.user.name ?? row.user.email) + (row.ticket.kind === "plus_one" ? " +1" : "") },
      ],
      backFields: [
        { key: "serial", label: "Serial", value: row.ticket.serial },
        { key: "contact", label: "Questions?", value: row.event.contactEmail },
      ],
    },
  };

  const files: { name: string; data: Buffer }[] = [{ name: "pass.json", data: Buffer.from(JSON.stringify(passJson)) }];

  const manifest: Record<string, string> = {};
  for (const f of files) manifest[f.name] = createHash("sha1").update(f.data).digest("hex");
  const manifestBuf = Buffer.from(JSON.stringify(manifest));

  const forge = await import("node-forge");
  const p7 = forge.default.pkcs7.createSignedData();
  p7.content = forge.default.util.createBuffer(manifestBuf.toString("binary"));
  const cert = forge.default.pki.certificateFromPem(env.applePassCert.replace(/\\n/g, "\n"));
  const key = forge.default.pki.privateKeyFromPem(env.applePassKey.replace(/\\n/g, "\n"));
  const wwdr = forge.default.pki.certificateFromPem(env.appleWwdrCert.replace(/\\n/g, "\n"));
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
  const signature = Buffer.from(forge.default.asn1.toDer(p7.toAsn1()).getBytes(), "binary");

  const zip = buildZip([...files, { name: "manifest.json", data: manifestBuf }, { name: "signature", data: signature }]);
  return { ok: true, buffer: zip, filename: `${row.ticket.serial}.pkpass` };
}
