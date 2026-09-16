// _shared/twilioVoiceToken.ts
//
// Builds a Twilio Voice Access Token JWT (HS256, hand-rolled with
// native crypto.subtle — no npm:twilio package). Shared by
// twilio-voice-token (the agent's own outbound-call token) and
// twilio-voice-listen-in (an admin's listen-only token), since both
// mint the same JWT shape against the same TwiML Application, just
// with a different identity prefix and (for the listener) no
// meaningful use of the outgoing grant beyond satisfying Twilio's
// schema.
export async function buildVoiceAccessToken(args: {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  appSid: string;
  identity: string;
  ttlSeconds: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { cty: 'twilio-fpa;v=1', typ: 'JWT', alg: 'HS256' };
  const payload = {
    jti: `${args.apiKeySid}-${now}`,
    iss: args.apiKeySid,
    sub: args.accountSid,
    // Twilio's own jsonwebtoken-based AccessToken always stamps iat
    // (jsonwebtoken.sign() adds it by default unless noTimestamp is
    // set) alongside exp computed from that same instant. Omitting
    // it produces a token Twilio's servers reject outright with
    // AccessTokenInvalid (20101) — confirmed by reproducing the
    // exact failure against the real SDK and diffing against the
    // official "twilio" npm package's lib/jwt/AccessToken.js.
    iat: now,
    exp: now + args.ttlSeconds,
    grants: {
      identity: args.identity,
      voice: {
        outgoing: { application_sid: args.appSid },
        incoming: { allow: false },
      },
    },
  };

  const encoder = new TextEncoder();
  const b64url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const headerPart = b64url(encoder.encode(JSON.stringify(header)));
  const payloadPart = b64url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerPart}.${payloadPart}`;

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(args.apiKeySecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(signingInput));
  const signaturePart = b64url(new Uint8Array(sigBuf));

  return `${signingInput}.${signaturePart}`;
}
