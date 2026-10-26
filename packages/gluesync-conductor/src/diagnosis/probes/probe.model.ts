import { CheckId } from '../diagnosis.model';

export type ProbeErrorKind =
  | 'dns'
  | 'refused'
  | 'timeout'
  | 'reset'
  | 'tls'
  | 'proxy-auth'
  | 'other';

/**
 * Who produced an HTTP response. MOLO17's edge (CloudFront / API Gateway) stamps
 * its own headers; a customer proxy or firewall answering in its place does not.
 */
export type ResponseOrigin = 'molo17' | 'intermediary';

export type ProbeResult = Readonly<{
  id: CheckId | 'trigger';
  /** Something answered: an HTTP response (any status) or an accepted TCP connection. */
  reachable: boolean;
  /** Reachable and answering the way a healthy service does. */
  healthy: boolean;
  ms: number;
  httpStatus?: number;
  errorKind?: ProbeErrorKind;
  errorCode?: string;
  origin?: ResponseOrigin;
  host?: string;
  detail?: string;
}>;

export type ProbeOutcome = Readonly<{
  result: ProbeResult;
  body?: string;
}>;
