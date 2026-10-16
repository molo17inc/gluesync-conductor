import {
  ConnectivityFacts,
  Rule,
  Verdict,
  firstProbe,
  isMolo17Reachable,
} from './facts.model';

const MOLO17_PROBES = ['backoffice', 'status-feed'] as const;

export const proxyUnreachable: Rule = facts =>
  facts.proxy.configured && facts.proxy.reachable === false
    ? {
        code: 'PROXY_UNREACHABLE',
        confidence: 'high',
        params: { host: facts.proxy.host ?? '', port: facts.proxy.port ?? 0 },
      }
    : undefined;

export const proxyAuthRequired: Rule = facts =>
  [...facts.probes, facts.trigger].some(
    probe => probe?.errorKind === 'proxy-auth',
  )
    ? { code: 'PROXY_AUTH_REQUIRED', confidence: 'high' }
    : undefined;

// A TLS error means DNS and TCP worked, so it is decided before any "no
// internet" rule. Internet probes only count when MOLO17 itself is unreachable.
export const tlsInterception: Rule = facts => {
  const candidates = [
    ...MOLO17_PROBES.map(id => firstProbe(facts, id)),
    facts.trigger,
    ...(isMolo17Reachable(facts)
      ? []
      : [firstProbe(facts, 'internet-ip'), firstProbe(facts, 'internet-name')]),
  ];
  const failing = candidates.find(probe => probe?.errorKind === 'tls');

  return failing
    ? {
        code: 'TLS_INSPECTION',
        confidence: 'high',
        params: { host: failing.host ?? '' },
      }
    : undefined;
};

const viaProxy = (facts: ConnectivityFacts): boolean => facts.proxy.configured;

// The Google / Cloudflare probes are tie-breakers. A locked-down network that
// only allows MOLO17 must not be reported as offline, so they are ignored
// whenever MOLO17 itself answers.
export const noInternetOrDns: Rule = (facts): Verdict | undefined => {
  if (isMolo17Reachable(facts)) {
    return undefined;
  }

  const byIp = firstProbe(facts, 'internet-ip');
  const byName = firstProbe(facts, 'internet-name');

  if (byIp?.reachable === false && byName?.reachable === false) {
    return {
      code: 'NO_INTERNET',
      confidence: viaProxy(facts) ? 'medium' : 'high',
      params: { viaProxy: viaProxy(facts) },
    };
  }

  if (
    byIp?.reachable === true &&
    byName?.reachable === false &&
    byName.errorKind === 'dns'
  ) {
    return {
      code: 'DNS_FAILURE',
      confidence: 'high',
      params: { host: byName.host ?? '' },
    };
  }

  return undefined;
};

// The hosts named here are what the customer is told to allow through their
// firewall, so only hosts OTA really needs belong in the list. The status feed
// is read by Conductor to help diagnose and is not needed for an update; it is an
// internal address that may change, and it is never shown to customers.
const CUSTOMER_FACING_HOST_PROBES = ['backoffice'] as const;

export const molo17HostsBlocked: Rule = facts => {
  if (isMolo17Reachable(facts)) {
    return undefined;
  }

  // A refused, reset or unresolved connection is something on this side saying
  // no. A timeout is not: MOLO17's hosts sit together, so an outage of theirs
  // looks the same as a firewall that drops packets.
  const onlyTimeouts = MOLO17_PROBES.map(id => firstProbe(facts, id)).every(
    probe => probe === undefined || probe.errorKind === 'timeout',
  );

  return {
    code: 'MOLO17_HOSTS_BLOCKED',
    confidence: onlyTimeouts ? 'medium' : 'high',
    params: {
      hosts: CUSTOMER_FACING_HOST_PROBES.map(
        id => firstProbe(facts, id)?.host,
      ).filter((host): host is string => host !== undefined),
    },
  };
};
