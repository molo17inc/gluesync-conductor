import type { RawComposeFile } from '../../models/composeFile.model';

export type HealReason = 'startup' | 'update' | 'event';

export type ProxyErrorPagesAction =
  | 'add'
  | 'remove'
  | 'convert'
  | 'none'
  | 'skip';

export type ProxyErrorPagesPlan = Readonly<{
  action: ProxyErrorPagesAction;
  reason: string;
}>;

export type PlanProxyErrorPagesInput = Readonly<{
  composeJson: Partial<RawComposeFile>;
  proxyServiceName: string;
  traefikYamlText: string;
  isWindows: boolean;
}>;

export type PlanProxyErrorPages = (
  input: PlanProxyErrorPagesInput,
) => ProxyErrorPagesPlan;

export type LabelsInput =
  | ReadonlyArray<unknown>
  | Readonly<Record<string, unknown>>
  | undefined
  | null;

export type HealProxyErrorPagesOutcome = Readonly<{
  action: ProxyErrorPagesAction;
  reason: string;
  /** The reverse-proxy service that was recreated, when something changed. */
  recreated?: string;
  backupDir?: string;
}>;

export type HealProxyErrorPages = (
  options: Readonly<{ reason: HealReason }>,
) => Promise<HealProxyErrorPagesOutcome>;
