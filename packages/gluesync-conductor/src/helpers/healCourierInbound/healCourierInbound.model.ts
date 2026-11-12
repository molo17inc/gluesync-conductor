import type { RawComposeFile } from '../../models/composeFile.model';
import type { HealReason } from '../healProxyErrorPages/healProxyErrorPages.model';

/** A piece of the wiring, each added on its own when it is missing. */
export type CourierInboundPart =
  | 'entry point'
  | 'proxy port'
  | 'Core Hub labels';

export type CourierInboundAction = 'add' | 'none' | 'skip';

export type CourierInboundPlan = Readonly<{
  action: CourierInboundAction;
  reason: string;
  /** What `add` adds, in this order; empty for `none` and `skip`. */
  missing: ReadonlyArray<CourierInboundPart>;
}>;

export type PlanCourierInboundInput = Readonly<{
  composeJson: Partial<RawComposeFile>;
  proxyServiceName: string;
  coreHubServiceName: string;
  traefikYamlText: string;
}>;

export type PlanCourierInbound = (
  input: PlanCourierInboundInput,
) => CourierInboundPlan;

/**
 * What happened to the running Core Hub container: `recreated` to apply the
 * courier labels of the compose file, `failed` (the recreate was tried and
 * failed), `cooldown` (it still lacks them, a recreate was tried too recently).
 */
export type CoreHubRecreate = 'recreated' | 'failed' | 'cooldown';

export type HealCourierInboundOutcome = Readonly<{
  action: CourierInboundAction;
  reason: string;
  missing?: ReadonlyArray<CourierInboundPart>;
  /** The reverse-proxy service that was recreated, when traefik.yml or its ports changed. */
  recreated?: string;
  backupDir?: string;
  /** Set when the running Core Hub lacked the courier labels of the compose file. */
  coreHub?: CoreHubRecreate;
}>;

export type HealCourierInbound = (
  options: Readonly<{ reason: HealReason }>,
) => Promise<HealCourierInboundOutcome>;
