-- Sets the missing duration_default on the virtual_impression_appointment
-- booking type so widget-create-appointment doesn't 400 with
-- no_booking_config when Checkpoint (or any client) tries to book one.
--
-- Background: lng_booking_type_resolve picks duration_default via
-- COALESCE(child_row.duration_default, parent_row.duration_default).
-- Both the parent row (arch IS NULL) and the arch='both' child row were
-- created without a value, so the RPC returned NULL and the edge
-- function threw no_booking_config.
--
-- 30 minutes matches the existing phase config (Video call: 30 min for
-- both arches, 20 min for upper/lower).

update public.lng_booking_type_config
   set duration_default = 30
 where service_type     = 'virtual_impression_appointment'
   and repair_variant is null
   and product_key    is null
   and arch           is null
   and duration_default is null;

-- Same fix for the arch='both' child so the resolver returns a
-- consistent 30-minute block when a patient picks both arches.
update public.lng_booking_type_config
   set duration_default = 30
 where service_type     = 'virtual_impression_appointment'
   and repair_variant is null
   and product_key    is null
   and arch            = 'both'
   and duration_default is null;
