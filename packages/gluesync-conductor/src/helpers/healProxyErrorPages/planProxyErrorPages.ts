import {
  OPT_OUT_LABEL,
  TRAEFIK_ENABLE,
  classifyLegacyServiceLabel,
  classifyProxyLabel,
  hasLegacyPlugin,
  isCapableImage,
  isInterpolated,
  legacyProxyLabels,
  targetLabels,
} from './errorPagesWiring';
import { labelEntries, labelMap, labelsOf } from './composeLabelTransforms';
import type {
  PlanProxyErrorPages,
  PlanProxyErrorPagesInput,
  ProxyErrorPagesPlan,
} from './healProxyErrorPages.model';
import {
  TraefikStaticFacts,
  inspectTraefikStatic,
} from './traefikStaticTransforms';

const plan = (
  action: ProxyErrorPagesPlan['action'],
  reason: string,
): ProxyErrorPagesPlan => ({ action, reason });

const isOptOut = (labels: Readonly<Record<string, string>>): boolean =>
  labels[OPT_OUT_LABEL]?.trim().toLowerCase() === 'false';

/** What the labels of the reverse-proxy say about each wiring. */
type LabelFacts = Readonly<{
  custom: ReadonlyArray<string>;
  /** Every label of the target wiring (`traefik.enable` is not counted). */
  targetComplete: boolean;
  /** At least one label that only the target wiring has. */
  targetOnly: boolean;
  /** At least one label that only v0.0.286 had. */
  legacy: boolean;
}>;

const proxyLabelFacts = (
  labels: Readonly<Record<string, string>>,
  isWindows: boolean,
): LabelFacts => {
  const target = targetLabels(isWindows);
  const legacyLabels = legacyProxyLabels(isWindows);
  const classes = Object.entries(labels)
    .filter(([key]) => key !== TRAEFIK_ENABLE)
    .map(
      ([key, value]) =>
        [key, classifyProxyLabel(key, value, target, legacyLabels)] as const,
    );
  const missingTarget = Object.keys(target).filter(
    key => key !== TRAEFIK_ENABLE && labels[key] !== target[key],
  );

  return {
    custom: classes.filter(([, c]) => c === 'custom').map(([key]) => key),
    targetComplete:
      missingTarget.length === 0 && labels[TRAEFIK_ENABLE] === 'true',
    targetOnly: classes.some(([, c]) => c === 'target'),
    legacy: classes.some(([, c]) => c === 'legacy'),
  };
};

// A label of v0.0.286 on another service whose value is not the one it wrote
const customisedServiceLabels = (
  input: PlanProxyErrorPagesInput,
): ReadonlyArray<string> =>
  Object.entries(input.composeJson.services ?? {})
    .filter(([name]) => name !== input.proxyServiceName)
    .flatMap(([name, service]) =>
      labelEntries(labelsOf(service))
        .filter(([key, value]) => {
          const label = classifyLegacyServiceLabel(key, value);

          return label.legacy && !label.exact;
        })
        .map(([key]) => `${name}: ${key}`),
    );

const legacyOnOtherServices = (input: PlanProxyErrorPagesInput): boolean =>
  Object.entries(input.composeJson.services ?? {})
    .filter(([name]) => name !== input.proxyServiceName)
    .some(([, service]) =>
      labelEntries(labelsOf(service)).some(
        ([key, value]) => classifyLegacyServiceLabel(key, value).exact,
      ),
    );

type Wiring = Readonly<{
  /** Something of the target wiring is in place. */
  target: boolean;
  /** Something of v0.0.286 is in place. */
  legacy: boolean;
  /** Our plugin entry, which both wirings share. */
  plugin: boolean;
  targetComplete: boolean;
}>;

const wiringOf = (
  labels: LabelFacts,
  facts: TraefikStaticFacts,
  input: PlanProxyErrorPagesInput,
): Wiring => ({
  target: labels.targetOnly || facts.hasPagesMiddleware,
  plugin: facts.plugin === 'ours',
  legacy:
    labels.legacy ||
    (facts.hasErrorpagesEntry && facts.errorpagesIsOurs) ||
    legacyOnOtherServices(input),
  targetComplete:
    labels.targetComplete &&
    facts.hasPagesMiddleware &&
    facts.plugin === 'ours',
});

const present = (wiring: Wiring): boolean =>
  wiring.target || wiring.legacy || wiring.plugin;

const decideWithoutOptOut = (
  image: string,
  wiring: Wiring,
): ProxyErrorPagesPlan => {
  if (isCapableImage(image)) {
    if (wiring.legacy) {
      return plan('convert', 'v0.0.286 wiring on an image with the wrapper');
    }

    return wiring.targetComplete
      ? plan('none', 'wiring already in place')
      : plan('add', 'image has the wrapper and the wiring is missing');
  }

  if (!present(wiring)) {
    return plan('none', 'image has no wrapper and there is no wiring');
  }

  // 3.7.16.1 and .2 have the plugin in its old mode, which is what v0.0.286 uses
  return wiring.legacy && !wiring.target && hasLegacyPlugin(image)
    ? plan('none', 'v0.0.286 wiring on an image that still serves it')
    : plan('remove', 'image has no wrapper, its wiring would not work');
};

const customisedProblem = (
  input: PlanProxyErrorPagesInput,
  labels: LabelFacts,
  facts: TraefikStaticFacts,
): string | undefined => {
  const custom = [...labels.custom, ...customisedServiceLabels(input)];

  if (custom.length > 0) {
    return `label customised: ${custom.join(', ')}`;
  }

  const enable = labelMap(
    labelsOf(input.composeJson.services?.[input.proxyServiceName]),
  )[TRAEFIK_ENABLE];

  if (enable !== undefined && enable !== 'true') {
    return `${TRAEFIK_ENABLE} is ${enable}`;
  }

  return facts.plugin === 'different'
    ? `experimental.localPlugins already has another gluesyncerrorpages`
    : undefined;
};

/**
 * What to do with the MOLO17 error pages wiring of this install (see the
 * shared contract). Pure: the same input gives the same answer.
 */
const planProxyErrorPages: PlanProxyErrorPages = input => {
  const service = input.composeJson.services?.[input.proxyServiceName];
  const image = service?.image ?? '';

  if (!service) {
    return plan('skip', 'no reverse-proxy service');
  }

  if (isInterpolated(image)) {
    return plan('skip', `image ${image} is interpolated`);
  }

  const inspected = inspectTraefikStatic(input.traefikYamlText);

  if (!inspected.ok) {
    return plan('skip', `traefik.yml is ${inspected.problem}`);
  }

  const { facts } = inspected;

  if (!facts.hasWebsecure) {
    return plan('skip', 'traefik.yml has no entryPoints.websecure');
  }

  if (facts.middlewares === 'other') {
    return plan('skip', 'entryPoints.websecure.http.middlewares is not a list');
  }

  const labels = labelMap(labelsOf(service));
  const labelFacts = proxyLabelFacts(labels, input.isWindows);
  const problem = customisedProblem(input, labelFacts, facts);

  if (problem) {
    return plan('skip', problem);
  }

  const wiring = wiringOf(labelFacts, facts, input);

  if (isOptOut(labels)) {
    return present(wiring)
      ? plan('remove', `${OPT_OUT_LABEL}=false`)
      : plan('none', `${OPT_OUT_LABEL}=false`);
  }

  return decideWithoutOptOut(image, wiring);
};

export default planProxyErrorPages;
