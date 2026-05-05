// _shared/googleCalendar.ts
//
// Google Calendar API helpers using service-account JWT authentication.
//
// Consumed by:
//   google-meet-create, google-meet-delete,
//   widget-create-appointment, widget-reschedule-booking,
//   widget-cancel-booking
//
// Required Supabase secrets (set via `supabase secrets set`):
//   GOOGLE_CALENDAR_SA_EMAIL      — service account email
//   GOOGLE_CALENDAR_SA_PRIVATE_KEY — PKCS#8 PEM private key (\\n-escaped)
//   GOOGLE_CALENDAR_ID            — target calendar ID (e.g. info@venneir.com)

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const GOOGLE_CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

// base64url-encode a Uint8Array
function b64urlBytes(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// base64url-encode a UTF-8 string
function b64urlStr(str: string): string {
  return b64urlBytes(new TextEncoder().encode(str));
}

// Builds a service-account JWT and exchanges it for a short-lived
// OAuth2 access token scoped to the Calendar API.
export async function getGoogleAccessToken(
  saEmail: string,
  privateKeyPem: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: saEmail,
    scope: GOOGLE_CALENDAR_SCOPE,
    aud: GOOGLE_TOKEN_ENDPOINT,
    exp: now + 3600,
    iat: now,
  };

  const signingInput =
    `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claims))}`;

  // Google's JSON key stores the private key with literal \n sequences.
  // Normalise to real newlines before stripping the PEM envelope.
  const normPem = privateKeyPem.replace(/\\n/g, '\n');
  const pemBody = normPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const derBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    derBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  const jwt = `${signingInput}.${b64urlBytes(new Uint8Array(sigBytes))}`;

  const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Google token exchange failed (${tokenRes.status}): ${text}`);
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  if (!access_token) throw new Error('Google token response missing access_token');
  return access_token;
}

// Creates a Google Calendar event with Google Meet conferencing.
// The appointmentId is used as the idempotency requestId so repeated
// calls for the same appointment don't create duplicate events.
export async function createMeetEvent(opts: {
  accessToken: string;
  calendarId: string;
  appointmentId: string;
  startAt: string; // ISO timestamptz
  endAt: string;   // ISO timestamptz
  summary: string;
}): Promise<{ hangoutLink: string; eventId: string }> {
  const url =
    `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events?conferenceDataVersion=1`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      summary: opts.summary,
      start: { dateTime: opts.startAt, timeZone: 'Europe/London' },
      end: { dateTime: opts.endAt, timeZone: 'Europe/London' },
      conferenceData: {
        createRequest: {
          requestId: opts.appointmentId,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Calendar event create failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { id: string; hangoutLink?: string };
  if (!data.hangoutLink) {
    throw new Error(
      'Calendar event created but hangoutLink absent — confirm Google Meet is enabled for this calendar.',
    );
  }
  return { hangoutLink: data.hangoutLink, eventId: data.id };
}

// Deletes a Google Calendar event. 404 / 410 (already deleted) are
// treated as success so the function is safe to call idempotently.
export async function deleteMeetEvent(opts: {
  accessToken: string;
  calendarId: string;
  eventId: string;
}): Promise<void> {
  const url =
    `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.eventId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const text = await res.text();
    throw new Error(`Calendar event delete failed (${res.status}): ${text}`);
  }
}
