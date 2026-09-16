-- Interruttore del pulsante WhatsApp del webinar "Web Developer AI" (B2).
--
-- Il marker del pulsante e' un TESTO, non un segnale: senza questo interruttore una
-- frase qualunque che contenga "live web developer ai" porterebbe in `post_pitch` un
-- lead in `attesa`, e quel lead perderebbe il blast dello Zoom del 5/10. Sta in
-- `app_settings` e non in una env perche' si accende la sera stessa della live, senza
-- deploy:
--
--   update app_settings set value = 'true'::jsonb where key = 'lancio_pulsante_attivo';
--
-- Nasce spento. Chiave assente o valore strano = spento (si sbaglia verso il silenzio):
-- vedi `isAttivo` in lib/lancio-settings.ts.

insert into app_settings (key, value)
values ('lancio_pulsante_attivo', 'false'::jsonb)
on conflict (key) do nothing;
