import {
  CheckId,
  DiagnosisCode,
  DiagnosisConfidence,
  DiagnosisParams,
} from '../diagnosis.model';
import { ProbeResult } from '../probes/probe.model';
import { StatusFeedResult } from '../probes/statusFeed';

export type ProxyFacts = Readonly<{
  configured: boolean;
  host?: string;
  port?: number;
  /** Result of a direct TCP connect to the proxy. Undefined when no proxy is set. */
  reachable?: boolean;
}>;

/** Everything the sieve knows. Rules read it and never touch the network. */
export type ConnectivityFacts = Readonly<{
  proxy: ProxyFacts;
  /** All probe results, the proxy and status-feed ones included. */
  probes: ReadonlyArray<ProbeResult>;
  statusFeed?: StatusFeedResult;
  /** The real request that failed, when this check was triggered by a failure. */
  trigger?: ProbeResult;
}>;

export type Verdict = Readonly<{
  code: DiagnosisCode;
  confidence: DiagnosisConfidence;
  params?: DiagnosisParams;
}>;

/** One sieve stage: returns a verdict, or undefined to let the next stage look. */
export type Rule = (facts: ConnectivityFacts) => Verdict | undefined;

export const probesById = (
  facts: ConnectivityFacts,
  id: CheckId,
): ReadonlyArray<ProbeResult> => facts.probes.filter(probe => probe.id === id);

export const firstProbe = (
  facts: ConnectivityFacts,
  id: CheckId,
): ProbeResult | undefined => probesById(facts, id)[0];

/** MOLO17 is reachable when its backoffice or its status feed answers. */
export const isMolo17Reachable = (facts: ConnectivityFacts): boolean =>
  [firstProbe(facts, 'backoffice'), firstProbe(facts, 'status-feed')].some(
    probe => probe?.reachable === true,
  );
