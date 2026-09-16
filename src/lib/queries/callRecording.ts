import { supabase } from '../supabase.ts';

// Fetches a call recording's audio on demand, proxied through the
// get-call-recording edge function so the client never sees a raw
// Twilio URL or credentials. Mirrors callEdgeFunction's session-token
// + 401-retry-once shape, but can't reuse it directly: that helper
// always calls response.json(), and this response body is audio
// bytes, not JSON.
export interface FetchRecordingResult {
  ok: boolean;
  objectUrl?: string;
  error?: string;
  reason?: string;
}

export async function fetchCallRecordingUrl(sessionId: string): Promise<FetchRecordingResult> {
  const projectRef = supabaseProjectRef();
  const url = `https://${projectRef}.functions.supabase.co/get-call-recording`;

  const attempt = async (): Promise<Response> => {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new Error('Not signed in');
    return fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  };

  let response = await attempt();
  if (response.status === 401) {
    await supabase.auth.refreshSession();
    response = await attempt();
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}) as Record<string, unknown>);
    return {
      ok: false,
      error: typeof body.error === 'string' ? body.error : `Could not load the recording (${response.status})`,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    };
  }

  const blob = await response.blob();
  return { ok: true, objectUrl: URL.createObjectURL(blob) };
}

function supabaseProjectRef(): string {
  const url = new URL(import.meta.env.VITE_SUPABASE_URL);
  return url.hostname.split('.')[0]!;
}
