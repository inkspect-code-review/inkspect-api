// Only normalized diagnostics leave the private receipt. GitHub error messages
// can echo repository content, so never put them into public job data or logs.
export type CommitDiagnostic = {
  category: 'permission' | 'stale' | 'rules' | 'rate_limit' | 'invalid_changes' | 'rejected' | 'unconfirmed';
  http_status: number;
  request_id?: string;
};

export class CommitFailure extends Error {
  constructor(public definitive: boolean, public diagnostic: CommitDiagnostic) {
    super(definitive ? 'GitHub rejected the fix commit' : 'GitHub commit outcome is unconfirmed');
  }
}

// GitHub's variable coercion errors have no type/code or mutation path. They
// happen before execution and carry structured input problems (which may also
// echo private input values, so only classify them here).
function inputCoercionFailure(error: any): boolean {
  return error?.path == null && typeof error?.message === 'string'
    && /^Variable \$input of type CreateCommitOnBranchInput! was provided invalid value(?:\s|$)/.test(error.message)
    && Array.isArray(error.extensions?.problems) && error.extensions.problems.length > 0
    && error.extensions.problems.every((problem: any) => Array.isArray(problem?.path)
      && typeof problem.explanation === 'string');
}

export function commitReceipt(status: number, requestId: string | null, text: string): string {
  const diagnostic: CommitDiagnostic = { category: 'unconfirmed', http_status: status,
    ...(requestId && /^[A-Za-z0-9:-]{1,100}$/.test(requestId) ? {request_id: requestId} : {}) };
  const httpRejection = [400, 401, 403, 404, 409, 422, 429].includes(status);
  let result: any;
  try { result = JSON.parse(text); }
  catch { throw new CommitFailure(httpRejection, {...diagnostic, category: httpRejection ? 'rejected' : 'unconfirmed'}); }
  const oid = result?.data?.createCommitOnBranch?.commit?.oid;
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  if (status >= 200 && status < 300 && /^[a-f0-9]{40}$/.test(oid ?? '') && !errors.length) return oid;

  // Errors resolving child fields may occur AFTER a commit was created.
  // Only known validation/authorization rejections at the mutation root can
  // establish failure; timeouts, 5xx and unknown errors remain uncertain.
  const knownTypes = new Set(['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'UNPROCESSABLE', 'STALE_DATA', 'RATE_LIMITED', 'GRAPHQL_VALIDATION_FAILED']);
  const knownValidation = new Set(['variableRequiresValidType', 'undefinedField', 'argumentNotAccepted', 'missingRequiredArguments']);
  const rootRejection = status >= 200 && status < 300 && !result?.data?.createCommitOnBranch && errors.length > 0 && errors.every((e: any) =>
    (Array.isArray(e.path) && e.path.length === 1 && e.path[0] === 'createCommitOnBranch' && knownTypes.has(e.type ?? e.extensions?.code))
    || (!e.path && knownValidation.has(e.extensions?.code))
    || (result?.data == null && inputCoercionFailure(e)));
  const definitive = (httpRejection && !result?.data?.createCommitOnBranch) || rootRejection;
  if (!definitive) throw new CommitFailure(false, diagnostic);

  const kinds = errors.map((e: any) => e.type ?? e.extensions?.code);
  const messages = [result?.message, ...errors.map((e: any) => e.message)].filter(v => typeof v === 'string').join('\n');
  diagnostic.category = status === 429 || kinds.includes('RATE_LIMITED') || /rate limit/i.test(messages) ? 'rate_limit'
    : /expectedHeadOid|expected head|head.*(?:changed|mismatch)|stale/i.test(messages) || kinds.includes('STALE_DATA') ? 'stale'
    : /protected branch|repository rule|rule violation|push protection|secret scanning/i.test(messages) ? 'rules'
    : [401, 403].includes(status) || kinds.some((k: string) => ['FORBIDDEN', 'UNAUTHORIZED'].includes(k)) ? 'permission'
    : status === 400 || status === 422 || kinds.includes('UNPROCESSABLE') || errors.some((e: any) => knownValidation.has(e.extensions?.code) || inputCoercionFailure(e)) ? 'invalid_changes'
    : 'rejected';
  throw new CommitFailure(true, diagnostic);
}

export function commitRejectionMessage(category: unknown): string {
  const reasons: Record<string, string> = {
    permission: 'GitHub rejected the fix commit because write access was denied. Check the GitHub App permissions and repository access.',
    stale: 'GitHub rejected the fix commit because the PR branch changed. Run a new review before fixing it.',
    rules: 'GitHub rejected the fix commit under repository rules or push protection. Check the repository rules before trying again.',
    rate_limit: 'GitHub rejected the fix commit because of a rate limit. Wait for the limit to reset before starting a new review and fix.',
    invalid_changes: 'GitHub rejected the generated fix or commit request as invalid. No automatic retry will run.',
    rejected: 'GitHub explicitly rejected the fix commit. Check repository permissions and rules before requesting another fix.',
  };
  return typeof category === 'string' && Object.hasOwn(reasons, category) ? reasons[category] : reasons.rejected;
}
