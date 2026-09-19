-- Quota di riscaldamento del numero nuovo sui BENVENUTI del lancio (delibera PO 19/09).
--
-- Il PO vuole un rapporto 1 a 10: ogni ~10 benvenuti che partono dal numero storico
-- (+393520413199), 1 parte dal numero nuovo (+393522070047). Serve a scaldare il numero
-- nuovo senza esporlo, finche' non e' accertata la sua capacita'. Vale SOLO per il
-- lancio: il riscaldamento ordinario del bot (`FENICE_NUMERO2_QUOTA`, `BOT2_DAILY_CAP`,
-- la scelta esplicita del CRM) e' un'altra regola e non si tocca.
--
-- Il valore e' una percentuale 0-100 (9 = 1 su 11 circa). Sta in `app_settings` e non in
-- una env perche' si spegne in un attimo, senza deploy, come tutte le manopole del
-- lancio:
--
--   update app_settings set value = '0'::jsonb where key = 'lancio_quota_secondario';
--
-- Nasce a ZERO: chiave assente, vuota o scritta storta vale 0, cioe' tutto dal numero
-- storico (fail-closed — vedi `parseQuotaSecondario` in lib/lancio-settings.ts).
-- `lancio_sender = 'secondario'` resta e vince su questa quota.

insert into app_settings (key, value)
values ('lancio_quota_secondario', '0'::jsonb)
on conflict (key) do nothing;
