create index if not exists messages_conv_created_idx
  on messages(conversation_id, created_at desc);

create index if not exists conversations_last_msg_idx
  on conversations(last_message_at desc);

create index if not exists leads_phone_idx
  on leads(phone_e164);

create index if not exists event_log_recent_idx
  on event_log(created_at desc, level);

create index if not exists event_log_type_idx
  on event_log(type, created_at desc);

-- Index per dedup AC: cerca event_log per email/phone in finestra 5 min
create index if not exists event_log_ac_dedup_idx
  on event_log((payload->>'email'), (payload->>'phone'), created_at desc)
  where type = 'ac_webhook';
