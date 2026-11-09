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

/** Reason of the `none` plan that says the files carry the whole target wiring. */
export const WIRING_IN_PLACE = 'wiring already in place';

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

// v0.0.286 wiring is never touched on an image that can serve it: removing it
// would take `gluesync-errors` away from the proxy while the running services
// keep their `-html` routers that point at it, and recreating them would
// restart Core Hub. 3.7.16.1+ has the plugin in the legacy mode it uses.
const keepsLegacy = (image: string, wiring: Wiring): boolean =>
  wiring.legacy && hasLegacyPlugin(image);

const decideWithoutOptOut = (
  image: string,
  wiring: Wiring,
): ProxyErrorPagesPlan => {
  if (keepsLegacy(image, wiring)) {
    return plan('none', 'v0.0.286 wiring kept: the image still serves it');
  }

  if (isCapableImage(image)) {
    return wiring.targetComplete
      ? plan('none', WIRING_IN_PLACE)
      : plan('add', 'image has the wrapper and the wiring is missing');
  }

  return present(wiring)
    ? plan('remove', 'image has no wrapper, its wiring would not work')
    : plan('none', 'image has no wrapper and there is no wiring');
};

const decideOptOut = (image: string, wiring: Wiring): ProxyErrorPagesPlan => {
  if (!present(wiring)) {
    return plan('none', `${OPT_OUT_LABEL}=false`);
  }

  return keepsLegacy(image, wiring)
    ? plan(
        'skip',
        'opt-out ignored for v0.0.286 wiring: removing it needs the services recreated',
      )
    : plan('remove', `${OPT_OUT_LABEL}=false`);
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

  return isOptOut(labels)
    ? decideOptOut(image, wiring)
    : decideWithoutOptOut(image, wiring);
};

export default planProxyErrorPages;
