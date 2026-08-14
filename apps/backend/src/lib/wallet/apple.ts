import { env } from "../../env";
import { loadPassRow } from "./row";
import { bundleEntries, buildPassJson, manifestFor, signManifest } from "./pass-bundle";
import { buildZip } from "./zip";

/**
 * Signed .pkpass generation (pass type pass.org.scottylabs.invite). Activates
 * when APPLE_PASS_CERT_PEM / APPLE_PASS_KEY_PEM / APPLE_WWDR_CERT_PEM /
 * APPLE_TEAM_ID are configured — see docs/apple-wallet-certs.md.
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

  const row = await loadPassRow(ticketId, userId);
  if (!row) return { ok: false, status: 404, message: "Ticket not found" };

  const entries = bundleEntries(
    buildPassJson(row, { passTypeId: env.applePassTypeId, teamId: env.appleTeamId }),
  );
  const manifestBuf = Buffer.from(JSON.stringify(manifestFor(entries)));
  const signature = await signManifest(manifestBuf, {
    cert: env.applePassCert,
    key: env.applePassKey,
    wwdr: env.appleWwdrCert,
  });

  const zip = buildZip([
    ...entries,
    { name: "manifest.json", data: manifestBuf },
    { name: "signature", data: signature },
  ]);
  return { ok: true, buffer: zip, filename: `${row.ticket.serial}.pkpass` };
}
