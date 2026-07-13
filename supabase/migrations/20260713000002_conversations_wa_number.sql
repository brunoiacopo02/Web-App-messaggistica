-- Numero WhatsApp aziendale della conversazione (formato Twilio "whatsapp:+39...").
-- Serve a rispondere SEMPRE dal numero su cui il lead ci scrive/riceve: la finestra
-- 24h di WhatsApp vale per coppia (numero aziendale, utente).
alter table conversations add column wa_number text;
