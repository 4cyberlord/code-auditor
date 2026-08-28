-- Phase 01, step 3: make ownership mandatory.
--
-- Run this BY HAND, once `npm run tenancy:audit` reports no unowned rows.
--
-- Deliberately not in `migrations.sql`: that file is replayed by `ensure_schema`
-- on every launch, so a `set not null` that fails against a single unbackfilled
-- row would stop the app from starting, not just stop the migration. A one-shot
-- statement that fails loudly in a SQL editor is a much better failure than an
-- app that will not open.
--
-- Safe to run twice: a column that is already `not null` accepts the statement
-- again, and each constraint is added under a name that will collide rather than
-- duplicate.

alter table sessions             alter column owner_id set not null;
alter table screenshots          alter column owner_id set not null;
alter table runs                 alter column owner_id set not null;
alter table solve_jobs           alter column owner_id set not null;
alter table solve_job_images     alter column owner_id set not null;
alter table solve_job_events     alter column owner_id set not null;
alter table council_reports      alter column owner_id set not null;
alter table notification_devices alter column owner_id set not null;

-- Cascade, so deleting an account takes its work with it. That is the behaviour
-- a person expects from "delete my account", and the alternative is orphaned
-- screenshots nobody can reach and nobody can remove.
alter table sessions
  add constraint sessions_owner_fk
  foreign key (owner_id) references app_users (id) on delete cascade;
alter table screenshots
  add constraint screenshots_owner_fk
  foreign key (owner_id) references app_users (id) on delete cascade;
alter table runs
  add constraint runs_owner_fk
  foreign key (owner_id) references app_users (id) on delete cascade;
alter table solve_jobs
  add constraint solve_jobs_owner_fk
  foreign key (owner_id) references app_users (id) on delete cascade;
alter table solve_job_images
  add constraint solve_job_images_owner_fk
  foreign key (owner_id) references app_users (id) on delete cascade;
alter table solve_job_events
  add constraint solve_job_events_owner_fk
  foreign key (owner_id) references app_users (id) on delete cascade;
alter table council_reports
  add constraint council_reports_owner_fk
  foreign key (owner_id) references app_users (id) on delete cascade;
alter table notification_devices
  add constraint notification_devices_owner_fk
  foreign key (owner_id) references app_users (id) on delete cascade;
