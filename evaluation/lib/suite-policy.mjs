export function suiteExitCode(results, { allowBlocked = false } = {}) {
  const hasFailure = results.some((result) => result.status === 'fail');
  const hasBlocked = results.some((result) => result.status === 'blocked');
  return hasFailure || (!allowBlocked && hasBlocked) ? 1 : 0;
}
