-- Proprietario della campagna: separa i business Serenamente e Fenice Academy.
-- Le conversazioni delle campagne 'fenice' vivono solo in /campagne-chat.
alter table campaigns
  add column owner text not null default 'serenamente'
  check (owner in ('serenamente', 'fenice'));

update campaigns set owner = 'fenice' where id = 5;
