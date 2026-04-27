# Calendly API reference (scraped from developer.calendly.com)

Compiled from `developer.calendly.com` and the Stoplight docs on 27 Apr 2026. The Calendly developer site is a JS-rendered SPA so deep endpoint pages do not render to plain HTTP fetches; this doc captures everything that is server-rendered or recoverable from indexed content, plus the live endpoints already in use by Checkpoint's `get-calendly` and `sync-calendly` edge functions.

Treat this as a working snapshot. The live source of truth is:
- Developer portal: <https://developer.calendly.com>
- Stoplight reference: <https://calendly.stoplight.io/docs/api-docs>
- API base URL: `https://api.calendly.com`
- Auth host: `https://auth.calendly.com`

---

## 1. Overview

> "REST-based and has predictable resource-oriented URLs. It uses JSON for request and response bodies and standard HTTP methods, authentication, and response codes."

- API version: v2
- Base URL: `https://api.calendly.com`
- Format: JSON for both request and response bodies
- Auth: bearer token in `Authorization` header
- v1 is deprecated . see the v1 → v2 migration guide

---

## 2. Authentication

Calendly v2 supports two auth methods. Pick one based on who uses your integration:

| Method | When to use |
|---|---|
| Personal access token | Internal apps used only by your team. Single-account scope. Good for testing, internal dashboards, CRM ingest. |
| OAuth 2.1 with PKCE | Public apps where each Calendly user authorises individually. Multi-account scope. Required for any app distributed to external users. |

### 2a. Personal access tokens

Source: <https://developer.calendly.com/personal-access-tokens>

**Create:**
1. Sign in at calendly.com.
2. Integrations → API & Webhooks tile.
3. "Get a token now" (first time) or "Generate new token" (subsequent).
4. Name the token, click Create Token, copy it.

**Critical storage warning (verbatim from the docs):**

> "Do not share your personal access token with public sources or reuse it across applications."
>
> "We do not display or store them in your Calendly account. After generation, they're unretrievable."

So copy the token at creation time. There's no recovery path if lost . only revoke + reissue.

**Header format used in API calls:**

```
Authorization: Bearer <token>
Content-Type: application/json
```

Confirmed by Checkpoint's edge functions (`get-calendly/index.ts` line 11; `sync-calendly/index.ts` line 11).

**Scopes on personal tokens:** the token creation flow asks you to pick the scopes the token may use. Tokens issued before the scoped-permissions migration retain full API access by default and are auto-migrated when refreshed.

### 2b. OAuth 2.1 with PKCE

Source: <https://developer.calendly.com/creating-an-oauth-app>

**App registration:**
1. Sign up for a Calendly developer account (GitHub or Google sign-in).
2. Create a new OAuth application with:
   - Application name
   - Application type (web or native)
   - Environment: Sandbox or Production
   - Redirect URI
   - Required scopes
3. On creation you receive: **Client ID**, **Client Secret**, **Webhook signing key** (the signing key is shown ONCE . store it immediately).

**Redirect URI rules:**
- Sandbox: HTTP allowed only against `localhost`. Example: `http://localhost:1234`.
- Production: HTTPS required.

**PKCE is mandatory for both web and native apps.** From the docs:

> "For all OAuth applications (web or native) use a specific redirect_uri, a Proof Key for Code Exchange (PKCE), and S256 for code_challenge_method."

**Authorization endpoint:**

```
GET https://auth.calendly.com/oauth/authorize
  ?client_id=<CLIENT_ID>
  &response_type=code
  &redirect_uri=<REDIRECT_URI>
  &code_challenge_method=S256
  &code_challenge=<CODE_CHALLENGE>
```

User signs in, approves the requested scopes, and is redirected to your `redirect_uri` with `?code=...`.

**Token endpoint:**

```
POST https://auth.calendly.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<AUTH_CODE>
&redirect_uri=<REDIRECT_URI>
&client_id=<CLIENT_ID>
&code_verifier=<PKCE_VERIFIER>
```

(Plus `client_secret` for confidential web apps.)

Response:

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "token_type": "Bearer",
  "expires_in": 7200,
  "scope": "users:read scheduled_events:read ..."
}
```

### 2c. Refresh token rotation

Source: <https://developer.calendly.com/refresh-token-rotation-guide>

**Refresh tokens are single-use.** Every successful refresh returns a NEW refresh token; the old one is invalidated immediately.

**Refresh request:**

```
POST https://auth.calendly.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<CURRENT_REFRESH_TOKEN>
&client_id=<CLIENT_ID>
```

**On success:** persist the NEW `refresh_token` from the response immediately. Do not retain the old one.

**On failure:** HTTP 400 or 401 with `{"error": "invalid_grant", "error_description": "authorization grant is invalid, expired, or revoked."}`. The doc's recommendation:

> "clear tokens and ask the user to re-authorize instead of retrying endlessly"

So treat a refresh failure as a hard logout. Do not retry the same refresh token.

### 2d. What revokes a token

From the FAQ:
- Login email change
- Password change
- Login method change (e.g. switching from password to SSO)
- Manual revocation (both OAuth and personal access tokens can be revoked from the user's settings)

---

## 3. Scopes

Source: <https://developer.calendly.com/scopes>

**Hierarchy rule** (verbatim):

> "A `:write` scope implicitly includes the corresponding `:read` scope within the same domain."

So requesting `event_types:write` automatically grants `event_types:read`. Don't request both.

**Webhooks rule:** `webhooks:write` is required to create subscriptions, but the corresponding **read scopes for the events you subscribe to are also required** to receive payloads. e.g. an `invitee.created` subscription needs `webhooks:write` plus `scheduled_events:read`.

### Scope catalogue

#### Scheduling

| Scope | Grants |
|---|---|
| `availability:read` | Retrieve user and event-type availability (busy times, availability schedules). |
| `availability:write` | Update event type availability via PATCH. |
| `event_types:read` | Retrieve event type details and available times, including memberships. |
| `event_types:write` | Create or update event types. |
| `locations:read` | Retrieve configured meeting locations. |
| `routing_forms:read` | Retrieve routing forms and submissions. |
| `shares:write` | Create and customise a single-use scheduling link from an existing event type. |
| `scheduled_events:read` | Retrieve scheduled events and event invitee information, including no-show data. |
| `scheduled_events:write` | Create event invitees, cancel events, mark invitees as no-show. |
| `scheduling_links:write` | Create a single-use scheduling link from an existing event type without customisation. |

#### User management

| Scope | Grants |
|---|---|
| `groups:read` | Retrieve group details and relationships. |
| `organizations:read` | Retrieve organization data, memberships, and invitations. |
| `organizations:write` | Invite or remove users from an organization. |
| `users:read` | Retrieve user information. |

#### Webhooks

| Scope | Grants |
|---|---|
| `webhooks:read` | Retrieve webhook subscriptions and sample payloads. |
| `webhooks:write` | Create or delete webhook subscriptions. |

#### Security and compliance

| Scope | Grants |
|---|---|
| `activity_log:read` | View organization activity (Enterprise only). |
| `data_compliance:write` | Delete invitee or event data (Enterprise only). |
| `outgoing_communications:read` | Retrieve a list of outgoing SMS and email communications. |

---

## 4. URL conventions

| Concept | Value |
|---|---|
| Base URL | `https://api.calendly.com` |
| Auth host | `https://auth.calendly.com` |
| Resource URIs | Returned as full URLs in the response (e.g. `https://api.calendly.com/users/abc-123`). Use them as opaque identifiers . don't string-parse the UUID out unless the docs explicitly say so. |
| URI format in queries | When you need to pass a user / org / event reference, pass the URL-encoded full URI (e.g. `?user=https%3A%2F%2Fapi.calendly.com%2Fusers%2Fabc-123`). |
| Time format | ISO 8601 with timezone (e.g. `2026-04-27T14:00:00.000000Z`). |
| Boolean params | `true` / `false` strings. |

---

## 5. Rate limits

Source: per-page note + community confirmations.

| Plan | Limit |
|---|---|
| Free, Standard, Teams | **60 requests / minute** |
| Enterprise | **120 requests / minute** |

**Response headers on every API response:**

| Header | Meaning |
|---|---|
| `X-RateLimit-Limit` | The cap for your account (60 or 120). |
| `X-RateLimit-Remaining` | Calls left in the current window. |
| `X-RateLimit-Reset` | Unix timestamp when the window resets. |

**On 429:** the response includes a `Retry-After` header (seconds). Honor it before retrying.

**Practical guidance:** for batch jobs, sleep ~1 second between calls. The community has reported that bursts above 60/min on non-Enterprise plans return 429 reliably.

---

## 6. Pagination

Endpoints that return collections (e.g. `/scheduled_events`) use cursor pagination.

```json
{
  "collection": [ /* ... */ ],
  "pagination": {
    "count": 100,
    "next_page_token": "eyJ...",
    "next_page": "https://api.calendly.com/scheduled_events?...&page_token=eyJ...",
    "previous_page_token": null,
    "previous_page": null
  }
}
```

**Use:**
- `count` query param: max **100** per page.
- `page_token` query param: pass the `next_page_token` from the previous response.
- `next_page` is the fully-formed URL . easier than re-building the query.

When `next_page_token` is null, you're done.

---

## 7. Endpoint catalogue

Calendly groups its endpoints under the resources below. Every endpoint requires a Bearer token; required scopes are noted on the live docs page for each one.

> Live, definitive reference: <https://calendly.stoplight.io/docs/api-docs>

### Users

| Method | Path | Notes |
|---|---|---|
| `GET` | `/users/me` | Returns the user the current token belongs to. Returns the user URI, name, email, scheduling URL, timezone, current organization URI. |
| `GET` | `/users/{uuid}` | Get user by UUID. |

Required scope: `users:read`.

Confirmed in use: `get-calendly/index.ts:85` calls `https://api.calendly.com/users/me` to resolve the connected account.

### Organizations and memberships

| Method | Path | Notes |
|---|---|---|
| `GET` | `/organizations/{uuid}` | Org details. |
| `GET` | `/organization_memberships` | List members of an org. Filter by `organization`, `user`, `email`. Required for the multi-user case. |
| `GET` | `/organization_memberships/{uuid}` | Single membership. |
| `DELETE` | `/organization_memberships/{uuid}` | Remove a user from an organization. Requires `organizations:write`. |
| `POST` | `/organizations/{uuid}/invitations` | Invite a user. Requires `organizations:write`. |
| `GET` | `/organizations/{uuid}/invitations` | List org invitations. |
| `DELETE` | `/organizations/{uuid}/invitations/{invitation_uuid}` | Revoke a pending invitation. |

Required scope: `organizations:read` for GET, `organizations:write` for DELETE/POST.

### Event types

| Method | Path | Notes |
|---|---|---|
| `GET` | `/event_types` | List event types. Filter by `user` (URI), `organization` (URI), `active=true`, `count`, `page_token`, `sort`. |
| `GET` | `/event_types/{uuid}` | Single event type. |
| `POST` | `/event_types` | Create an event type. Requires `event_types:write`. |
| `PATCH` | `/event_types/{uuid}` | Update an event type. |
| `DELETE` | `/event_types/{uuid}` | Delete an event type. |
| `GET` | `/event_type_available_times` | Available booking slots for an event type. Pass `event_type` (URI) + `start_time` + `end_time` (ISO 8601). |

Required scopes: `event_types:read` for GET, `event_types:write` for POST/PATCH/DELETE.

Confirmed in use: `get-calendly/index.ts:127` calls `https://api.calendly.com/event_types?user=<URI>&active=true&count=100`.

### Event type availability schedules

| Method | Path | Notes |
|---|---|---|
| `GET` | `/event_types/{uuid}/availability_schedules` | List availability schedules for an event type. |
| `PATCH` | `/event_types/{uuid}/availability_schedules` | Update availability schedules. Requires `availability:write`. |
| `GET` | `/user_availability_schedules` | List the user's availability schedules. |
| `GET` | `/user_availability_schedules/{uuid}` | Single schedule. |
| `GET` | `/user_busy_times` | Get a user's busy times for a window. Required: `user`, `start_time`, `end_time`. |

### Scheduled events

| Method | Path | Notes |
|---|---|---|
| `GET` | `/scheduled_events` | List events. Filter by `user` (URI), `organization` (URI), `min_start_time`, `max_start_time`, `status` (active / canceled), `invitee_email`, `count`, `page_token`, `sort`. |
| `GET` | `/scheduled_events/{uuid}` | Single event. |
| `POST` | `/scheduled_events/{uuid}/cancellation` | Cancel the event. Body: `{ "reason": "..." }`. Requires `scheduled_events:write`. |

Required scopes: `scheduled_events:read` for GET, `scheduled_events:write` for cancel.

Confirmed in use: `get-calendly/index.ts:101` calls `/scheduled_events?user=<URI>&min_start_time=...&max_start_time=...&status=...&count=100`.

### Invitees

| Method | Path | Notes |
|---|---|---|
| `GET` | `/scheduled_events/{event_uuid}/invitees` | List invitees on an event. Filter: `email`, `status`, `count`, `page_token`, `sort`. |
| `GET` | `/scheduled_events/{event_uuid}/invitees/{invitee_uuid}` | Single invitee . names, email, custom-question answers, payment, tracking, cancel/reschedule URLs, no-show status. |
| `POST` | `/invitee_no_shows` | Mark an invitee as a no-show. Body: `{ "invitee": "<INVITEE_URI>" }`. Requires `scheduled_events:write`. |
| `DELETE` | `/invitee_no_shows/{uuid}` | Undo a no-show mark. |

Confirmed in use: `get-calendly/index.ts:22` calls `/scheduled_events/${uuid}/invitees?count=100` per event in batches of 5.

### Scheduling API (new . Q1 2026)

The new Scheduling API lets you book directly via API without redirects, iframes, or Calendly-hosted UI. Ideal for AI assistants, automation tools, and custom portals.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/scheduled_events` | Create an event invitee. Schedules the meeting. Required scope: `scheduled_events:write`. |

See <https://developer.calendly.com/api-docs/p3ghrxrwbl8kqe-create-event-invitee> for the request schema (event type, start_time, invitee details, location override, custom question responses, etc.).

### Single-use scheduling links

| Method | Path | Notes |
|---|---|---|
| `POST` | `/scheduling_links` | Create a single-use scheduling link from an existing event type. |
| `POST` | `/shares` | Create a customised single-use link (questions, location override, etc.). Requires `shares:write`. |

**Single-use link expiry:** "Single use scheduling links (that haven't been used to book an event) expire after 90 days."

### Routing forms

| Method | Path | Notes |
|---|---|---|
| `GET` | `/routing_forms` | List routing forms in an org. |
| `GET` | `/routing_forms/{uuid}` | Single form. |
| `GET` | `/routing_form_submissions` | List submissions. Filter by `form` (URI). |
| `GET` | `/routing_form_submissions/{uuid}` | Single submission. |

Required scope: `routing_forms:read`.

### Webhook subscriptions

| Method | Path | Notes |
|---|---|---|
| `POST` | `/webhook_subscriptions` | Create a subscription. Body: `url`, `events[]`, `organization`, `user` (when scope is `user`), `scope` (`user` or `organization`), `signing_key` (optional, your-side HMAC secret). Requires `webhooks:write`. |
| `GET` | `/webhook_subscriptions` | List subscriptions. Filter by `organization`, `user`, `scope`. |
| `GET` | `/webhook_subscriptions/{uuid}` | Single subscription. |
| `DELETE` | `/webhook_subscriptions/{uuid}` | Delete a subscription. |

### Activity log (Enterprise only)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/activity_log_entries` | Filter by `organization`, `min_occurred_at`, `max_occurred_at`, action types. |

Required scope: `activity_log:read`.

### Data compliance (Enterprise only)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/data_compliance/deletion/invitees` | Bulk-delete invitee data (GDPR / CCPA workflows). |
| `POST` | `/data_compliance/deletion/events` | Bulk-delete scheduled-event data. |

Required scope: `data_compliance:write`.

### Outgoing communications

| Method | Path | Notes |
|---|---|---|
| `GET` | `/outgoing_communications` | List SMS and email comms sent by Calendly on behalf of the org. |

Required scope: `outgoing_communications:read`.

### Groups

| Method | Path | Notes |
|---|---|---|
| `GET` | `/groups` | List groups in an org. |
| `GET` | `/groups/{uuid}` | Single group. |
| `GET` | `/group_relationships` | List group memberships. |

Required scope: `groups:read`.

---

## 8. Webhooks

Source: <https://developer.calendly.com/receive-data-from-scheduled-events-in-real-time-with-webhook-subscriptions>

### Event types

| Event | Fires when |
|---|---|
| `invitee.created` | A new invitee has scheduled an event. |
| `invitee.canceled` | An invitee has cancelled an event. |
| `routing_form_submission.created` | A routing form submission has landed. **Org-scope only** . cannot subscribe at user-scope. |

(Reschedules don't get their own event type. Calendly fires `invitee.canceled` on the original event, then `invitee.created` on the new event. The `rescheduled` field on the `invitee.canceled` payload is `true` so you can match.)

### Subscription scope

| Scope | What it covers |
|---|---|
| `user` | Events on the calling user only. |
| `organization` | Every member of the org. Requires owner or admin role. |

### Plan tier requirement

> "Webhook access is reserved for members on paid premium subscriptions and above."

So Standard, Teams, or Enterprise. Not Free.

### Payload signing

When you create the subscription, set a `signing_key` (a secret you generate on your side) on the body. Calendly signs every delivery with HMAC-SHA256 over the raw body using that key, sent in the `Calendly-Webhook-Signature` header:

```
Calendly-Webhook-Signature: t=<unix-timestamp>,v1=<hmac-sha256-hex>
```

To verify:
1. Parse `t` and `v1` from the header.
2. Reject if `t` is older than 3 minutes (replay protection).
3. Compute `HMAC_SHA256(signing_key, "<t>.<raw_body>")` and constant-time compare to `v1`.

If the signing key was the OAuth app's webhook signing key (shown once at app creation), use that.

### Retries

Calendly retries failed webhook deliveries. Your endpoint must respond `2xx` within 10 seconds. Non-2xx responses or timeouts are queued for redelivery on an exponential backoff. After ~24 hours the delivery is dropped.

### Listing / deleting

```
GET    /webhook_subscriptions?organization=<URI>&scope=organization
GET    /webhook_subscriptions/{uuid}
DELETE /webhook_subscriptions/{uuid}
```

### Sample payload (`invitee.created`)

```json
{
  "event": "invitee.created",
  "created_at": "2026-04-27T14:32:11.000000Z",
  "created_by": "https://api.calendly.com/users/abc-123",
  "payload": {
    "uri": "https://api.calendly.com/scheduled_events/EVT/invitees/INV",
    "email": "patient@example.com",
    "first_name": "John",
    "last_name": "Smith",
    "name": "John Smith",
    "status": "active",
    "timezone": "Europe/London",
    "event": "https://api.calendly.com/scheduled_events/EVT",
    "scheduled_event": {
      "uri": "https://api.calendly.com/scheduled_events/EVT",
      "name": "Consultation",
      "start_time": "2026-04-30T10:00:00.000000Z",
      "end_time":   "2026-04-30T10:30:00.000000Z",
      "event_type": "https://api.calendly.com/event_types/ETY",
      "location": { "type": "google_conference", "join_url": "https://meet.google.com/..." }
    },
    "questions_and_answers": [
      { "question": "Phone number", "answer": "+44...", "position": 0 }
    ],
    "tracking": { "utm_source": "...", "utm_campaign": "..." },
    "cancel_url":     "https://calendly.com/cancellations/...",
    "reschedule_url": "https://calendly.com/reschedulings/..."
  }
}
```

---

## 9. Plan tier requirements

| Capability | Minimum plan |
|---|---|
| GET / POST against any non-Enterprise endpoint | Free |
| Webhooks (any) | Standard |
| Activity log API | Enterprise |
| Data compliance API | Enterprise |
| 120 req/min rate limit | Enterprise (others: 60/min) |

---

## 10. Errors

### Status codes

| Code | Meaning |
|---|---|
| `200` | OK |
| `201` | Created |
| `204` | No Content |
| `400` | Bad request . usually a validation error in the body. |
| `401` | Unauthenticated . token missing, malformed, expired, or revoked. |
| `403` | Forbidden . token lacks required scope OR plan tier doesn't support the endpoint. |
| `404` | Resource not found, OR caller doesn't have access. |
| `409` | Conflict . typically scheduling a time the event type can't accept. |
| `429` | Rate-limited. Honor `Retry-After`. |
| `500`–`504` | Server error. Retry with exponential backoff. |

### Error body

```json
{
  "title": "Invalid Argument",
  "message": "The supplied parameters are invalid.",
  "details": [
    { "parameter": "user", "message": "must be a valid URI" }
  ]
}
```

OAuth errors (from `/oauth/token`) follow RFC 6749:

```json
{
  "error": "invalid_grant",
  "error_description": "authorization grant is invalid, expired, or revoked."
}
```

---

## 11. Migration from v1

v1 is deprecated. <https://developer.calendly.com/how-to-migrate-from-api-v1-to-api-v2>.

Headline differences:
- v1 used an `X-TOKEN` header. v2 uses `Authorization: Bearer`.
- v1 returned numeric IDs. v2 returns URI references (`https://api.calendly.com/.../UUID`).
- v1 webhooks were per-user with limited events. v2 supports org-scope and additional events including routing form submissions.
- v1 had no PKCE / OAuth. v2 makes OAuth + PKCE the public-app default.

---

## 12. How Checkpoint uses the API today

The two edge functions in `supabase/functions/`:

### `get-calendly`
Live read of upcoming + past events. Token: `app_settings.calendly_token` (personal access token).

Calls:
1. `GET /users/me` . resolve the connected user's URI.
2. `GET /scheduled_events?user=<URI>&min_start_time=...&max_start_time=...&status=...&count=100` (paginated via `next_page_token`).
3. `GET /event_types?user=<URI>&active=true&count=100`.
4. For each event in the result: `GET /scheduled_events/{uuid}/invitees?count=100`, batched 5 at a time concurrently.

### `sync-calendly`
Pulls upcoming events into `calendly_bookings` for offline read in the home page widget. Same auth + same endpoints, just persists.

### Storage of the token

`public.app_settings(key='calendly_token', value='<token>')`. Single row, plain text. **Limitations:**
- Personal token, not OAuth . single Calendly account, not per-user.
- No rotation: when the personal token gets revoked (login email change, password change, manual revoke) the integration goes dark with no automatic recovery.
- No audit log of who's reading it.

If you ever move to multi-user OAuth, you'll want a per-account `calendly_oauth_tokens` table with `account_id`, `access_token`, `refresh_token`, `expires_at`, and a refresh job that runs before expiry.

---

## 13. Practical notes

- **Always paginate.** Defaults are 20, max 100. Don't assume a single page covers a real org.
- **Always honor `Retry-After`.** Don't tight-loop on 429.
- **Never trust the URI structure.** Treat URIs as opaque. Calendly has changed UUID formats before.
- **Webhooks: verify the signature on every delivery.** Without it any actor can POST anything to your endpoint.
- **Use the highest scope you actually need, no more.** OAuth users are shown the scope list at consent time and excessive scopes increase abandonment.
- **Sandbox first.** Production OAuth apps require HTTPS; test against sandbox with `localhost` until the flow works end to end.
- **Free plan webhook 401s are silent.** If a webhook subscription stops firing on a Free-plan user, check their plan tier.

---

## 14. Useful links

- <https://developer.calendly.com> . portal
- <https://developer.calendly.com/api-docs> . API reference index
- <https://calendly.stoplight.io/docs/api-docs> . Stoplight reference (more usable for endpoint deep-dives)
- <https://developer.calendly.com/getting-started> . getting started
- <https://developer.calendly.com/authentication> . auth
- <https://developer.calendly.com/personal-access-tokens> . PATs
- <https://developer.calendly.com/creating-an-oauth-app> . OAuth setup
- <https://developer.calendly.com/scopes> . scope catalogue
- <https://developer.calendly.com/refresh-token-rotation-guide> . refresh rotation
- <https://developer.calendly.com/receive-data-from-scheduled-events-in-real-time-with-webhook-subscriptions> . webhook setup
- <https://developer.calendly.com/api-use-cases> . use case index
- <https://developer.calendly.com/release-notes> . release notes
- <https://developer.calendly.com/frequently-asked-questions> . FAQ
- <https://developer.calendly.com/how-to-migrate-from-api-v1-to-api-v2> . v1 → v2 migration
- <https://help.calendly.com/hc/en-us/articles/26595353029271-Calendly-API-overview> . Calendly Help overview
- <https://community.calendly.com/developer-community-60> . community forum

---

*Compiled 27 Apr 2026. Some endpoint listings reconstructed from indexed snippets and existing Checkpoint code because developer.calendly.com is JS-rendered and doesn't serve usable HTML to non-browser clients. Cross-check against Stoplight before relying on any signature here for production code.*
