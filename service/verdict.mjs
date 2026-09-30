/** Only execution facts and exact-version OSV findings enter this function. */
export function assess(request,run,osv){
 const environmentVerified=run.environment?.os===request.target.os&&run.environment?.architecture===request.target.arch&&run.environment?.runtime===`node-${request.target.version}`&&run.environment?.isolated===true;
 const functional=run.outcome==='failed'?'failed':run.outcome==='passed'?'passed':'not_completed';
 const vulnerabilityIds=osv.status==='queried'?(osv.vulns||[]).map(v=>v.id).filter(id=>typeof id==='string'):[];
 const vulnerabilities=osv.status!=='queried'?'unknown':vulnerabilityIds.length?'reported':'none_reported';
 const failureKind=run.install&&run.install.exitCode!==0?'installation':run.test?.timedOut?'timeout':functional==='failed'?'functional':functional==='not_completed'?'infrastructure':null;
 const recommendation=failureKind==='functional'?'The reviewed functional test failed. Inspect the failing assertions, repair the integration, and submit the changed artifact under a new request ID.':failureKind==='installation'?'Dependency installation did not complete. Inspect installation evidence before diagnosing application behavior.':failureKind?'Execution did not produce a conclusive functional result. Reconcile the existing run before starting another.':vulnerabilities==='reported'?'Known vulnerabilities were reported for this exact version. Review advisories and a tested upgrade before installation.':'Functional tests passed within the recorded scope. Review security and environment evidence before installation.';
 return {assessment:{functional,vulnerabilities,vulnerabilityIds,environmentVerified,failureKind},
  finding:functional==='failed'?'reproduced':functional==='passed'&&environmentVerified?'not_reproduced_by_this_test':'inconclusive',
  installationPolicy:functional==='failed'||vulnerabilities==='reported'?'block':'review',recommendation};
}
