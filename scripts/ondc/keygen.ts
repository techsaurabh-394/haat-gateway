/**
 * npm run ondc:keygen -- --subscriber-id haat.example.in [--ukid k1] [--callback /ondc]
 * Creates ONDC keys and a request_id, writes .ondc/ (git-ignored, mode 0600), and prints the
 * environment variables and the files to host. Nothing is sent anywhere.
 */
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { generateOndcKeys, signRequestId, siteVerificationHtml, subscribeTemplate } from '../../src/ondc/onboarding.ts';

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const subscriberId = arg('subscriber-id');
if (!subscriberId || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(subscriberId)) {
  console.error('usage: npm run ondc:keygen -- --subscriber-id your.domain.in [--ukid k1] [--callback /ondc]');
  process.exit(2);
}
const ukid = arg('ukid', randomUUID())!;
const callback = arg('callback', '/ondc')!;
const requestId = randomUUID();
const keys = generateOndcKeys();
mkdirSync('.ondc', { recursive: true, mode: 0o700 });
const secret = (f: string, body: string) => {
  writeFileSync(`.ondc/${f}`, body);
  chmodSync(`.ondc/${f}`, 0o600);
};
secret('keys.json', JSON.stringify({ subscriberId, ukid, requestId, ...keys }, null, 2));
writeFileSync('.ondc/ondc-site-verification.html', siteVerificationHtml(signRequestId(requestId, keys.signingPrivateKey)));
writeFileSync('.ondc/subscribe.template.json', JSON.stringify(subscribeTemplate({
  subscriberId, uniqueKeyId: ukid, requestId, keys, callbackPath: callback, subscriberPath: '/beckn', domains: ['ONDC:RET10'], cities: ['std:0542'],
}), null, 2));
secret('haat.env', [
  'HAAT_NETWORK=ondc', 'HAAT_ONDC_ENV=preprod', `HAAT_PUBLIC_URL=https://${subscriberId}`,
  `ONDC_SUBSCRIBER_ID=${subscriberId}`, `ONDC_UNIQUE_KEY_ID=${ukid}`, `ONDC_REQUEST_ID=${requestId}`, `ONDC_CALLBACK_PATH=${callback}`,
  `ONDC_SIGNING_PUBLIC_KEY=${keys.signingPublicKey}`, `ONDC_SIGNING_PRIVATE_KEY=${keys.signingPrivateKey}`,
  `ONDC_ENCRYPTION_PUBLIC_KEY=${keys.encryptionPublicKey}`, `ONDC_ENCRYPTION_PRIVATE_KEY=${keys.encryptionPrivateKey}`,
  'ONDC_GATEWAY_URL=FILL_IN (from ONDC after whitelisting)', 'HAAT_ORG_NAME=FILL_IN', 'HAAT_DB=/data/haat.db', '',
].join('\n'));
console.log(`Wrote .ondc/ for ${subscriberId}. Private keys are in .ondc/keys.json and .ondc/haat.env (mode 0600). Never commit them.

Next (see docs/going-live.md):
  1. Get ${subscriberId} whitelisted on the ONDC Network Participant portal.
  2. Deploy Haat at https://${subscriberId} with .ondc/haat.env (it serves /ondc-site-verification.html
     and ${callback}/on_subscribe itself).
  3. Fill the FILL_IN fields of .ondc/subscribe.template.json, check it against ONDC's SwaggerHub spec,
     and send it to the pre-prod /subscribe URL yourself.`);
