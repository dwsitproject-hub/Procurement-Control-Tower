-- 036 - the Coupa requisition, the hub that ties Coupa to SAP line by line.
--
-- Requested 6 Oct 2026: the Detail Table should show Coupa's own numbers -
-- requisition, PO, sourcing - beside SAP's, so a reader can see the two systems
-- describe the same purchase.
--
-- How a Coupa record reaches an SAP row:
--
--   SAP PO line   <- Coupa PO line   custom field sap-po-no-line-no (006)
--   SAP PR item   <- Coupa PO line   custom field initial-sap-pr-no-line-no (006)
--   Coupa PO      -> Coupa requisition   requisition-header.id        (here)
--   Coupa sourcing event -> Coupa requisition   creatable-from-id     (here)
--
-- The sourcing event's own SAP field, sourcing-ref, is free text - "REPEAT
-- ORDER", "HA/101-103", sometimes a number - and none of its values matched an
-- SAP requisition on the local copy of production (0 of 4,410 filled in). The
-- requisition id is structured and present on every Coupa PO and on 10,168 of
-- 16,683 sourcing events, so it is the join, and sourcing-ref stays what it was.
--
-- Both ids were already in ops.coupa_raw, so the backfill needs no API call.

ALTER TABLE ops.coupa_po_line ADD COLUMN IF NOT EXISTS requisition_id bigint;
ALTER TABLE ops.coupa_sourcing_event ADD COLUMN IF NOT EXISTS requisition_id bigint;
-- "Standard" / "Repeat Order": how the event was run, which event_type ('rfq')
-- does not say.
ALTER TABLE ops.coupa_sourcing_event ADD COLUMN IF NOT EXISTS event_category text;

UPDATE ops.coupa_po_line l
   SET requisition_id = NULLIF(r.payload->'requisition-header'->>'id', '')::bigint
  FROM ops.coupa_raw r
 WHERE r.object = 'purchase_orders' AND r.coupa_id = l.coupa_po_id
   AND l.requisition_id IS NULL
   AND (r.payload->'requisition-header'->>'id') ~ '^[0-9]+$';

UPDATE ops.coupa_sourcing_event e
   SET requisition_id = CASE
         WHEN r.payload->>'creatable-from-type' = 'RequisitionHeader'
          AND (r.payload->>'creatable-from-id') ~ '^[0-9]+$'
         THEN (r.payload->>'creatable-from-id')::bigint END,
       event_category = NULLIF(r.payload->'custom-fields'->>'event-category', '')
  FROM ops.coupa_raw r
 WHERE r.object = 'quote_requests' AND r.coupa_id = e.id;

CREATE INDEX IF NOT EXISTS ix_coupa_pol_req ON ops.coupa_po_line (requisition_id);
CREATE INDEX IF NOT EXISTS ix_coupa_pol_sap_pr ON ops.coupa_po_line (sap_pr_no, sap_pr_item);
CREATE INDEX IF NOT EXISTS ix_coupa_event_req ON ops.coupa_sourcing_event (requisition_id);
