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

export type HealCourierInboundOutcome = Readonly<{
  action: CourierInboundAction;
  reason: string;
  missing?: ReadonlyArray<CourierInboundPart>;
  /** The reverse-proxy service that was recreated, when traefik.yml or its ports changed. */
  recreated?: string;
  backupDir?: string;
}>;

export type HealCourierInbound = (
  options: Readonly<{ reason: HealReason }>,
) => Promise<HealCourierInboundOutcome>;
