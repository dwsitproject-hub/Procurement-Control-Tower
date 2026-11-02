-- 041 - register GR movement type 123 (2 Nov 2026).
--
-- The first 123 arrived in a staging GR file. V-R07 blocks any batch with an
-- unregistered movement type, so every scheduled pickup from 24 Oct 2026 on
-- failed and staging stayed on the 23 Oct data.
--
-- SAP's standard meaning: reversal of a return delivery. It cancels a 122 and
-- puts the returned quantity back as received - the mirror of 122. The load
-- reads packages/rules movement.ts; this row keeps the reference table (which
-- V-R07 checks, and Master > Movement types shows) in step with it.

INSERT INTO core.dim_movement_type (movement_type, class, sign_factor, counts_as_receipt, description)
VALUES ('123', 'receipt', 1, true, 'Reversal of return delivery (cancels a 122)')
ON CONFLICT (movement_type) DO UPDATE
  SET class = EXCLUDED.class, sign_factor = EXCLUDED.sign_factor,
      counts_as_receipt = EXCLUDED.counts_as_receipt, description = EXCLUDED.description;
