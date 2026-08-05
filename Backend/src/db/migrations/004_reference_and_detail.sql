-- ============================================================================
-- Wave 1 — reference data and the detail-table view.
--
-- v1 carried company names, plant names and material-category rules as
-- hardcoded JavaScript maps. They are real information the dashboard provides,
-- so they move into the database as seeded reference data rather than being
-- lost or re-hardcoded in the frontend.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.dim_company (
  company_code text PRIMARY KEY,   -- 2-letter plant prefix, e.g. 'EU'
  short_code   text NOT NULL,      -- e.g. 'EUP'
  legal_name   text NOT NULL       -- e.g. 'PT.ENERGI UNGGUL PERSADA'
);

ALTER TABLE core.dim_plant ADD COLUMN IF NOT EXISTS area text;

CREATE TABLE IF NOT EXISTS core.dim_material_group (
  material_group text PRIMARY KEY,
  category       text,
  description    text
);

-- Materialised on the facts so a figure reproduces even if the mapping changes.
ALTER TABLE core.fact_pr_item ADD COLUMN IF NOT EXISTS material_category text;
ALTER TABLE core.fact_po_line ADD COLUMN IF NOT EXISTS material_category text;
ALTER TABLE core.fact_pr_item ADD COLUMN IF NOT EXISTS priority_label text;

-- PO Report carries Requirement Urgency, and v1 breaks several PO charts down by
-- priority (sourcing LT by priority, PO approval by priority). The columns were
-- parsed but never persisted on the PO fact.
ALTER TABLE core.fact_po_line ADD COLUMN IF NOT EXISTS urgency smallint;
ALTER TABLE core.fact_po_line ADD COLUMN IF NOT EXISTS priority_label text;

-- Company codes: 2-letter prefix -> short code -> legal name (from v1 CO_MAP / CO_FULL)
INSERT INTO core.dim_company (company_code, short_code, legal_name) VALUES
  ('AS', 'ASI', 'PT.ANUGERAH SUKSES INVESTAMA'),
  ('BM', 'BSM', 'PT.BIOENERGI SEMESTA MAS'),
  ('BN', 'KPBNN', 'PT.KHARISMA PEMASARAN BERSAMA'),
  ('CD', 'CRC', 'PT.CISADANE RAYA CHEMICAL'),
  ('CS', 'CIS', 'PT.CITRA INDAH SENTOSA'),
  ('EO', 'EOP', 'PT.ENERGI OLEO PERSADA'),
  ('EU', 'EUP', 'PT.ENERGI UNGGUL PERSADA'),
  ('GM', 'GLM', 'GULF LUBES MALAYSIA SDN. BHD'),
  ('JP', 'JPN', 'PT.JATI PERKASA NUSANTARA'),
  ('MG', 'MPE', 'PT.MAKSIMA PERKASA ENERGI'),
  ('ND', 'SAGS', 'PT SARANA ANDALAN GEMILANG SEJAHTERA'),
  ('PE', 'PPEI', 'PT.PRAKARSA PALMA ENERGI INTERNUSA'),
  ('PM', 'PMC', 'PT PRIMA MAKMUR CAKRAWALA'),
  ('PS', 'PRC', 'PT.PRIMUS SANUS COOKING OIL INDUSTRIAL'),
  ('RB', 'RSB', 'PT.RIAU SEMESTA BIOMASSA'),
  ('RI', 'RFI', 'PT.ROYAL FOODS INDONESIA'),
  ('SB', 'SB', 'PT.SUMATRA BULKERS'),
  ('SC', 'SPC', 'PT.SUMBER PANGAN CEMERLANG'),
  ('SS', 'SSIM', 'PT. SATU SEJAHTERA INVESTAMA MAKSIMA'),
  ('TP', 'TPG', 'TPG OIL & GAS SDN BHD'),
  ('UI', 'AHUI', 'PT. AGRO HILIR ULTIMA INVESTAMA')
ON CONFLICT (company_code) DO UPDATE SET short_code = EXCLUDED.short_code, legal_name = EXCLUDED.legal_name;

-- Plant names (from v1 PN)
INSERT INTO core.dim_plant (plant, company_code, plant_name) VALUES
  ('AS00', 'AS', 'ASI - HO'),
  ('BM00', 'BM', 'BSM - HO'),
  ('BN00', 'BN', 'KPBNN - HO'),
  ('BN10', 'BN', 'KPBNN - Trading'),
  ('BN90', 'BN', 'KPBNN - HO Proj'),
  ('CD00', 'CD', 'CRC - HO'),
  ('CD10', 'CD', 'CRC - Trading'),
  ('CD21', 'CD', 'CRC - Tangerang'),
  ('CD22', 'CD', 'CRC - Tangerang'),
  ('CD2A', 'CD', 'CRC - Tangerang'),
  ('CD90', 'CD', 'CRC - HO Proj'),
  ('CD91', 'CD', 'CRC - Tangerang'),
  ('CD9A', 'CD', 'CRC - Tangerang'),
  ('CS00', 'CS', 'CIS - HO'),
  ('EO00', 'EO', 'EOP - HO'),
  ('EO10', 'EO', 'EOP - Trading'),
  ('EO21', 'EO', 'EOP - Tanjung Morawa'),
  ('EO22', 'EO', 'EOP - Belawan'),
  ('EO2A', 'EO', 'EOP - Tanjung Morawa'),
  ('EO90', 'EO', 'EOP - HO Proj'),
  ('EO91', 'EO', 'EOP - Tanjung Morawa'),
  ('EO92', 'EO', 'EOP - Belawan'),
  ('EU00', 'EU', 'EUP - HO'),
  ('EU10', 'EU', 'EUP - Trading'),
  ('EU21', 'EU', 'EUP - Lubuk Gaung'),
  ('EU22', 'EU', 'EUP - Bontang'),
  ('EU23', 'EU', 'EUP - Tanjung Pura'),
  ('EU24', 'EU', 'EUP - Kumai'),
  ('EU25', 'EU', 'EUP - Palembang'),
  ('EU26', 'EU', 'EUP - Batam'),
  ('EU27', 'EU', 'EUP - Sintang'),
  ('EU28', 'EU', 'EUP - Merauke'),
  ('EU29', 'EU', 'EUP - Bagendang'),
  ('EU2B', 'EU', 'EUP - Bontang'),
  ('EU2C', 'EU', 'EUP - Tanjung Pura'),
  ('EU2D', 'EU', 'EUP - Bontang'),
  ('EU2E', 'EU', 'EUP - Tanjung Pura'),
  ('EU2Y', 'EU', 'EUP - Paya Pasir'),
  ('EU2Z', 'EU', 'EUP - Bekasi'),
  ('EU31', 'EU', 'EUP - Boven Digoel'),
  ('EU3A', 'EU', 'EUP - Boven Digoel BD'),
  ('EU4B', 'EU', 'EUP - Bontang'),
  ('EU4C', 'EU', 'EUP - Tanjung Pura'),
  ('EU4D', 'EU', 'EUP - Bontang'),
  ('EU4E', 'EU', 'EUP - Tanjung Pura'),
  ('EU51', 'EU', 'EUP - Lubuk Gaung'),
  ('EU52', 'EU', 'EUP - Bontang'),
  ('EU53', 'EU', 'EUP - Tanjung Pura'),
  ('EU54', 'EU', 'EUP - Kumai'),
  ('EU55', 'EU', 'EUP - Palembang'),
  ('EU62', 'EU', 'EUP - Bontang'),
  ('EU71', 'EU', 'EUP - Lubuk Gaung'),
  ('EU72', 'EU', 'EUP - Bontang'),
  ('EU73', 'EU', 'EUP - Tanjung Pura'),
  ('EU74', 'EU', 'EUP - Kumai'),
  ('EU75', 'EU', 'EUP - Palembang'),
  ('EU76', 'EU', 'EUP - Batam'),
  ('EU77', 'EU', 'EUP - Sintang'),
  ('EU78', 'EU', 'EUP - Merauke'),
  ('EU7A', 'EU', 'EUP - Boven Digoel'),
  ('EU7Y', 'EU', 'EUP - Paya Pasir'),
  ('EU8B', 'EU', 'EUP - Bontang'),
  ('EU8C', 'EU', 'EUP - Tanjung Pura'),
  ('EU8E', 'EU', 'EUP - Tanjung Pura'),
  ('EU8F', 'EU', 'EUP - Boven Digoel'),
  ('EU8W', 'EU', 'EUP - Bontang'),
  ('EU90', 'EU', 'EUP - HO Proj'),
  ('EU91', 'EU', 'EUP - Lubuk Gaung'),
  ('EU92', 'EU', 'EUP - Bontang'),
  ('EU93', 'EU', 'EUP - Tanjung Pura'),
  ('EU94', 'EU', 'EUP - Kumai'),
  ('EU95', 'EU', 'EUP - Palembang'),
  ('EU96', 'EU', 'EUP - Batam'),
  ('EU97', 'EU', 'EUP - Sintang'),
  ('EU98', 'EU', 'EUP - Merauke'),
  ('EU99', 'EU', 'EUP - Bagendang'),
  ('EU9A', 'EU', 'EUP - Lubuk Gaung'),
  ('EU9B', 'EU', 'EUP - Bontang'),
  ('EU9C', 'EU', 'EUP - Tanjung Pura'),
  ('EU9D', 'EU', 'EUP - Kumai'),
  ('EU9E', 'EU', 'EUP - Palembang'),
  ('EU9F', 'EU', 'EUP - Boven Digoel'),
  ('EU9X', 'EU', 'EUP - Jambi'),
  ('EU9Y', 'EU', 'EUP - Paya Pasir'),
  ('EUL0', 'EU', 'EUP - Trading Interdiv'),
  ('GM00', 'GM', 'GLM - Port Klang'),
  ('GM10', 'GM', 'GLM - Port Klang'),
  ('GM21', 'GM', 'GLM - Port Klang'),
  ('GM2A', 'GM', 'GLM - Port Klang'),
  ('GM90', 'GM', 'GLM - Port Klang'),
  ('GM91', 'GM', 'GLM - Port Klang'),
  ('GM9A', 'GM', 'GLM - Port Klang'),
  ('JP00', 'JP', 'JPN - HO'),
  ('JP10', 'JP', 'JPN - Trading'),
  ('JP21', 'JP', 'JPN - Bekasi'),
  ('JP22', 'JP', 'JPN - Sidoarjo'),
  ('JP26', 'JP', 'JPN - Gresik'),
  ('JP27', 'JP', 'JPN - Lubuk Gaung'),
  ('JP90', 'JP', 'JPN - HO Proj'),
  ('JP91', 'JP', 'JPN - Bekasi'),
  ('JP92', 'JP', 'JPN - Sidoarjo'),
  ('JP96', 'JP', 'JPN - Gresik'),
  ('JP97', 'JP', 'JPN - Lubuk Gaung'),
  ('JPL0', 'JP', 'JPN - Trading Interdiv'),
  ('MG00', 'MG', 'MPE - HO'),
  ('MG10', 'MG', 'MPE - Trading'),
  ('MG21', 'MG', 'MPE - Tanjung Pura'),
  ('MG90', 'MG', 'MPE - HO Proj'),
  ('MG91', 'MG', 'MPE - Tanjung Pura'),
  ('ND00', 'ND', 'SAGS - HO'),
  ('ND10', 'ND', 'SAGS - Trading'),
  ('ND21', 'ND', 'SAGS - Merauke'),
  ('ND4A', 'ND', 'SAGS - Merauke'),
  ('ND71', 'ND', 'SAGS - Merauke'),
  ('ND8A', 'ND', 'SAGS - Merauke'),
  ('ND90', 'ND', 'SAGS - HO Proj'),
  ('ND91', 'ND', 'SAGS - Merauke'),
  ('PE00', 'PE', 'PPEI - HO'),
  ('PE10', 'PE', 'PPEI - Trading'),
  ('PE21', 'PE', 'PPEI - Bayah'),
  ('PE22', 'PE', 'PPEI - Bontang'),
  ('PE23', 'PE', 'PPEI - Salo Palai'),
  ('PE90', 'PE', 'PPEI - HO Proj'),
  ('PE91', 'PE', 'PPEI - Bayah'),
  ('PE92', 'PE', 'PPEI - Bontang'),
  ('PE93', 'PE', 'PPEI - Salo Palai'),
  ('PM00', 'PM', 'PMC - HO'),
  ('PM10', 'PM', 'PMC - Trading'),
  ('PM21', 'PM', 'PMC - Lubuk Gaung'),
  ('PM90', 'PM', 'PMC - HO Proj'),
  ('PM91', 'PM', 'PMC - Lubuk Gaung'),
  ('PS00', 'PS', 'PRC - HO'),
  ('PS10', 'PS', 'PRC - Trading'),
  ('PS21', 'PS', 'PRC - Bekasi'),
  ('PS22', 'PS', 'PRC - Bekasi'),
  ('PS23', 'PS', 'PRC - Karawang'),
  ('PS2A', 'PS', 'PRC - Karawang'),
  ('PS2B', 'PS', 'PRC - Karawang'),
  ('PS4A', 'PS', 'PRC - Karawang'),
  ('PS4B', 'PS', 'PRC - Karawang'),
  ('PS8A', 'PS', 'PRC - Karawang'),
  ('PS90', 'PS', 'PRC - HO Proj'),
  ('PS91', 'PS', 'PRC - Bekasi'),
  ('PS93', 'PS', 'PRC - Karawang'),
  ('PSL0', 'PS', 'PRC - Trading Interdiv'),
  ('RB00', 'RB', 'RSB - HO'),
  ('RB10', 'RB', 'RSB - Trading'),
  ('RB21', 'RB', 'RSB - Tanjung Buton'),
  ('RB90', 'RB', 'RSB - HO Proj'),
  ('RB91', 'RB', 'RSB - Tanjung Buton'),
  ('RI00', 'RI', 'RFI - HO'),
  ('RI10', 'RI', 'RFI - Trading'),
  ('RI21', 'RI', 'RFI - Bekasi'),
  ('RI90', 'RI', 'RFI - HO Proj'),
  ('RI91', 'RI', 'RFI - Bekasi'),
  ('RIL0', 'RI', 'RFI - Trading Interdiv'),
  ('SB00', 'SB', 'SB - HO'),
  ('SB10', 'SB', 'SB - Trading'),
  ('SB21', 'SB', 'SB - Salo Palai'),
  ('SB22', 'SB', 'SB - Sintete'),
  ('SB90', 'SB', 'SB - HO Proj'),
  ('SB91', 'SB', 'SB - Salo Palai'),
  ('SB92', 'SB', 'SB - Sintete'),
  ('SC00', 'SC', 'SPC - HO'),
  ('SC10', 'SC', 'SPC - Trading'),
  ('SC21', 'SC', 'SPC - Batam'),
  ('SC22', 'SC', 'SPC - Lubuk Gaung'),
  ('SC4A', 'SC', 'SPC - Batam'),
  ('SC4B', 'SC', 'SPC - Lubuk Gaung'),
  ('SC8A', 'SC', 'SPC - Batam'),
  ('SC8B', 'SC', 'SPC - Lubuk Gaung'),
  ('SC90', 'SC', 'SPC - HO Proj'),
  ('SC91', 'SC', 'SPC - Batam'),
  ('SC92', 'SC', 'SPC - Lubuk Gaung'),
  ('SS00', 'SS', 'SSIM - HO'),
  ('TP00', 'TP', 'TPG - Johor Bahru'),
  ('TP10', 'TP', 'TPG - Johor Bahru'),
  ('TP21', 'TP', 'TPG - Johor Bahru'),
  ('TP2A', 'TP', 'TPG - Johor Bahru'),
  ('TP90', 'TP', 'TPG - Johor Bahru'),
  ('TP91', 'TP', 'TPG - Johor Bahru'),
  ('TP9A', 'TP', 'TPG - Johor Bahru'),
  ('UI00', 'UI', 'AHUI - HO')
ON CONFLICT (plant) DO UPDATE SET company_code = EXCLUDED.company_code, plant_name = EXCLUDED.plant_name;

-- Material-group category overrides (from v1 MG)
INSERT INTO core.dim_material_group (material_group, category) VALUES
  ('8010', 'Raw Product Liquid'),
  ('8030', 'Raw Product Solid'),
  ('8050', 'Finished Goods'),
  ('8080', 'Service'),
  ('8081', 'Service'),
  ('8082', 'Service'),
  ('8083', 'Service'),
  ('8084', 'Service'),
  ('8085', 'Service'),
  ('8090', 'Service'),
  ('9090', 'Service'),
  ('912', 'Chemical'),
  ('922', 'Fertilizer'),
  ('926', 'Chemical'),
  ('929', 'Fuel & Lubricant'),
  ('937', 'Fuel & Lubricant'),
  ('958', 'Packing Material'),
  ('964', 'Fertilizer'),
  ('983', 'Packing Material')
ON CONFLICT (material_group) DO UPDATE SET category = EXCLUDED.category;

-- ────────────────────────────────────────────────────────────────────────────
-- Detail-table view — v1's pg-dt grain, 41 columns.
--
-- v1's row model was PR-centric: one row per PR item x PO link. That excluded
-- the 9,094 direct PO lines (43.7%) from the detail table entirely, which the
-- review flagged. This view keeps v1's grain for linked rows and UNIONs the
-- direct POs so nothing is invisible.
--
-- Not materialised: it reads the partitioned facts, so it prunes to one dataset
-- version per query and needs no separate refresh.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW core.v_detail AS
-- (a) PR items, with their PO link when one exists
SELECT
  pri.dataset_version_id,
  pri.pr_no                                        AS pr_no,
  pri.pr_item                                      AS pr_item,
  pri.short_text                                   AS descr,
  pri.company_code                                 AS company,
  COALESCE(dc.legal_name, pri.company_code)        AS company_full,
  pri.plant                                        AS plant,
  COALESCE(dp.plant_name, pri.plant)               AS plant_name,
  pri.qty_requested                                AS pr_qty,
  pri.uom                                          AS uom,
  pol.receipt_qty_net                              AS gr_qty_total,
  pol.gr_completion_pct                            AS gr_pr_pct,
  pri.material_group                               AS mat_group,
  pri.material_category                            AS mat_cat,
  pri.priority_label                               AS p_cat,
  COALESCE(pol.status, pri.status)                 AS status,
  pri.next_approver                                AS pr_next_approver,
  pri.requisition_date                             AS req_date,
  pri.release_l1_date                              AS pr_l1,
  pri.release_l2_date                              AS pr_l2,
  (pri.release_final_date - pri.requisition_date)  AS pra_days,
  CASE WHEN pri.release_final_date IS NULL THEN pri.aging_days END AS unrel_days,
  CASE WHEN pri.po_line_count = 0 AND pri.release_final_date IS NOT NULL
       THEN pri.aging_days END                     AS sourcing_aging_days,
  pol.po_no                                        AS po_no,
  pol.po_item                                      AS po_item,
  CASE WHEN b.split_total > 1
       THEN b.split_seq || '/' || b.split_total END AS po_split,
  pol.short_text                                   AS po_mat_desc,
  pol.order_qty                                    AS po_qty,
  pol.order_unit                                   AS po_uom,
  pol.order_unit                                   AS order_price_unit,
  pol.price_unit                                   AS price_unit,
  pol.document_date                                AS po_date,
  pol.release_final_date                           AS po_full,
  pol.vendor_code                                  AS vendor_code,
  pol.vendor_name                                  AS supplier,
  pol.next_approver                                AS po_next_approver,
  pol.po_approval_days                             AS poa_days,
  pol.receipt_date                                 AS gr_date,
  pol.delivery_days                                AS deliv_days,
  pol.sourcing_days                                AS src_days,
  pol.delivery_vs_promise_days                     AS delvsgr_days,
  (pol.receipt_date - pri.requisition_date)        AS e2e_days,
  pri.wbs_element                                  AS wbs,
  pri.wbs_status                                   AS wbs_status,
  pol.currency_code                                AS currency_code,
  pol.net_order_value                              AS net_order_value,
  pol.net_order_value_usd                          AS net_order_value_usd,
  pri.total_value_idr                              AS pr_value_idr,
  pri.purch_org                                    AS purch_org,
  pri.purch_group                                  AS purch_group,
  pri.urgency                                      AS urgency,
  pri.is_deleted                                   AS pr_deleted,
  COALESCE(pol.is_sto, false)                      AS is_sto,
  COALESCE(pol.release_exempt, false)              AS release_exempt,
  COALESCE(pol.is_token_price, false)              AS is_token_price,
  COALESCE(pol.is_retro_po, false)                 AS is_retro_po,
  pol.link_status                                  AS link_status,
  false                                            AS is_direct_po,
  pri.requisitioner                                AS requisitioner
FROM core.fact_pr_item pri
LEFT JOIN core.bridge_pr_po b
       ON b.dataset_version_id = pri.dataset_version_id
      AND b.pr_no = pri.pr_no AND b.pr_item = pri.pr_item
LEFT JOIN core.fact_po_line pol
       ON pol.dataset_version_id = pri.dataset_version_id
      AND pol.po_no = b.po_no AND pol.po_item = b.po_item
LEFT JOIN core.dim_plant   dp ON dp.plant = pri.plant
LEFT JOIN core.dim_company dc ON dc.company_code = pri.company_code

UNION ALL

-- (b) Direct POs and dangling-reference POs: no resolvable requisition.
-- v1 omitted these from the detail table; 9,094 lines in the reference data.
SELECT
  pol.dataset_version_id,
  NULL, NULL,
  pol.short_text,
  pol.company_code,
  COALESCE(dc.legal_name, pol.company_code),
  pol.plant,
  COALESCE(dp.plant_name, pol.plant),
  NULL, pol.order_unit,
  pol.receipt_qty_net, pol.gr_completion_pct,
  pol.material_group, pol.material_category,
  NULL,
  pol.status,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  pol.po_no, pol.po_item, NULL,
  pol.short_text, pol.order_qty, pol.order_unit, pol.order_unit, pol.price_unit,
  pol.document_date, pol.release_final_date,
  pol.vendor_code, pol.vendor_name, pol.next_approver, pol.po_approval_days,
  pol.receipt_date, pol.delivery_days, NULL, pol.delivery_vs_promise_days, NULL,
  NULL, NULL,
  pol.currency_code, pol.net_order_value, pol.net_order_value_usd,
  NULL, pol.purch_org, pol.purch_group, pol.urgency,
  false,
  pol.is_sto, pol.release_exempt, pol.is_token_price, pol.is_retro_po,
  pol.link_status,
  true,
  NULL
FROM core.fact_po_line pol
LEFT JOIN core.dim_plant   dp ON dp.plant = pol.plant
LEFT JOIN core.dim_company dc ON dc.company_code = pol.company_code
WHERE pol.pr_no IS NULL;
