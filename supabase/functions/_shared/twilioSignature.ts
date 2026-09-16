// Twilio request signature verification (X-Twilio-Signature), shared
// by every public webhook Twilio calls directly (twilio-voice-twiml,
// twilio-voice-status). Neither of the earlier twilio-sms-status /
// twilio-message-status functions verify this header at all — they
// rely on the project's unguessable subdomain, which their own
// comments call out as an accepted, lesser risk for a non-secret
// delivery-status ping. The voice functions place and bridge real
// phone calls, a materially bigger blast radius, so signature
// verification here is not optional.
//
// Algorithm (Twilio's documented scheme, HMAC-SHA1, distinct from the
// HMAC-SHA256-hex pattern this codebase already uses for Stripe):
//   1. Take the exact public URL Twilio was configured to POST to.
//   2. Sort the POST form params lexicographically by key.
//   3. Concatenate key+value for each, in that order, onto the URL.
//   4. HMAC-SHA1 sign that string with the Twilio Auth Token.
//   5. Base64-encode the raw signature and compare to the header.
//
// https://www.twilio.com/docs/usage/webhooks/webhooks-security

export async function verifyTwilioSignature(args: {
  url: string;
  authToken: string;
  formParams: URLSearchParams;
  signatureHeader: string | null;
}): Promise<boolean> {
  if (!args.signatureHeader) return false;

  const sortedKeys = Array.from(new Set(args.formParams.keys())).sort();
  let data = args.url;
  for (const key of sortedKeys) {
    data += key + (args.formParams.get(key) ?? '');
  }

  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(args.authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return computed === args.signatureHeader;
}
