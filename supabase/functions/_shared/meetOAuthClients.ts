// _shared/meetOAuthClients.ts
//
// Registry of the Google OAuth apps Lounge can connect Meet hosts
// through. Each Google Workspace org that owns its own users needs its
// own OAuth app (set to "Internal" in that org's Google Cloud console),
// because an Internal app only lets users inside that same org consent.
//
//   • venneir — the original app. Keeps the existing GOOGLE_CLIENT_ID /
//     GOOGLE_CLIENT_SECRET secrets so every already-connected host keeps
//     working byte-for-byte. This is the default.
//   • lanquez — a second app owned by the lanquez.com Workspace, so
//     lanquez.com users (who are external to the Venneir org and get
//     blocked by org_internal) can connect as full hosts.
//
// Adding a third workspace later is just another entry here plus its two
// secrets — no schema change. The redirect URI is shared across apps
// (GOOGLE_REDIRECT_URI); each Google app must register that same URI.
//
// A host row stores which client key minted its tokens (lng_meet_hosts
// .oauth_client) so refresh + re-exchange always use the matching
// client_id / client_secret. Tokens are bound to the app that issued
// them; refreshing a lanquez token with the venneir secret fails.

export interface OAuthClientConfig {
  key: string;
  clientId: string;
  clientSecret: string;
  label: string;
}

// key -> { env var holding the id, env var holding the secret, label }.
const CLIENT_ENV: Record<string, { idVar: string; secretVar: string; label: string }> = {
  venneir: { idVar: 'GOOGLE_CLIENT_ID', secretVar: 'GOOGLE_CLIENT_SECRET', label: 'Venneir' },
  lanquez: { idVar: 'GOOGLE_CLIENT_ID_LANQUEZ', secretVar: 'GOOGLE_CLIENT_SECRET_LANQUEZ', label: 'Lanquez' },
};

// The client used when none is specified, and for every host connected
// before the multi-client feature existed.
export const DEFAULT_OAUTH_CLIENT = 'venneir';

export function isKnownOAuthClient(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(CLIENT_ENV, key);
}

// Resolve a client key to its live credentials. Returns null when the
// key is unknown OR its secrets aren't set yet (e.g. the lanquez app is
// registered in code but its secrets haven't been added to Supabase).
export function resolveOAuthClient(key: string): OAuthClientConfig | null {
  const entry = CLIENT_ENV[key];
  if (!entry) return null;
  const clientId = Deno.env.get(entry.idVar) ?? '';
  const clientSecret = Deno.env.get(entry.secretVar) ?? '';
  if (!clientId || !clientSecret) return null;
  return { key, clientId, clientSecret, label: entry.label };
}

// The workspaces whose secrets are actually configured, for the admin
// "Connect Google account" chooser. An app present in code but missing
// its secrets is omitted so the UI never offers a dead option.
export function listConfiguredOAuthClients(): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  for (const [key, entry] of Object.entries(CLIENT_ENV)) {
    const id = Deno.env.get(entry.idVar) ?? '';
    const secret = Deno.env.get(entry.secretVar) ?? '';
    if (id && secret) out.push({ key, label: entry.label });
  }
  return out;
}
