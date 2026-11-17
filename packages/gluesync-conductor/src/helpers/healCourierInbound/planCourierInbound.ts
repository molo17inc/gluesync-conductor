import { isMap, isScalar } from 'yaml';

import type { RawComposeService } from '../../models/composeFile.model';
import { parseYamlMapping } from '../healTraefikConf/yamlLikeSource';
import type { ParsedYaml } from '../healTraefikConf/yamlLikeSource';
import { TRAEFIK_ENABLE } from '../healProxyErrorPages/errorPagesWiring';
import {
  labelEntries,
  labelMap,
  labelsOf,
} from '../healProxyErrorPages/composeLabelTransforms';
import {
  COURIER_ENTRYPOINT,
  COURIER_LABELS,
  COURIER_PORT,
  COURIER_SCHEME_LABEL,
  OLD_KIT_SCHEME,
  OPT_OUT_LABEL,
  bindsHostPort,
  containerPortFor,
  isCourierRouterLabel,
  portMappings,
  publishesContainerPort,
  tcpPortOf,
} from './courierInboundWiring';
import type {
  CourierInboundPart,
  CourierInboundPlan,
  PlanCourierInbound,
  PlanCourierInboundInput,
} from './healCourierInbound.model';

/** Reason of the `none` plan that says the files carry the whole wiring. */
export const WIRING_IN_PLACE = 'wiring already in place';

const skip = (reason: string): CourierInboundPlan => ({
  action: 'skip',
  reason,
  missing: [],
});

const none = (reason: string): CourierInboundPlan => ({
  action: 'none',
  reason,
  missing: [],
});

const isOptOut = (service: RawComposeService | undefined): boolean =>
  labelMap(labelsOf(service))[OPT_OUT_LABEL]?.trim().toLowerCase() === 'false';

// ------------------------------------------------------------- traefik.yml

type EntryPointFacts = Readonly<{
  /** `entryPoints.courier` with an address on 8090 (anything else of it is the customer's). */
  present: boolean;
  problem?: string;
}>;

const entryPointsOf = (
  doc: Readonly<ParsedYaml>,
): ReadonlyArray<readonly [string, unknown]> => {
  const node = doc.getIn(['entryPoints'], true);

  return isMap(node)
    ? node.items.map(
        pair =>
          [
            String(isScalar(pair.key) ? pair.key.value : pair.key),
            isMap(pair.value) ? pair.value.toJSON() : pair.value,
          ] as const,
      )
    : [];
};

const addressOf = (value: unknown): unknown =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>).address
    : undefined;

const isEmptyValue = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (isScalar(value) && (value.value === null || value.value === ''));

const entryPointFacts = (doc: Readonly<ParsedYaml>): EntryPointFacts => {
  const entries = entryPointsOf(doc);
  const ours = entries.find(([name]) => name === COURIER_ENTRYPOINT);
  const other = entries.find(
    ([name, value]) =>
      name !== COURIER_ENTRYPOINT &&
      tcpPortOf(addressOf(value)) === COURIER_PORT,
  );

  if (other) {
    return {
      present: false,
      problem: `entryPoints.${other[0]} already listens on :${COURIER_PORT}`,
    };
  }

  if (!ours || isEmptyValue(ours[1])) {
    return { present: false };
  }

  const address = addressOf(ours[1]);

  return tcpPortOf(address) === COURIER_PORT
    ? { present: true }
    : {
        present: false,
        problem: `entryPoints.${COURIER_ENTRYPOINT} is set to ${JSON.stringify(address ?? ours[1])}`,
      };
};

// Traefik takes its static configuration from one source only: with entry
// points on the command line or in the environment, traefik.yml is not read.
const staticConfigElsewhere = (service: RawComposeService): boolean => {
  const { command, entrypoint, environment } = service as Readonly<
    Record<string, unknown>
  >;
  const args = [command, entrypoint]
    .flatMap(part => (Array.isArray(part) ? part : [part]))
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  const env = Array.isArray(environment)
    ? environment.map(String)
    : Object.keys((environment as Record<string, unknown> | undefined) ?? {});

  return (
    /--entrypoints\./i.test(args) ||
    env.some(variable => /^TRAEFIK_ENTRYPOINTS_/i.test(variable))
  );
};

// ---------------------------------------------------------------- compose

type PortFacts = Readonly<{ present: boolean; problem?: string }>;

const proxyPortFacts = (
  input: PlanCourierInboundInput,
  proxy: RawComposeService,
): PortFacts => {
  const services = input.composeJson.services ?? {};
  const taken = Object.entries(services)
    .filter(([name]) => name !== input.proxyServiceName)
    .find(([, service]) =>
      portMappings(service?.ports).some(m => bindsHostPort(m, COURIER_PORT)),
    );

  if (taken) {
    return {
      present: false,
      problem: `host port ${COURIER_PORT} is already published by ${taken[0]}`,
    };
  }

  if (proxy.ports !== undefined && !Array.isArray(proxy.ports)) {
    return {
      present: false,
      problem: `ports of ${input.proxyServiceName} is not a list`,
    };
  }

  const mappings = portMappings(proxy.ports);
  const elsewhere = mappings
    .filter(m => bindsHostPort(m, COURIER_PORT))
    .map(m => containerPortFor(m, COURIER_PORT))
    .find(port => port !== COURIER_PORT);

  if (elsewhere !== undefined) {
    return {
      present: false,
      problem: `${input.proxyServiceName} already publishes host port ${COURIER_PORT} to its port ${elsewhere}`,
    };
  }

  // A host network has no published ports: Traefik binds the host port itself
  const hostNetwork =
    (proxy as Readonly<Record<string, unknown>>).network_mode === 'host';

  return {
    present:
      hostNetwork ||
      mappings.some(m => publishesContainerPort(m, COURIER_PORT)),
  };
};

type LabelFacts = Readonly<{
  missing: boolean;
  /** The scheme label still has the old kit value, http. */
  oldScheme?: boolean;
  problem?: string;
}>;

// The scheme the kits wrote before Core Hub 2.3.2.2 is ours to change
const isOldKitScheme = (key: string, value: string): boolean =>
  key === COURIER_SCHEME_LABEL && value === OLD_KIT_SCHEME;

const coreHubLabelFacts = (
  input: PlanCourierInboundInput,
  coreHub: RawComposeService,
): LabelFacts => {
  const labels = labelMap(labelsOf(coreHub));
  const enable = labels[TRAEFIK_ENABLE];

  if (enable !== 'true') {
    return {
      missing: false,
      problem: `${input.coreHubServiceName} is not routed by Traefik (${TRAEFIK_ENABLE} is ${enable ?? 'not set'})`,
    };
  }

  const customised = Object.entries(COURIER_LABELS)
    .filter(
      ([key, value]) =>
        key in labels &&
        labels[key] !== value &&
        !isOldKitScheme(key, labels[key]),
    )
    .map(([key]) => key);

  if (customised.length > 0) {
    return {
      missing: false,
      problem: `label customised: ${customised.join(', ')}`,
    };
  }

  const elsewhere = Object.entries(input.composeJson.services ?? {})
    .filter(([name]) => name !== input.coreHubServiceName)
    .flatMap(([name, service]) =>
      labelEntries(labelsOf(service))
        .filter(([key]) => isCourierRouterLabel(key))
        .map(() => name),
    );

  if (elsewhere.length > 0) {
    return {
      missing: false,
      problem: `the ${COURIER_ENTRYPOINT} router or service is already defined on ${[...new Set(elsewhere)].join(', ')}`,
    };
  }

  return {
    missing: Object.keys(COURIER_LABELS).some(key => !(key in labels)),
    oldScheme: labels[COURIER_SCHEME_LABEL] === OLD_KIT_SCHEME,
  };
};

// `missing: a, b` and/or `courier scheme http, Core Hub needs https`
const planReason = (missing: ReadonlyArray<CourierInboundPart>): string => {
  const added = missing.filter(part => part !== 'Core Hub scheme');

  return [
    ...(added.length > 0 ? [`missing: ${added.join(', ')}`] : []),
    ...(missing.includes('Core Hub scheme')
      ? [`courier scheme ${OLD_KIT_SCHEME}, Core Hub needs https`]
      : []),
  ].join('; ');
};

// ------------------------------------------------------------------- plan

const servicesProblem = (
  input: PlanCourierInboundInput,
): string | undefined => {
  const services = input.composeJson.services ?? {};

  if (!services[input.proxyServiceName]) {
    return 'no reverse-proxy service';
  }

  return services[input.coreHubServiceName]
    ? undefined
    : `no Core Hub service (${input.coreHubServiceName})`;
};

/**
 * What to do with the Courier inbound wiring of this install: add the pieces
 * that are missing, or leave it alone with the reason. Pure: the same input
 * gives the same answer.
 */
const planCourierInbound: PlanCourierInbound = input => {
  const problem = servicesProblem(input);

  if (problem) {
    return skip(problem);
  }

  const services = input.composeJson.services ?? {};
  const proxy = services[input.proxyServiceName];
  const coreHub = services[input.coreHubServiceName];

  if (isOptOut(proxy) || isOptOut(coreHub)) {
    return none(`${OPT_OUT_LABEL}=false`);
  }

  if (staticConfigElsewhere(proxy)) {
    return skip(
      `${input.proxyServiceName} sets its entry points on the command line or in the environment`,
    );
  }

  const doc = parseYamlMapping(input.traefikYamlText);

  if (typeof doc === 'string') {
    return skip(`traefik.yml is ${doc}`);
  }

  if (!isMap(doc.getIn(['entryPoints', 'websecure'], true))) {
    return skip('traefik.yml has no entryPoints.websecure');
  }

  const entryPoint = entryPointFacts(doc);
  const port = proxyPortFacts(input, proxy);
  const labels = coreHubLabelFacts(input, coreHub);
  const found = entryPoint.problem ?? port.problem ?? labels.problem;

  if (found) {
    return skip(found);
  }

  const missing: ReadonlyArray<CourierInboundPart> = [
    ...(entryPoint.present ? [] : ['entry point' as const]),
    ...(port.present ? [] : ['proxy port' as const]),
    ...(labels.missing ? ['Core Hub labels' as const] : []),
    ...(labels.oldScheme ? ['Core Hub scheme' as const] : []),
  ];

  return missing.length === 0
    ? none(WIRING_IN_PLACE)
    : {
        action: 'add',
        reason: planReason(missing),
        missing,
      };
};

export default planCourierInbound;
