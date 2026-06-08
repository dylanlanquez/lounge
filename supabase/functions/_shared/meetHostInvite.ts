// _shared/meetHostInvite.ts
//
// Validation + consumption helpers for one-time Meet host connect
// invites (lng_meet_host_invites). Shared by meet-host-invite (the
// admin create / public validate endpoint) and the token branches of
// meet-auth-init / meet-auth-callback.
//
// All reads/writes here run as service_role (the caller passes an admin
// client), because the remote host completing the flow has no Lounge
// session — the token IS their authorisation.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

export interface ValidInvite {
  id: string;
  oauthClient: string;
  label: string | null;
}

export type InviteCheck =
  | { ok: true; invite: ValidInvite }
  | { ok: false; error: string };

// Validate a raw token: exists, not used, not expired. Does NOT consume.
export async function validateInviteToken(
  admin: SupabaseClient,
  rawToken: string,
): Promise<InviteCheck> {
  const token = (rawToken ?? '').trim();
  if (!token) return { ok: false, error: 'Missing connect token.' };
  const { data } = await admin
    .from('lng_meet_host_invites')
    .select('id, oauth_client, label, expires_at, used_at')
    .eq('token', token)
    .maybeSingle();
  const inv = data as
    | { id: string; oauth_client: string; label: string | null; expires_at: string; used_at: string | null }
    | null;
  if (!inv) return { ok: false, error: 'This connect link is not valid.' };
  if (inv.used_at) return { ok: false, error: 'This connect link has already been used.' };
  if (new Date(inv.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'This connect link has expired. Ask for a new one.' };
  }
  return { ok: true, invite: { id: inv.id, oauthClient: inv.oauth_client, label: inv.label } };
}

// Mark an invite consumed, guarding against a double-redeem race: the
// update only matches while used_at is still null, so two concurrent
// callbacks can't both create a host. Returns true if THIS call claimed
// the invite.
export async function consumeInvite(
  admin: SupabaseClient,
  inviteId: string,
  createdHostId: string,
  usedAtIso: string,
): Promise<boolean> {
  const { data } = await admin
    .from('lng_meet_host_invites')
    .update({ used_at: usedAtIso, created_host_id: createdHostId })
    .eq('id', inviteId)
    .is('used_at', null)
    .select('id');
  return Array.isArray(data) && data.length > 0;
}
