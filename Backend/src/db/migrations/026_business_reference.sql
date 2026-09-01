-- 026 — the two business reference files, loaded.
--
-- Supplied 1 Sep 2026:
--   SAP Template/matcode v2.xlsx    -> core.dim_spend_category
--   SAP Template/User HO Unit.xlsx  -> core.dim_user_purch_org (new)
--
-- Generated from those workbooks rather than transcribed, so the rows below are
-- exactly what the business sent and can be regenerated if a file is reissued.
--
-- ── matcode v2: one column, two levels ──────────────────────────────────────
--
-- The MG column carries three different kinds of key:
--
--   901          a material GROUP
--   912.020.006  a material CODE, exactly as the facts spell it (427 lines)
--   912.001      a material-code PREFIX
--
-- The prefixes are the reason this file exists in the form 020 predicted:
-- 912.001.* is ten different Bleaching Earth codes and 912.007.* is Sodium
-- Methylate, and the business shows both BESIDE Chemical rather than inside it.
-- Matched exactly, those two rows would have found nothing at all.
--
-- So dim_spend_category gains material_prefix, and the resolution order becomes
-- exact code, then longest matching prefix, then material group, then the SAP
-- master, then the honest placeholders.
--
-- CATEGORIES ARE UPPERCASED. The file writes "MRO General"; the SAP material
-- master already carries "MRO GENERAL", and a line resolved by the group rule
-- sits on the same axis as a line resolved by the master. Loading both spellings
-- would split one category into two bars on every chart.
--
-- Skipped, deliberately:
--   * 17 rows carrying a PIC name but no MG — a staff list appended below
--     the mapping table, not a mapping.
--   * "SO" (category "Sales") — matches no material code or
--     group anywhere in the data.
--   * the second of two identical MG 912 rows, which differ only in PIC.
--
-- ── User HO Unit ────────────────────────────────────────────────────────────
--
-- 110 rows over 72 users: a user can buy for several purchasing orgs
-- (one has four), so this is its own table rather than two columns on
-- dim_sap_user. HO/Unit is per USER — no user in the file disagrees with itself
-- across their orgs — but it is stored per row because the file states it per
-- row, and inventing a promotion the source does not make would be this table
-- claiming more than it was told.

ALTER TABLE core.dim_spend_category ADD COLUMN IF NOT EXISTS material_prefix text;

COMMENT ON COLUMN core.dim_spend_category.material_prefix IS
  'Material-code prefix, e.g. 912.001 for every Bleaching Earth code. Matched longest-first, between the exact-code rule and the material-group rule.';

-- The table already guarded "exactly one key per row" with an XOR over code and
-- group, which is why the first attempt at this migration failed: a prefix row
-- sets neither. The rule was right and stays — it just has to count three
-- possible keys instead of two.
ALTER TABLE core.dim_spend_category DROP CONSTRAINT IF EXISTS dim_spend_category_key_one;
ALTER TABLE core.dim_spend_category ADD CONSTRAINT dim_spend_category_key_one
  CHECK (
    (material_code   IS NOT NULL)::int
  + (material_prefix IS NOT NULL)::int
  + (material_group  IS NOT NULL)::int = 1
  );

-- Idempotent: re-running replaces this file's rows and leaves any hand-added
-- mapping (a different source) alone.
DELETE FROM core.dim_spend_category WHERE source = 'business_file';

INSERT INTO core.dim_spend_category (material_code, material_prefix, material_group, category, sort_order, source) VALUES
  ('912.020.006', NULL, NULL, 'METHANOL', 1, 'business_file'),
  ('929.001.005', NULL, NULL, 'FUEL', 2, 'business_file'),
  ('929.001.018', NULL, NULL, 'COAL', 3, 'business_file'),
  ('929.001.070', NULL, NULL, 'COAL', 4, 'business_file'),
  ('929.001.077', NULL, NULL, 'COAL', 5, 'business_file'),
  ('929.001.078', NULL, NULL, 'COAL', 6, 'business_file'),
  ('929.001.080', NULL, NULL, 'COAL', 7, 'business_file'),
  ('929.001.082', NULL, NULL, 'COAL', 8, 'business_file'),
  (NULL, '912.001', NULL, 'BLEACHING EARTH', 9, 'business_file'),
  (NULL, '912.007', NULL, 'SODIUM METHYLATE', 10, 'business_file'),
  (NULL, NULL, '8080', 'SERVICES', 11, 'business_file'),
  (NULL, NULL, '8081', 'UNIT', 12, 'business_file'),
  (NULL, NULL, '901', 'MRO GENERAL', 13, 'business_file'),
  (NULL, NULL, '902', 'MRO SPECIFIC', 14, 'business_file'),
  (NULL, NULL, '903', 'MRO SPECIFIC', 15, 'business_file'),
  (NULL, NULL, '904', 'OFFICE IT', 16, 'business_file'),
  (NULL, NULL, '905', 'MRO GENERAL', 17, 'business_file'),
  (NULL, NULL, '906', 'MRO SPECIFIC', 18, 'business_file'),
  (NULL, NULL, '907', 'MRO GENERAL', 19, 'business_file'),
  (NULL, NULL, '908', 'MRO SPECIFIC', 20, 'business_file'),
  (NULL, NULL, '909', 'MRO GENERAL', 21, 'business_file'),
  (NULL, NULL, '910', 'CAPEX OPS', 22, 'business_file'),
  (NULL, NULL, '911', 'MRO GENERAL', 23, 'business_file'),
  (NULL, NULL, '912', 'CHEMICAL', 24, 'business_file'),
  (NULL, NULL, '913', 'MRO SPECIFIC', 25, 'business_file'),
  (NULL, NULL, '914', 'MRO GENERAL', 26, 'business_file'),
  (NULL, NULL, '915', 'OFFICE IT', 27, 'business_file'),
  (NULL, NULL, '916', 'MRO SPECIFIC', 28, 'business_file'),
  (NULL, NULL, '917', 'MRO GENERAL', 29, 'business_file'),
  (NULL, NULL, '918', 'MRO SPECIFIC', 30, 'business_file'),
  (NULL, NULL, '919', 'MRO SPECIFIC', 31, 'business_file'),
  (NULL, NULL, '920', 'MRO GENERAL', 32, 'business_file'),
  (NULL, NULL, '921', 'MRO GENERAL', 33, 'business_file'),
  (NULL, NULL, '922', 'FERTILIZER', 34, 'business_file'),
  (NULL, NULL, '923', 'MRO SPECIFIC', 35, 'business_file'),
  (NULL, NULL, '924', 'MRO SPECIFIC', 36, 'business_file'),
  (NULL, NULL, '925', 'MRO GENERAL', 37, 'business_file'),
  (NULL, NULL, '926', 'CHEMICAL', 38, 'business_file'),
  (NULL, NULL, '927', 'HEVE', 39, 'business_file'),
  (NULL, NULL, '928', 'MRO SPECIFIC', 40, 'business_file'),
  (NULL, NULL, '929', 'FUEL & ENERGY', 41, 'business_file'),
  (NULL, NULL, '930', 'OFFICE IT', 42, 'business_file'),
  (NULL, NULL, '931', 'MRO GENERAL', 43, 'business_file'),
  (NULL, NULL, '932', 'MRO GENERAL', 44, 'business_file'),
  (NULL, NULL, '933', 'MRO SPECIFIC', 45, 'business_file'),
  (NULL, NULL, '934', 'MRO GENERAL', 46, 'business_file'),
  (NULL, NULL, '935', 'HEVE', 47, 'business_file'),
  (NULL, NULL, '936', 'MRO SPECIFIC', 48, 'business_file'),
  (NULL, NULL, '937', 'HEVE', 49, 'business_file'),
  (NULL, NULL, '938', 'HEVE', 50, 'business_file'),
  (NULL, NULL, '939', 'OFFICE IT', 51, 'business_file'),
  (NULL, NULL, '940', 'MRO GENERAL', 52, 'business_file'),
  (NULL, NULL, '941', 'MRO SPECIFIC', 53, 'business_file'),
  (NULL, NULL, '942', 'MRO SPECIFIC', 54, 'business_file'),
  (NULL, NULL, '943', 'MRO SPECIFIC', 55, 'business_file'),
  (NULL, NULL, '944', 'MRO GENERAL', 56, 'business_file'),
  (NULL, NULL, '945', 'MRO GENERAL', 57, 'business_file'),
  (NULL, NULL, '946', 'MRO GENERAL', 58, 'business_file'),
  (NULL, NULL, '947', 'MRO GENERAL', 59, 'business_file'),
  (NULL, NULL, '948', 'MRO SPECIFIC', 60, 'business_file'),
  (NULL, NULL, '949', 'MRO GENERAL', 61, 'business_file'),
  (NULL, NULL, '950', 'MRO SPECIFIC', 62, 'business_file'),
  (NULL, NULL, '951', 'MRO GENERAL', 63, 'business_file'),
  (NULL, NULL, '952', 'HEVE', 64, 'business_file'),
  (NULL, NULL, '953', 'MRO SPECIFIC', 65, 'business_file'),
  (NULL, NULL, '954', 'MRO SPECIFIC', 66, 'business_file'),
  (NULL, NULL, '955', 'MRO GENERAL', 67, 'business_file'),
  (NULL, NULL, '956', 'OFFICE IT', 68, 'business_file'),
  (NULL, NULL, '957', 'MRO GENERAL', 69, 'business_file'),
  (NULL, NULL, '958', 'PACKAGING', 70, 'business_file'),
  (NULL, NULL, '959', 'MRO GENERAL', 71, 'business_file'),
  (NULL, NULL, '960', 'MRO SPECIFIC', 72, 'business_file'),
  (NULL, NULL, '961', 'MRO GENERAL', 73, 'business_file'),
  (NULL, NULL, '962', 'MRO GENERAL', 74, 'business_file'),
  (NULL, NULL, '963', 'MRO GENERAL', 75, 'business_file'),
  (NULL, NULL, '964', 'CHEMICAL', 76, 'business_file'),
  (NULL, NULL, '965', 'MRO GENERAL', 77, 'business_file'),
  (NULL, NULL, '966', 'MRO GENERAL', 78, 'business_file'),
  (NULL, NULL, '967', 'OFFICE IT', 79, 'business_file'),
  (NULL, NULL, '968', 'MRO GENERAL', 80, 'business_file'),
  (NULL, NULL, '969', 'MRO SPECIFIC', 81, 'business_file'),
  (NULL, NULL, '970', 'MRO SPECIFIC', 82, 'business_file'),
  (NULL, NULL, '971', 'MRO SPECIFIC', 83, 'business_file'),
  (NULL, NULL, '972', 'MRO SPECIFIC', 84, 'business_file'),
  (NULL, NULL, '973', 'MRO SPECIFIC', 85, 'business_file'),
  (NULL, NULL, '974', 'OFFICE IT', 86, 'business_file'),
  (NULL, NULL, '975', 'MRO GENERAL', 87, 'business_file'),
  (NULL, NULL, '976', 'MRO GENERAL', 88, 'business_file'),
  (NULL, NULL, '977', 'MRO GENERAL', 89, 'business_file'),
  (NULL, NULL, '978', 'OFFICE IT', 90, 'business_file'),
  (NULL, NULL, '979', 'MRO GENERAL', 91, 'business_file'),
  (NULL, NULL, '980', 'MRO SPECIFIC', 92, 'business_file'),
  (NULL, NULL, '981', 'MRO GENERAL', 93, 'business_file'),
  (NULL, NULL, '982', 'MRO GENERAL', 94, 'business_file'),
  (NULL, NULL, '983', 'PACKAGING', 95, 'business_file'),
  (NULL, NULL, '984', 'MRO SPECIFIC', 96, 'business_file')
;

CREATE TABLE IF NOT EXISTS core.dim_user_purch_org (
  user_id   text NOT NULL,
  purch_org text NOT NULL,
  -- 'HO' or 'Unit'. Nullable: the file leaves it blank for some rows, and a
  -- blank is not a third value to invent a meaning for.
  ho_unit   text,
  -- The name as the file spells it, kept for the rows where dim_sap_user has no
  -- match — 2,073 SAP users against 72 here, and the two are not guaranteed to
  -- agree.
  name      text,
  source    text NOT NULL DEFAULT 'business_file',
  PRIMARY KEY (user_id, purch_org)
);

CREATE INDEX IF NOT EXISTS dim_user_purch_org_user_idx ON core.dim_user_purch_org (user_id);

DELETE FROM core.dim_user_purch_org WHERE source = 'business_file';

INSERT INTO core.dim_user_purch_org (user_id, purch_org, ho_unit, name) VALUES
  ('01123080007', 'HRG1', 'HO', 'Lilia Dewi'),
  ('01123080007', 'LGL1', 'HO', 'Lilia Dewi'),
  ('04116060019', 'IMP1', 'HO', 'Daniel Bona'),
  ('04120100076', 'KJG1', 'Unit', 'Siti Kurnia Wati'),
  ('04120110047', 'KJG1', 'Unit', 'Yoga Apriyandi'),
  ('04121120012', 'TGR4', 'Unit', 'Andika Marjuni'),
  ('04123120151', 'PUR1', 'HO', 'Bryan Geraldy'),
  ('04124020072', 'IMP1', 'HO', 'Vezennia Suwandi'),
  ('04124020084', 'HRG1', 'HO', 'Gabrielie Alicia Widjaja'),
  ('04124020084', 'PUR1', 'HO', 'Gabrielie Alicia Widjaja'),
  ('04124020084', 'SDA1', 'HO', 'Gabrielie Alicia Widjaja'),
  ('04124040114', 'BTG1', 'HO', 'Evelyn Wijaya'),
  ('04124040114', 'KJG1', 'HO', 'Evelyn Wijaya'),
  ('04124040114', 'PUR1', 'HO', 'Evelyn Wijaya'),
  ('04124040114', 'TJM1', 'HO', 'Evelyn Wijaya'),
  ('04124040159', 'PUR1', 'HO', 'Selvie'),
  ('04124080412', 'TSE1', 'HO', 'Sri Maria Florencia'),
  ('04124090539', 'PUR1', 'HO', 'Agung Job Yosafat Sitepu'),
  ('04124090561', 'PUR1', 'HO', 'Billy Tirta'),
  ('04124090561', 'TGR1', 'HO', 'Billy Tirta'),
  ('04125030072', 'IMP1', 'HO', 'Martua Sihite'),
  ('04125030083', 'IMP1', 'HO', 'Kella Charles'),
  ('04125040132', 'PUR1', 'HO', 'Lysa Febriyantie'),
  ('04125050403', 'LBG1', 'Unit', 'Harun Al Rasyid'),
  ('04125050446', 'LBG1', 'Unit', 'Ilham Syaputra'),
  ('04125050529', 'HRG1', 'HO', 'Safinatun Najah'),
  ('04125050571', 'PUR1', 'HO', 'Salwa Dhaifina Fitria'),
  ('04125050719', 'IMP1', 'HO', 'Nathaniel Feldy Wijaya'),
  ('04125050800', 'HRG1', 'HO', 'Arvin Hadinata'),
  ('04126010209', 'IMP1', 'HO', 'Alvina'),
  ('04126010227', 'PUR1', 'HO', 'Justin Oliver'),
  ('04126010348', 'PUR1', 'HO', 'Euginia Felicia Tamba'),
  ('62003300730', 'TJM1', 'Unit', 'Christini Lubis'),
  ('62011090012', 'IMP1', 'HO', 'Hanna Septiviandri'),
  ('62011200911', 'BTG1', 'HO', 'Julieta Dhamayanti'),
  ('62011200911', 'OPS3', 'HO', 'Julieta Dhamayanti'),
  ('62011211003', 'IMP1', 'HO', 'Bambang Wahyudi'),
  ('62019080003', 'IMP1', 'HO', 'Syolihah Intan'),
  ('62021101201', 'PUR1', 'HO', 'Agustinus Wirawan'),
  ('62042120009', 'TGR1', 'Unit', 'MARDIAH MARDIAH'),
  ('62048090007', 'PCP1', 'Unit', 'Meiliza Meiliza'),
  ('62048090007', 'TGR1', 'Unit', 'Meiliza Meiliza'),
  ('62122060004', 'PRO3', 'HO', 'Adelia Regita Hapsari'),
  ('62147080095', 'TJL1', 'HO', 'Harnanto Nugroho'),
  ('62167590258', 'PUR1', 'HO', 'DEDI KURNIADI'),
  ('62176470004', 'OPS3', 'HO', 'Yunita Imelda'),
  ('62176470004', 'PRO3', 'HO', 'Yunita Imelda'),
  ('62177100321', 'PUR1', 'HO', 'DANANG TRI WICAKSONO'),
  ('62183590945', 'PPIC', 'Unit', 'Atika Rahmawati'),
  ('62187100565', 'BKS1', 'HO', 'JOHNY RUSLI'),
  ('62187100565', 'BTG1', 'HO', 'JOHNY RUSLI'),
  ('62187100565', 'LBG1', 'HO', 'JOHNY RUSLI'),
  ('62187100565', 'PUR1', 'HO', 'JOHNY RUSLI'),
  ('62187100565', 'SDA1', 'HO', 'JOHNY RUSLI'),
  ('62187100565', 'TGR1', 'HO', 'JOHNY RUSLI'),
  ('62187100565', 'TJL1', 'HO', 'JOHNY RUSLI'),
  ('62187100565', 'TJM1', 'HO', 'JOHNY RUSLI'),
  ('62187300430', 'PUR1', 'HO', 'Batildis widyandri'),
  ('62193590021', 'BKS1', 'Unit', 'MARLINAH MARLINAH'),
  ('62193590021', 'PUR1', 'Unit', 'MARLINAH MARLINAH'),
  ('62193591503', 'LBG1', 'Unit', 'Ade Tari'),
  ('62193591503', 'PPIC', 'Unit', 'Ade Tari'),
  ('62197100159', 'PPIC', 'HO', 'MUHAMMAD FIKRI'),
  ('62197460145', 'PRO3', 'HO', 'FRANSISCA MARSEILLA'),
  ('62197470044', 'PUR1', 'HO', 'DESTYARINA AYUNINGRUM'),
  ('62197470044', 'TJL1', 'HO', 'DESTYARINA AYUNINGRUM'),
  ('62198590030', 'PPIC', 'Unit', 'OKTO DARMAWAN'),
  ('62201004006', 'PCP1', 'Unit', 'Vike Iendra'),
  ('62201004006', 'TGR1', 'Unit', 'Vike Iendra'),
  ('62203593272', 'TJB1', 'Unit', 'Firman Setiawan'),
  ('62207461378', 'PUR1', 'HO', 'Sekar Fransisca'),
  ('62207473738', 'SDA1', 'Unit', 'Gilda Angreni'),
  ('62207473738', 'SDA3', 'Unit', 'Gilda Angreni'),
  ('62207633829', 'BTG1', 'Unit', 'Baruna Wicaksono'),
  ('62207633829', 'OPS3', 'Unit', 'Baruna Wicaksono'),
  ('62217215669', 'BLW1', 'Unit', 'Dini Rahmadhanti'),
  ('62217215669', 'TJM1', 'Unit', 'Dini Rahmadhanti'),
  ('62217475168', 'BKS1', 'Unit', 'Indah Astri Anggraeni'),
  ('62217475168', 'PUR1', 'Unit', 'Indah Astri Anggraeni'),
  ('62217595465', 'BLW1', 'Unit', 'Martin Kamal'),
  ('62217595465', 'PUR1', 'Unit', 'Martin Kamal'),
  ('62217595465', 'TJM1', 'Unit', 'Martin Kamal'),
  ('62227476616', 'KRW1', 'Unit', 'Roziah Karimah'),
  ('62227476616', 'PUR1', 'Unit', 'Roziah Karimah'),
  ('62227596529', 'PUR1', 'HO', 'Sundoro Bayu Prasetyo'),
  ('62227626489', 'BTG1', 'Unit', 'Shinta Nurrizki'),
  ('62227626489', 'OPS3', 'Unit', 'Shinta Nurrizki'),
  ('62237030399', 'PUR1', 'HO', 'Edward Philip Lay'),
  ('62237480242', 'PRO3', 'HO', 'Muthia Lizza Habibie'),
  ('62237590472', 'BTG1', 'HO', 'Elizabeth Austina'),
  ('62237590472', 'KJG1', 'HO', 'Elizabeth Austina'),
  ('62237590472', 'PUR1', 'HO', 'Elizabeth Austina'),
  ('62237620014', 'PCP1', 'HO', 'DWI SAPTA SUKMA YUDISTIRA'),
  ('62237620014', 'PUR1', 'HO', 'DWI SAPTA SUKMA YUDISTIRA'),
  ('6219JPN0005', 'SDA1', 'Unit', 'Aldy Primananda'),
  ('BKGRND-GAMA', 'PCP1', NULL, 'SAP System Administrator'),
  ('BKGRND-GAMA', 'PUR1', NULL, 'SAP System Administrator'),
  ('BKGRND-GAMA', 'TGR1', NULL, 'SAP System Administrator'),
  ('CREWING.ADM', 'LGCR', NULL, 'CREWING.ADM'),
  ('GM-KLG-LOG01', 'KLG3', 'Unit', 'Suguna Muniandy'),
  ('GM-KLG-PCH01', 'PUR1', 'Unit', 'Muhamad Zulfadhli Mohd Osman'),
  ('GPFN-IM', 'PCP1', NULL, 'Functional IM'),
  ('GPFN-MM', 'PCP1', NULL, 'Functional MM'),
  ('GPFN-MM', 'PRO3', NULL, 'Functional MM'),
  ('GPFN-MM', 'PUR1', NULL, 'Functional MM'),
  ('GPFN-MM-DWS', 'PCP1', NULL, 'GPFN-MM-DWS'),
  ('GPFN-MM-DWS', 'PUR1', NULL, 'GPFN-MM-DWS'),
  ('TP-JHB-FIN01', 'TJL1', 'Unit', 'FARAH'),
  ('TP-JHB-PCH01', 'PUR1', 'Unit', 'Muhamad Zulfadhli Mohd Osman'),
  ('TP-JHB-PCH01', 'TJL1', 'Unit', 'Muhamad Zulfadhli Mohd Osman')
;
