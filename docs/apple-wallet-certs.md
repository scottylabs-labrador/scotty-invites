# Apple Wallet certificates

The `.pkpass` bundle is built to the structure described in Apple's archived Wallet Developer
Guide, but it has never been validated against an actual device. It cannot be **signed** without a
Pass Type ID certificate, which requires a paid Apple Developer Program membership ScottyLabs does
not currently hold. Until then `/tickets` shows "Apple Wallet — coming soon" and the endpoint
returns a 503.

This is what to do the day the account exists.

A note on sourcing: Apple's current documentation site is JavaScript-rendered and could not be
fetched while this was written, so a few statements below are marked **unconfirmed**. They are
consistent with how pass signing works and with third-party tooling, but no Apple page was readable
to back them. Where a claim is unconfirmed, the runbook gives you a command that measures the real
answer instead.

## 1. Get the membership

The Apple Developer Program is **$99/year**. An **Organization** membership requires a D-U-N-S
number registered to the legal entity, and apps/passes are listed under that legal entity's name —
so a student org typically enrolls through the university or, failing that, uses an Individual
membership. Nonprofits, educational institutions and government entities may qualify for a fee
waiver: <https://developer.apple.com/support/membership-fee-waiver/>.
Reference: <https://developer.apple.com/support/compare-memberships/>

## 2. Register the Pass Type ID

developer.apple.com → **Certificates, Identifiers & Profiles** → **Identifiers** → **+** →
**Pass Type IDs** → register `pass.org.scottylabs.invite`.

That string must match `APPLE_PASS_TYPE_ID` (defaulted in `apps/backend/src/env.ts:77`). If you
register a different identifier, set the env var to match.

**Unconfirmed:** it is widely reported that `pass.json`'s `passTypeIdentifier` must equal the
certificate's UID exactly, and that a mismatch shows on-device as a generic "invalid data" error
with no further detail. We could not read an Apple page saying so. Match them anyway — there is no
reason to differ — and if you do hit "invalid data", step 9 tells you how to compare the two values
directly.

## 3. Create the CSR — use the CLI path

```bash
openssl req -new -newkey rsa:2048 -nodes \
  -keyout pass-key.pem -out pass.csr \
  -subj "/CN=ScottyLabs Pass/emailAddress=you@andrew.cmu.edu/C=US"
```

`-nodes` is mandatory: **node-forge cannot decrypt an encrypted private key**, so an encrypted
`APPLE_PASS_KEY_PEM` makes every pass request fail. This path hands you an unencrypted PEM key
directly and skips the `.p12` dance entirely.

(The Keychain Access alternative — Certificate Assistant → Request a Certificate From a Certificate
Authority → Saved to disk + Let me specify key pair information, RSA 2048 — works, but then you must
do step 5b.)

## 4. Get the pass certificate

1. Upload `pass.csr` to the Pass Type ID in the developer portal and download `pass.cer`.
2. Convert it: `openssl x509 -inform DER -in pass.cer -out pass-cert.pem`

## 5b. Only if you used Keychain Access

Install `pass.cer`, export the certificate **and its private key** together as `Certificates.p12`,
then:

```bash
openssl pkcs12 -in Certificates.p12 -clcerts -nokeys -out pass-cert.pem
openssl pkcs12 -in Certificates.p12 -nocerts -nodes -out pass-key.pem
```

`-nodes` on the second command is mandatory (see step 3). Add `-legacy` **only** if you are using
Homebrew OpenSSL 3.x; the macOS system `openssl` is LibreSSL, which reads Keychain-exported `.p12`
files natively and **rejects** `-legacy`. Check with `openssl version` before copying either form.

## 6. Get the matching WWDR intermediate

Apple currently publishes several Worldwide Developer Relations intermediates at
<https://www.apple.com/certificateauthority/> — G2, G3, G4, G5, G6 and WWDR MP CA 1 - G1. **That page
does not say which generation signs Pass Type ID certificates, and this was not verifiable at the
time of writing.** Do not guess. Read the issuer off your own certificate and download the
generation that matches:

```bash
openssl x509 -in pass-cert.pem -noout -issuer
```

Download the matching `.cer` from the CA page, convert it, and confirm the subject matches the
issuer above:

```bash
openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem   # substitute your generation
openssl x509 -in wwdr.pem -noout -subject
```

The two strings must name the same generation. If they do not, you downloaded the wrong one and
every pass will fail to verify.

## 7. Read the team ID

```bash
openssl x509 -in pass-cert.pem -noout -subject
```

The `OU` field is the team ID. Set `APPLE_TEAM_ID` to it.

**Unconfirmed:** it is widely reported that this must equal `pass.json`'s `teamIdentifier` or iOS
rejects the pass. We could not read an Apple page saying so. Match them anyway — there is no reason
to differ — and step 9 below tells you how to compare the two values directly.

## 8. Flatten the PEMs and set the environment

`.env` is parsed line-by-line, so every PEM must be **one line with literal `\n` escapes**:

```bash
python3 -c "print(open('pass-cert.pem').read().replace(chr(10), chr(92)+'n'))"
python3 -c "print(open('pass-key.pem').read().replace(chr(10), chr(92)+'n'))"
python3 -c "print(open('wwdr.pem').read().replace(chr(10), chr(92)+'n'))"
```

Set `APPLE_PASS_CERT_PEM`, `APPLE_PASS_KEY_PEM`, `APPLE_WWDR_CERT_PEM` and `APPLE_TEAM_ID` (plus
`APPLE_PASS_TYPE_ID` if you did not use the default) locally and in Railway.

## 9. Verify

The pass route requires a signed-in session, so this needs your own session cookie. Sign in at
`https://invite.scottylabs.org/signin`, then copy the value of the `sl_invites_session` cookie
from your browser's dev tools (Application → Cookies). Without it the route returns
`401 {"error":"unauthorized","message":"Sign in first."}`, which is a missing cookie, not a
certificate problem.

```bash
curl -sS -b "sl_invites_session=<your cookie>" \
  https://invite.scottylabs.org/api/tickets/<ticket-id>/apple.pkpass -o test.pkpass
unzip -l test.pkpass
```

Expect nine entries: `pass.json`, `icon.png`, `icon@2x.png`, `icon@3x.png`, `logo.png`,
`logo@2x.png`, `logo@3x.png`, `manifest.json`, `signature`.

```bash
mkdir t && cd t && unzip ../test.pkpass
openssl smime -verify -in signature -inform DER -content manifest.json -noverify
```

Expect "Verification successful" and the manifest echoed back.

Then AirDrop or email `test.pkpass` to an iPhone and tap it. If you get a generic "invalid data"
error, compare the two identity fields against the certificate before looking anywhere else:

```bash
python3 -c "import json;d=json.load(open('pass.json'));print(d['passTypeIdentifier'], d['teamIdentifier'])"
openssl x509 -in ../pass-cert.pem -noout -subject     # UID = pass type id, OU = team id
```

If the endpoint returns 503 with *"Apple Wallet is misconfigured — … could not be parsed"*, one of
the three PEMs is malformed or the key is encrypted; the backend log carries the parser's own error
under `[wallet] apple pkpass signing failed`.

## 10. Renewal

Pass Type ID certificates are short-lived; **one year is the commonly cited term, but we could not
confirm it against an Apple page** — so read the real date off your own certificate rather than
assuming:

```bash
openssl x509 -in pass-cert.pem -noout -enddate
```

Put a calendar reminder one month before whatever that prints.

**Unconfirmed:** it is widely reported that when the certificate expires, newly generated passes
stop installing while already-installed passes keep working — a silent failure nobody reports. We
could not read an Apple page confirming this behavior either, so treat it as a reason to renew
early rather than a guarantee of what happens if you don't.

## Note on the icon

This bundle ships `icon.png` at 29 × 29 points with @2x and @3x variants, and a logo bounded by the
160 × 50 point maximum. Apple's archived Wallet Developer Guide lists all pass images as optional
per pass style, while third-party pass tooling and Apple's PKPass API documentation describe the
icon as required. **We could not confirm a current, unambiguous Apple statement that a pass without
`icon.png` fails to install.** It is the most likely explanation for a pass that will not install,
and shipping it costs 66 KB, so it ships.

## Out of scope

Pass updates. `webServiceURL` and `authenticationToken` were removed because the `/api/passes` web
service they advertised was never built. Adding push updates later means building that service plus
an APNs credential.
