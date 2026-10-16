import buildDiagnosis, { BuildDiagnosisDeps } from './buildDiagnosis';
import { Diagnosis, DiagnosisCheck } from './diagnosis.model';
import { ConnectivityFacts, Verdict } from './rules/facts.model';
import RULES from './rules';

const toChecks = (facts: ConnectivityFacts): ReadonlyArray<DiagnosisCheck> =>
  facts.probes
    .filter(probe => probe.id !== 'trigger')
    .map(probe => ({
      id: probe.id as DiagnosisCheck['id'],
      ok: probe.healthy,
      ms: probe.ms,
      detail: probe.detail,
    }));

const UNKNOWN_VERDICT: Verdict = { code: 'UNKNOWN', confidence: 'low' };

/**
 * Runs the sieve over already-collected facts. Pure: no network, no clock
 * unless injected, so every scenario is a table-test away.
 */
const diagnose = (
  facts: ConnectivityFacts,
  deps: BuildDiagnosisDeps = {},
): Diagnosis => {
  const verdict =
    RULES.reduce<Verdict | undefined>(
      (found, rule) => found ?? rule(facts),
      undefined,
    ) ?? UNKNOWN_VERDICT;

  return buildDiagnosis({ ...verdict, checks: toChecks(facts) }, deps);
};

export default diagnose;
