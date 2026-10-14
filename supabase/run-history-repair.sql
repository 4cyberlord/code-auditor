-- Repair an older deployed database whose schema predates the atomic run_save RPC.
-- Keep this signature and body aligned with supabase/migrations.sql.
begin;

create or replace function public.run_save(
  p_owner uuid, p_session uuid, p_mode text, p_asked text,
  p_context_mode text, p_extracted_context text, p_extraction_agreed boolean,
  p_responses jsonb, p_verdict jsonb
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_run uuid;
  r jsonb;
begin
  if not exists (select 1 from sessions where id = p_session and owner_id = p_owner) then
    raise exception 'no such session' using errcode = 'P0002';
  end if;

  insert into runs (session_id, owner_id, mode, asked, context_mode,
                    extracted_context, extraction_agreed, finished_at)
  values (p_session, p_owner, p_mode, p_asked, p_context_mode,
          p_extracted_context, p_extraction_agreed, now())
  returning id into v_run;

  for r in select * from jsonb_array_elements(coalesce(p_responses, '[]'::jsonb))
  loop
    insert into agent_responses
      (run_id, provider, model, attempt_id, status, body, final_kind,
       final_language, final_answer, final_code, final_claims, complexity,
       confidence, well_formed, input_tokens, output_tokens, elapsed_ms, error)
    values (
      v_run, r->>'provider', r->>'model', r->>'attemptId', r->>'status',
      coalesce(r->>'body', ''), r->>'finalKind', r->>'finalLanguage',
      r->>'finalAnswer', r->>'finalCode',
      coalesce((select array_agg(value::text) from jsonb_array_elements_text(r->'finalClaims')), '{}'::text[]),
      r->>'complexity', (r->>'confidence')::real,
      coalesce((r->>'wellFormed')::boolean, false),
      (r->>'inputTokens')::bigint, (r->>'outputTokens')::bigint,
      (r->>'elapsedMs')::bigint, r->>'error'
    );
  end loop;

  if p_verdict is not null and p_verdict <> 'null'::jsonb then
    insert into verdicts
      (run_id, verdict, headline, detail, reliability, camps, outliers,
       representative, judge_provider, judge_text)
    values (
      v_run, p_verdict->>'verdict', p_verdict->>'headline', p_verdict->>'detail',
      p_verdict->>'reliability', coalesce(p_verdict->'camps', '[]'::jsonb),
      coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_verdict->'outliers')), '{}'::text[]),
      p_verdict->>'representative', p_verdict->>'judgeProvider', p_verdict->>'judgeText'
    );
  end if;

  return v_run;
end;
$$;

revoke all on function public.run_save(uuid,uuid,text,text,text,text,boolean,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.run_save(uuid,uuid,text,text,text,text,boolean,jsonb,jsonb)
  to service_role;

commit;
