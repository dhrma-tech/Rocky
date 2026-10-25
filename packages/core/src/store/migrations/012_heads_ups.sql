-- Heads-ups (roadmap A7): one row per nudge about a commitment. The daily job reads these to
-- skip recent nudges and to lower scores after a dismissal. A heads-up and its notification leave
-- with the commitment (and so with its source document): the notification's sentence quotes the
-- commitment. Reversible: 012_heads_ups.down.sql.
create table heads_ups (
  id text primary key,
  commitment_id text not null references commitments (id) on delete cascade,
  notification_id text references notifications (id) on delete set null,
  at integer not null,
  score real not null,
  dismissed_at integer
);
create index heads_ups_commitment on heads_ups (commitment_id, at);
create index heads_ups_at on heads_ups (at);

create trigger heads_ups_drop_notification after delete on heads_ups
when old.notification_id is not null
begin
  delete from notifications where id = old.notification_id;
end;

-- Dismissing the notification is the "not useful" signal.
create trigger heads_ups_dismissed after update of dismissed_at on notifications
when new.dismissed_at is not null and new.kind = 'heads_up'
begin
  update heads_ups set dismissed_at = new.dismissed_at
  where notification_id = new.id and dismissed_at is null;
end;
