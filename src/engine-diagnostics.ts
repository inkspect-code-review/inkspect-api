// Public diagnostics are engine-owned categories, never arbitrary provider or
// model prose. Full replies and failure details remain in the private journal.
const messages: Record<string,string> = {
  'runner.busy':'The coding runner is busy or restarting. No new model work was started.',
  'runner.lease_expired':'The coding runner stopped because its controlling worker disconnected.',
  'source.too_many_projects':'This fix spans more projects than the runner can prepare in one operation.',
  'cli.failed':'The coding agent stopped without a complete successful result.',
  'process.failed':'A required repository preparation or check failed.',
  'source.unsupported_tests':'The coding runner requires a locked Node project with a build script.',
  'usage.incomplete':'The provider usage receipt is incomplete; publication was blocked.',
  'runner.failed':'The isolated coding runner failed. Private diagnostic evidence was retained.',
  'fix.no_safe_repair':'The model could not propose a complete safe fix.',
  'fix.invalid_response':'The generated fix did not match the required response format.',
  'fix.anchor_mismatch':'A proposed edit did not match exactly one location in the supplied file.',
  'fix.incomplete_findings':'The generated fix did not address the required finding IDs.',
  'fix.out_of_scope':'The generated fix attempted to edit a file outside its allowed scope.',
  'fix.invalid_content':'The generated file failed content safety validation.',
  'fix.invalid_size':'The generated changes were empty or exceeded the allowed size.',
  'fix.repeated_candidate':'The model repeated a previously rejected candidate.',
  'fix.attempt_limit':'No candidate passed verification within the attempt limit.',
  'fix.budget_limit':'The remaining work exceeded the operation budget or context limit.',
  'fix.invalid_verdict':'The independent verifier returned an incomplete or invalid assessment.',
  'model.request_failed':'The model provider request failed; its outcome may be uncertain.',
  'model.request_rejected':'The model provider rejected the request.',
  'model.incomplete_response':'The model response was incomplete, truncated or refused.',
  'model.interrupted_response':'The model response was interrupted while being received.',
  'model.oversized_response':'The model response exceeded the allowed size.',
  'model.invalid_response':'The model provider returned an invalid response.',
  'audit.write_failed':'The required diagnostic evidence could not be saved.',
};
export function engineDiagnostic(id:string,events:any[]) {
  if(!/^J-[a-f0-9]{32}$/.test(id))return undefined;
  const reverse=[...events].reverse();
  const failure=reverse.find(e=>e?.kind==='engine.failed');
  const code=failure?.diagnostic_code;
  if(typeof code!=='string'||!Object.hasOwn(messages,code))return undefined;
  const call=reverse.find(e=>e?.kind==='model.started');
  return {id,code,message:messages[code],
    ...(Number.isInteger(call?.attempt)&&call.attempt>=1&&call.attempt<=3?{attempt:call.attempt}:{}),
    ...(['generation','claude_generation','fix_verification'].includes(call?.phase)?{phase:call.phase}:{})};
}
export function diagnosticMessage(value:any) {
  if(!value||!/^J-[a-f0-9]{32}$/.test(value.id)||!Object.hasOwn(messages,value.code))return undefined;
  return `${Number.isInteger(value.attempt)&&value.attempt>=1&&value.attempt<=3?`Attempt ${value.attempt}: `:''}${messages[value.code]} Diagnostic: ${value.id}.`;
}
