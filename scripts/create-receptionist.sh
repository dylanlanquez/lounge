#!/bin/zsh
# Create a receptionist account for Meridian.
#
# Usage:
#   /Users/dylan/Desktop/lounge-app/scripts/create-receptionist.sh \
#     info@venneir.com 123456
#
# Creates:
#   - auth.users row with the given email and bcrypt-hashed password
#   - public.accounts row linking auth_user_id to a Lounge identity
#   - public.location_members row with lab_role = 'receptionist' against
#     the first lab location it can find (typically Motherwell)

set -e
source ~/.zshrc

PSQL="/opt/homebrew/opt/libpq/bin/psql"
EMAIL="${1:-}"
PASSWORD="${2:-}"

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Usage: $0 <email> <password>"
  echo "Example: $0 info@venneir.com 123456"
  exit 1
fi

echo "Creating receptionist account on MERIDIAN PRODUCTION"
echo "  email:    $EMAIL"
echo "  password: ${#PASSWORD} characters (not printed)"
echo ""

"$PSQL" "$LNG_MERIDIAN_DB_URL" <<SQL
DO \$\$
DECLARE
  v_user_id uuid;
  v_account_id uuid;
  v_location_id uuid;
BEGIN
  -- 1. Auth user. Idempotent on email.
  SELECT id INTO v_user_id FROM auth.users WHERE email = '$EMAIL';
  IF v_user_id IS NULL THEN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, email_change,
      email_change_token_new, recovery_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      gen_random_uuid(),
      'authenticated', 'authenticated',
      '$EMAIL',
      crypt('$PASSWORD', gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb,
      now(), now(), '', '', '', ''
    ) RETURNING id INTO v_user_id;
    INSERT INTO auth.identities (
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', '$EMAIL'),
      'email', '$EMAIL', now(), now(), now()
    );
    RAISE NOTICE '[ok] auth.users created: %', v_user_id;
  ELSE
    UPDATE auth.users SET encrypted_password = crypt('$PASSWORD', gen_salt('bf')) WHERE id = v_user_id;
    RAISE NOTICE '[ok] auth.users password reset: %', v_user_id;
  END IF;

  -- 2. accounts row
  SELECT id INTO v_account_id FROM public.accounts WHERE auth_user_id = v_user_id;
  IF v_account_id IS NULL THEN
    INSERT INTO public.accounts (auth_user_id, login_email, account_type, member_type, status)
    VALUES (v_user_id, '$EMAIL', 'internal', 'lab_team_member', 'active')
    RETURNING id INTO v_account_id;
    RAISE NOTICE '[ok] accounts created: %', v_account_id;
  ELSE
    RAISE NOTICE '[ok] accounts existed: %', v_account_id;
  END IF;

  -- 3. Find the first Venneir lab location
  SELECT id INTO v_location_id
    FROM public.locations
    WHERE type = 'lab' AND is_venneir = true
    ORDER BY name
    LIMIT 1;
  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'No Venneir lab location found. Create one before adding receptionists.';
  END IF;

  -- 4. location_members row with receptionist role
  IF NOT EXISTS (
    SELECT 1 FROM public.location_members
    WHERE account_id = v_account_id AND location_id = v_location_id AND lab_role = 'receptionist'
  ) THEN
    INSERT INTO public.location_members (
      account_id, location_id, lab_role,
      messaging_access, access_invoices, can_submit_cases, view_cases_only, can_approve_cad,
      joined_at
    ) VALUES (
      v_account_id, v_location_id, 'receptionist',
      true, true, false, false, false,
      now()
    );
    RAISE NOTICE '[ok] location_members (receptionist) created against location %', v_location_id;
  ELSE
    RAISE NOTICE '[ok] location_members already had receptionist role at %', v_location_id;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE 'DONE. Sign in at https://lounge-coral.vercel.app with:';
  RAISE NOTICE '  email:    $EMAIL';
  RAISE NOTICE '  password: <the one you set>';
END \$\$;
SQL

echo ""
echo "Account ready."
