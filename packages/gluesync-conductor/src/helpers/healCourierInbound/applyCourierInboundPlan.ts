import type {
  RawComposeFile,
  RawComposeService,
} from '../../models/composeFile.model';
import {
  appendLabels,
  labelsOf,
  withServiceLabels,
} from '../healProxyErrorPages/composeLabelTransforms';
import { parseYamlMapping } from '../healTraefikConf/yamlLikeSource';
import {
  Spliced,
  applyVerified,
  attempt,
  fileStep,
  insertLinesAfter,
  isNullValue,
  locate,
  pad,
  unsafeLayout,
  updateAt,
} from '../healTraefikConf/yamlSplice';
import {
  COURIER_ADDRESS,
  COURIER_COMMENT,
  COURIER_ENTRYPOINT,
  COURIER_LABELS,
  COURIER_PORT_MAPPING,
} from './courierInboundWiring';
import type { CourierInboundPlan } from './healCourierInbound.model';

type ComposeJson = Partial<RawComposeFile>;

const ENTRYPOINT_PATH = ['entryPoints', COURIER_ENTRYPOINT] as const;

/**
 * Adds `entryPoints.courier` (`address: ":8090"`, with the kit's comment above
 * it) after the last entry point. Only the added lines change (see
 * yamlSplice); a `courier:` key with no value gets just its address. A layout
 * that cannot be spliced safely throws an "unsafe layout" error.
 */
export const addCourierEntryPoint = (text: string): string => {
  const doc = parseYamlMapping(text);

  if (typeof doc === 'string') {
    throw unsafeLayout(`traefik.yml is ${doc}`);
  }

  const located = locate(doc, text, ENTRYPOINT_PATH);
  // The courier key is there (with no value, or with one)
  const keyThere = located.depth === ENTRYPOINT_PATH.length;

  if (keyThere && !isNullValue(located.pair?.value)) {
    return text;
  }

  // No entryPoints, or one with no value: not a file of the kit
  if (!keyThere && (located.depth === 0 || located.pair)) {
    throw unsafeLayout('traefik.yml has no entry points to add to');
  }

  const address = `address: "${COURIER_ADDRESS}"`;
  const lines = keyThere
    ? [`${pad(located.childCol)}${address}`]
    : [
        ...COURIER_COMMENT.map(line => `${pad(located.childCol)}${line}`),
        `${pad(located.childCol)}${COURIER_ENTRYPOINT}:`,
        `${pad(located.childCol + fileStep(doc, text))}${address}`,
      ];

  return applyVerified(
    text,
    [insertLinesAfter(text, located.anchor, lines)],
    js => updateAt(js, ENTRYPOINT_PATH, () => ({ address: COURIER_ADDRESS })),
  );
};

const withService = (
  composeJson: ComposeJson,
  name: string,
  change: (service: RawComposeService) => RawComposeService,
): ComposeJson => {
  const service = composeJson.services?.[name];

  return service
    ? {
        ...composeJson,
        services: { ...composeJson.services, [name]: change(service) },
      }
    : composeJson;
};

/** `8090:8090` appended to the published ports of the reverse-proxy. */
export const addProxyPort = (
  composeJson: ComposeJson,
  proxy: string,
): ComposeJson =>
  withService(composeJson, proxy, service => ({
    ...service,
    ports: [...(service.ports ?? []), COURIER_PORT_MAPPING],
  }));

/** The courier labels Core Hub does not have yet, appended in the form the file uses. */
export const addCoreHubLabels = (
  composeJson: ComposeJson,
  coreHub: string,
): ComposeJson =>
  withServiceLabels(
    composeJson,
    coreHub,
    appendLabels(labelsOf(composeJson.services?.[coreHub]), COURIER_LABELS),
  );

export type CourierFiles = Readonly<{
  composeJson: ComposeJson;
  traefikYamlText: string;
}>;

export type AppliedCourierInbound =
  | Readonly<{ ok: true; files: CourierFiles }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Both files with the missing pieces of the plan added, nothing else changed.
 * Pure. A traefik.yml that cannot be spliced safely gives the reason instead,
 * and then nothing is to be written at all.
 */
const applyCourierInboundPlan = (
  files: CourierFiles,
  plan: CourierInboundPlan,
  proxy: string,
  coreHub: string,
): AppliedCourierInbound => {
  const has = (part: CourierInboundPlan['missing'][number]): boolean =>
    plan.action === 'add' && plan.missing.includes(part);
  const traefik: Spliced = has('entry point')
    ? attempt(() => addCourierEntryPoint(files.traefikYamlText))
    : { ok: true, text: files.traefikYamlText };

  if (!traefik.ok) {
    return { ok: false, reason: `traefik.yml layout: ${traefik.reason}` };
  }

  const withPort = has('proxy port')
    ? addProxyPort(files.composeJson, proxy)
    : files.composeJson;

  return {
    ok: true,
    files: {
      traefikYamlText: traefik.text,
      composeJson: has('Core Hub labels')
        ? addCoreHubLabels(withPort, coreHub)
        : withPort,
    },
  };
};

export default applyCourierInboundPlan;
