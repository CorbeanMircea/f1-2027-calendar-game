// Creates the key pair that lets your site send push notifications.
// Run on your own computer:   node tools/generate-vapid.mjs
// It prints what to paste where. The PRIVATE key is a secret: never put it in the website
// files or in git. Only the public key goes into config.js.
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
const b64 = (s) => s; // JWK values are already base64url
const x = Buffer.from(jwk.x, "base64url");
const y = Buffer.from(jwk.y, "base64url");
const publicKey = Buffer.concat([Buffer.from([4]), x, y]).toString("base64url");
const priv = b64(jwk.d);

console.log(`
1) In config.js add this line inside APP_CONFIG (after SUPABASE_PUBLISHABLE_KEY, with a comma):

   VAPID_PUBLIC_KEY: "${publicKey}"

2) In the Supabase dashboard open Edge Functions > Secrets and add these three:

   VAPID_PUBLIC_KEY  = ${publicKey}
   VAPID_PRIVATE_KEY = ${priv}
   VAPID_SUBJECT     = mailto:YOUR-EMAIL-ADDRESS

Keep the private key secret. If it ever leaks, run this tool again and replace all three values
(everyone then simply turns reminders on again).
`);
