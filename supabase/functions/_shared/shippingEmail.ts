// _shared/shippingEmail.ts
//
// Shared shipping notification email sender.
// Used by book-lng-shipment (happy path) and fill-lng-parcel-code
// (deferred send when parcel_code isn't available at booking time).
//
// Callers are responsible for the atomic check-and-set on
// lng_visits.shipping_email_sent_at to prevent duplicate sends.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

type SupabaseAdmin = ReturnType<typeof createClient>;

export interface ShippingEmailCtx {
  visitId:           string;
  patientEmail:      string;
  patientFirstName:  string | null;
  trackingNumber:    string | null;
  parcelCode:        string;           // must be confirmed before calling
  shippingAddress:   {
    name?:    string;
    address1?: string;
    address2?: string;
    city?:    string;
    zip?:     string;
  } | null;
  items:             string[];         // display labels; empty → generic fallback
  dispatchRef:       string;
  resendApiKey:      string;
  resendFrom:        string;
}

export async function sendShippingEmail(
  admin: SupabaseAdmin,
  ctx: ShippingEmailCtx,
): Promise<boolean> {
  const { data: tplRow } = await admin
    .from('lng_email_templates')
    .select('subject, body_syntax, enabled')
    .eq('key', 'visit_shipped')
    .maybeSingle();

  const tpl = tplRow as { subject: string; body_syntax: string; enabled: boolean } | null;
  if (!tpl?.enabled) return false;

  const patientFirstName = ctx.patientFirstName ?? 'there';
  const trackingUrl      = `https://track.dpdlocal.co.uk/parcels/${ctx.parcelCode}#results`;
  const addr = ctx.shippingAddress;
  const addrLines = addr
    ? [addr.name, addr.address1, addr.address2, addr.city, addr.zip].filter(Boolean).join(', ')
    : '';
  const itemsList = ctx.items.length ? ctx.items.join('\n') : 'Your completed dental work';

  const variables: Record<string, string> = {
    patientFirstName,
    trackingNumber:  ctx.trackingNumber ?? '',
    trackingUrl,
    shippingAddress: addrLines,
    itemsList,
    dispatchRef:     ctx.dispatchRef,
  };

  const subject  = substituteVariables(tpl.subject, variables);
  const bodyText = substituteVariables(tpl.body_syntax, variables);
  const html     = simpleHtml(bodyText, patientFirstName);

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${ctx.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    ctx.resendFrom,
      to:      [ctx.patientEmail],
      subject,
      html,
      text: bodyText,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Resend shipping email failed (${res.status}):`, body.slice(0, 200));
    return false;
  }
  return true;
}

function substituteVariables(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}

function simpleHtml(bodyText: string, _name: string): string {
  const paragraphs = bodyText
    .split(/\n\n+/)
    .map((block) => {
      const inner = block
        .split('\n')
        .map((l) => {
          const esc = escapeHtml(l);
          return esc.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        })
        .join('<br>');
      return `<p style="margin:0 0 16px;color:#0E1414;line-height:1.6;">${inner}</p>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F7F6F2;font-family:-apple-system,system-ui,sans-serif;color:#0E1414;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
    <h1 style="margin:0 0 20px;font-size:20px;font-weight:600;color:#0E1414;">Your order is on its way</h1>
    ${paragraphs}
    <p style="margin:32px 0 0;color:#7B8285;font-size:12px;">Venneir Limited · Questions? Reply to this email.</p>
  </div>
</body></html>`;
}
