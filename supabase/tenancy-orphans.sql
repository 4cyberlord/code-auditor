-- Remove rows whose owner no longer exists.
--
-- Run this BEFORE tenancy-constrain.sql if that file fails with
-- "violates foreign key constraint ... is not present in table app_users".
--
-- How they got there: an account was deleted while the foreign key did not yet
-- exist, so nothing cascaded and its rows outlived it. The tenancy test suite
-- creates a throwaway account, gives it a session, and deletes the account —
-- which is exactly this shape. Adding the constraint is what stops it happening
-- again, so this only ever needs running once.
--
-- Children follow their parents: screenshots, runs and solve_job_* already
-- cascade from sessions, so deleting the orphaned sessions takes them along.
-- The rest are listed anyway, in case a row was orphaned on its own.

begin;

-- What is about to go, so it is on the record rather than a silent delete.
select 'sessions' as table_name, count(*) as orphaned from sessions s
  where not exists (select 1 from app_users u where u.id = s.owner_id)
union all select 'solve_jobs', count(*) from solve_jobs j
  where not exists (select 1 from app_users u where u.id = j.owner_id)
union all select 'runs', count(*) from runs r
  where not exists (select 1 from app_users u where u.id = r.owner_id);

delete from sessions s
  where not exists (select 1 from app_users u where u.id = s.owner_id);

delete from solve_jobs j
  where not exists (select 1 from app_users u where u.id = j.owner_id);

delete from runs r
  where not exists (select 1 from app_users u where u.id = r.owner_id);

delete from screenshots x
  where not exists (select 1 from app_users u where u.id = x.owner_id);

delete from solve_job_images i
  where not exists (select 1 from app_users u where u.id = i.owner_id);

delete from solve_job_events e
  where not exists (select 1 from app_users u where u.id = e.owner_id);

delete from council_reports c
  where not exists (select 1 from app_users u where u.id = c.owner_id);

delete from notification_devices d
  where not exists (select 1 from app_users u where u.id = d.owner_id);

-- Config and settings are keyed on (owner_id, key) with a nil-uuid platform
-- tier, so a real owner that no longer exists is the same kind of orphan.
delete from app_config a
  where a.owner_id <> '00000000-0000-0000-0000-000000000000'
    and not exists (select 1 from app_users u where u.id = a.owner_id);

delete from settings t
  where t.owner_id <> '00000000-0000-0000-0000-000000000000'
    and not exists (select 1 from app_users u where u.id = t.owner_id);

commit;
