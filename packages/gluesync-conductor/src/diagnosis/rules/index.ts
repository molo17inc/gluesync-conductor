import { Rule } from './facts.model';
import {
  molo17HostsBlocked,
  noInternetOrDns,
  proxyAuthRequired,
  proxyUnreachable,
  tlsInterception,
} from './networkRules';
import {
  allOk,
  backofficeUnreachable,
  registryUnreachable,
  statusFeedReportsDown,
  transientFailure,
  unexpectedResponse,
} from './molo17Rules';

/**
 * The sieve, in order. The first stage that recognises the situation decides;
 * a later stage never overrides an earlier one. Stages are independent: add,
 * remove or reorder one without touching the others.
 */
const RULES: ReadonlyArray<Rule> = [
  proxyUnreachable,
  proxyAuthRequired,
  tlsInterception,
  noInternetOrDns,
  molo17HostsBlocked,
  backofficeUnreachable,
  unexpectedResponse,
  statusFeedReportsDown,
  registryUnreachable,
  transientFailure,
  allOk,
];

export default RULES;
