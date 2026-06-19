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
const GOOGLE_CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

// Converts an absolute instant (UTC ISO timestamptz, e.g. the value
// Supabase returns for `start_at`, or `Date.toISOString()`) into a
// Europe/London *wall-clock* string with NO offset, e.g.
// "2026-06-17T08:15:00".
//
// The Google Calendar API expects `start.dateTime` to be a local time
// paired with `start.timeZone`. When we instead hand it a UTC instant
// (a value ending in `Z` or `+00:00`) AND a timeZone, the offset wins
// for the stored instant but Google's auto-sent invitation email falls
// back to the *account's default timezone* to render the time. That is
// why UK appointments showed up as GMT+3 / EEST in the Google invite:
// the organiser Google account's default timezone is not Europe/London.
// Pinning the dateTime to London wall-clock removes that ambiguity so
// every Google surface renders UK time regardless of account defaults.
export function toLondonLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`toLondonLocalDateTime: invalid ISO timestamp "${iso}"`);
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`toLondonLocalDateTime: missing "${type}" part for "${iso}"`);
    return part.value;
  };
  // Intl can emit "24" for midnight under hour12:false; normalise to "00".
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;
}

// Exchanges a stored OAuth2 refresh token for a short-lived access token.
// Credentials come from Supabase secrets set at deploy time.
export async function getGoogleAccessToken(
  _saEmail: string,
  _privateKeyPem: string,
): Promise<string> {
  const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID') ?? '';
  const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET') ?? '';
  const refreshToken = Deno.env.get('GOOGLE_OAUTH_REFRESH_TOKEN') ?? '';

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google OAuth credentials missing (GOOGLE_OAUTH_CLIENT_ID / SECRET / REFRESH_TOKEN)');
  }

  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token refresh failed (${res.status}): ${text}`);
  }
  const { access_token } = (await res.json()) as { access_token: string };
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
      start: { dateTime: toLondonLocalDateTime(opts.startAt), timeZone: 'Europe/London' },
      end: { dateTime: toLondonLocalDateTime(opts.endAt), timeZone: 'Europe/London' },
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
