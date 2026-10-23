import axios, { AxiosError } from 'axios';
import semver from 'semver';
import {
  DoContainersActionHandler,
  DoContainersActionItem,
  DoContainersActionResponse,
} from './doContainersAction.model';
import createActions from '../../../helpers/dockerode/createActions/createActions';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import checkModuleUpdate from '../../../helpers/checkModuleUpdate/checkModuleUpdate';
import { CheckModuleUpdateResult } from '../../../helpers/checkModuleUpdate/checkModuleUpdate.model';
import updateConductorOnly from './handleUpdate/updateConductorOnly';
import {
  enableUpdateMode,
  isUpdateMode,
} from '../../../plugins/apiBlockerAsUpdating';
import { autoReboot } from '../../../helpers/autoReboot/autoReboot';
import ensureFreeSpace, {
  getUpdateMinFreeBytes,
} from '../../../helpers/file/ensureFreeSpace/ensureFreeSpace';
import { composeFilePath } from '../../../helpers/composeFile/composeBackup/composeBackup';
import getRootPath from '../../../helpers/getRootPath/getRootPath';
import restartWindows from '../../../helpers/restartAllServices/windowsRestart';
import restartLinux from '../../../helpers/restartAllServices/linuxRestart';
import migrationWithUpdate from './migrationWithUpdate/migrationWithUpdate';
import updateNormalBulk from './handleUpdate/updateNormalBulk';
import { migrationNeeded } from '../../../helpers/migrationNeeded/migrationNeeded';
import handleGrafanaEmbeddedDashboard from '../../../helpers/handleGrafanaEmbeddedDashboard/handleGrafanaEmbeddedDashboard';
import { HandleGrafanaEmbeddedDashboardResult } from '../../../helpers/handleGrafanaEmbeddedDashboard/handleGrafanaEmbeddedDashboard.model';
import { getLogger } from '../../../utils/logger';
import describeFailure from '../../../helpers/describeFailure/describeFailure';
import buildDiagnosis from '../../../diagnosis/buildDiagnosis';
import buildOutboundErrorReply from '../../../diagnosis/buildOutboundErrorReply';
import createActionGate from '../../../helpers/actionGate/actionGate';
import { ActionOutcome } from '../../../helpers/actionGate/actionGate.model';
import { RawComposeFile } from '../../../models/composeFile.model';
import { ReleaseChannelTypes } from '../../../models/conductor.model';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;
const helperImageWindows = process.env.HELPER_IMAGE_BASE || '';
const logger = getLogger();

type Outcome = ActionOutcome<DoContainersActionResponse>;
type Request = Parameters<DoContainersActionHandler>[0];
type Docker = Request['server']['docker'];
type ContainerAction = (id: string) => Promise<any>;
type Ids = ReadonlyArray<string>;
type PruneOutcome = Readonly<{ pruneResult?: string; pruneError?: string }>;

const CONDUCTOR_NAME = 'gluesync-conductor';
const CHRONOS_NAME = 'gluesync-chronos';
const MIN_CORE_HUB_VERSION = '2.2.0';
const ACTION_FAILED = 'Failed to do containers action';

// Seconds a refused caller should wait before asking again: a pull plus
// recreate plus the stability window of one service.
const RETRY_AFTER_SECONDS = '30';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const ok = (body: DoContainersActionResponse): Outcome => ({
  statusCode: 200,
  body,
});

const failed = (
  statusCode: number,
  error: string,
  details: string,
): Outcome => ({
  statusCode,
  body: { success: false, error, details },
});

// One container action at a time (see actionGate). A retry of the same action
// on the same ids joins the running one and gets its result, so a request that
// lost its connection mid-update (the reverse proxy it travels through was just
// recreated) ends with the real outcome instead of a refusal.
const gate = createActionGate<DoContainersActionResponse>({
  onThrow: error => failed(500, ACTION_FAILED, errorMessage(error)),
});

// One reply item per settled action, in the order the ids were given.
const toItems = (
  ids: Ids,
  results: ReadonlyArray<PromiseSettledResult<any>>,
): ReadonlyArray<DoContainersActionItem> =>
  results.map((result, index) => ({
    id: ids[index],
    status: result.status === 'fulfilled' ? 'OK' : 'ERROR',
    message:
      result.status === 'fulfilled'
        ? result.value
        : describeFailure(result.reason),
  }));

// ---------------------------------------------------------------- update

// take first 3 parts
const normalizeVersion = (v: string): string =>
  v.split('-')[0].split('.').slice(0, 3).join('.');

// Core-hub version check: whether the core-hub on offer is recent enough for
// the v2 migration. A failed lookup counts as "no".
const coreHubNeedsMigration = async (
  req: Readonly<Request>,
  composeJson: Readonly<RawComposeFile>,
  releaseChannel: ReleaseChannelTypes,
): Promise<boolean> => {
  const CORE_HUB_NAME = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
  try {
    const coreHubInfo = await checkModuleUpdate(
      req.server.docker,
      composeJson,
      releaseChannel,
      CORE_HUB_NAME,
    );
    const semVerVersion = normalizeVersion(coreHubInfo?.availableVersion || '');

    req.log.debug(
      `[update-handler] Core-hub latest ${releaseChannel}: ${semVerVersion}`,
    );

    return semver.gte(semVerVersion, MIN_CORE_HUB_VERSION);
  } catch (error) {
    req.log.warn(
      `[update-handler] Failed to fetch core-hub version → assuming migration needed ${errorMessage(error)}`,
    );
    return false;
  }
};

const migrationFlowNeeded = async (): Promise<boolean> => {
  const needsMigration = await migrationNeeded();

  logger.debug(
    { needsMigration },
    '[update-handler] migrationNeeded() returned:',
    needsMigration,
  );

  return needsMigration;
};

const runMigration = async (
  requestIds: Ids,
  releaseChannel: ReleaseChannelTypes,
  docker: Readonly<Docker>,
): Promise<Outcome> => {
  logger.debug('[update-handler] Entering MIGRATION FLOW');

  try {
    await migrationWithUpdate(
      requestIds,
      releaseChannel,
      isWindows,
      helperImageWindows,
      docker,
    );

    return ok({
      success: true,
      data: {
        containers: [
          { id: 'ALL', status: 'OK', message: 'v2 Migration complete' },
        ],
      },
    });
  } catch (error) {
    return failed(500, 'Migration failed', errorMessage(error));
  }
};

// "Update all" (no ids) or just the conductor, while a conductor release is
// out: the conductor goes alone, through the self-update helper.
const isConductorOnlyUpdate = (
  conductorInfo: CheckModuleUpdateResult | null,
  requestIds: Ids,
): conductorInfo is CheckModuleUpdateResult =>
  conductorInfo?.needsUpdate === true &&
  (requestIds.length === 0 ||
    (requestIds.length === 1 && requestIds[0] === CONDUCTOR_NAME));

// Equivalent intent: `docker image prune -a -f`, images not referenced by any
// container. A failure is reported in the reply, it does not fail the update.
const pruneImages = (docker: Readonly<Docker>): Promise<PruneOutcome> =>
  docker
    .pruneImages({ force: true, filters: { dangling: { false: true } } })
    .then((resultPrune): PruneOutcome => {
      const deletedCount = resultPrune.ImagesDeleted?.length ?? 0;
      const reclaimedMb = (resultPrune.SpaceReclaimed / (1024 * 1024)).toFixed(
        2,
      );

      return deletedCount > 0
        ? {
            pruneResult: `Pruned ${deletedCount} images, and reclaimed ${reclaimedMb} MB disk space successfully`,
          }
        : {};
    })
    .catch(
      (error: unknown): PruneOutcome => ({
        pruneError: errorMessage(error),
      }),
    );

// If the grafana image carries the new embedded-dashboard tag, its host bind
// mounts are stripped and the container recreated so the baked-in
// dashboards/datasources are used. Idempotent no-op otherwise.
const recreateGrafanaIfEmbedded = async (
  req: Readonly<Request>,
): Promise<ReadonlyArray<DoContainersActionItem>> => {
  const grafanaEmbedded: HandleGrafanaEmbeddedDashboardResult =
    await handleGrafanaEmbeddedDashboard();

  if (!grafanaEmbedded.applied) {
    return [];
  }

  req.log.info(
    { service: grafanaEmbedded.serviceId },
    '[update-handler] grafana recreated with embedded dashboard',
  );

  return [
    {
      id: grafanaEmbedded.serviceId,
      status: 'OK',
      message: 'Grafana recreated with embedded dashboard (volumes removed).',
    },
  ];
};

const performUpdate = async (
  req: Readonly<Request>,
  requestIds: Ids,
  releaseChannel: ReleaseChannelTypes,
): Promise<Outcome> => {
  logger.info('[update-handler] Update action triggered');

  // Before anything is pulled or written: a disk that fills up halfway is what
  // used to leave the compose file empty.
  await ensureFreeSpace([composeFilePath()], getUpdateMinFreeBytes());

  const composeJson = await readComposeFile({ raw: true });
  req.log.debug(
    `Checking for conductor update, ids length=${requestIds.length}`,
  );

  // Images before this update, so failed services can be rolled back.
  const updateAction = createActions({
    docker: req.server.docker,
    previousImages: Object.fromEntries(
      Object.entries(composeJson.services ?? {}).map(([id, service]) => [
        id,
        service?.image,
      ]),
    ),
  }).update;

  const conductorInfo = await checkModuleUpdate(
    req.server.docker,
    composeJson,
    releaseChannel,
    CONDUCTOR_NAME,
  );

  req.log.debug(`Checking for chronos update, ids length=${requestIds.length}`);

  const chronosInfo = await checkModuleUpdate(
    req.server.docker,
    composeJson,
    releaseChannel,
    CHRONOS_NAME,
  );

  const coreHubEligible = await coreHubNeedsMigration(
    req,
    composeJson,
    releaseChannel,
  );

  // --- Decide migration flow ---
  const modulesCurrent =
    !conductorInfo?.needsUpdate && !chronosInfo?.needsUpdate;
  if (modulesCurrent && coreHubEligible && (await migrationFlowNeeded())) {
    return runMigration(requestIds, releaseChannel, req.server.docker);
  }

  logger.debug('[update-handler] Entering  NORMAL UPDATE FLOW');

  const bulkIds =
    requestIds.length === 0 && chronosInfo?.needsUpdate
      ? [CHRONOS_NAME]
      : requestIds;
  const branchResult = isConductorOnlyUpdate(conductorInfo, requestIds)
    ? await updateConductorOnly(updateAction, conductorInfo, composeJson)
    : await updateNormalBulk(
        updateAction,
        composeJson,
        bulkIds,
        releaseChannel,
      );

  const ids =
    'id' in branchResult ? [branchResult.id] : branchResult.orderedIds;
  const { results } = branchResult;

  req.log.debug(`Container action update: ${JSON.stringify(results)}`);

  const grafanaItems = await recreateGrafanaIfEmbedded(req);
  const pruneOutcome = await pruneImages(req.server.docker);

  return ok({
    success: true,
    data: {
      ...pruneOutcome,
      containers: [...toItems(ids, results), ...grafanaItems],
    },
  });
};

// ---------------------------------------------------------------- restart

const conductorRestartItem = (serviceName: string): DoContainersActionItem => ({
  id: serviceName,
  status: 'OK',
  message: `Conductor ${serviceName} restart initiated.`,
});

// Reboots the conductor once the reply has gone out: the reply is sent as soon
// as the outcome is returned, before the next macrotask. Update mode blocks
// incoming requests meanwhile.
const rebootConductorAfterReply = (
  req: Readonly<Request>,
  serviceName: string,
): void => {
  req.log.info(
    { service: serviceName },
    '[conductor-restart] triggering conductor restart',
  );

  enableUpdateMode();

  setImmediate(() => {
    autoReboot({
      hostProjectDir: getRootPath({ basePath: process.env.BASE_PATH }),
      serviceName,
      helperImage: isWindows ? helperImageWindows : 'docker:cli',
      log: msg => req.log.info({ msg }, '[conductor-restart] restart log'),
    }).catch(error => {
      req.log.error({ error }, '[conductor-restart] autoReboot failed');
    });
  });
};

// No ids: the whole stack, conductor included, through a helper container that
// runs once the reply has gone out.
const restartFullStack = (req: Readonly<Request>): Outcome => {
  req.log.info('[conductor-restart] full stack restart requested');

  enableUpdateMode();

  setImmediate(() => {
    const hostProjectDir = getRootPath({ basePath: process.env.BASE_PATH });
    const restartFn = isWindows ? restartWindows : restartLinux;

    restartFn({
      hostProjectDir,
      helperImage: isWindows ? helperImageWindows : 'docker:28',
    }).catch(error => {
      req.log.error({ error }, '[conductor-restart] full restart failed');
    });
  });

  return ok({
    success: true,
    data: {
      containers: [
        { id: 'ALL', status: 'OK', message: 'Full stack restart initiated.' },
      ],
    },
  });
};

const performRestart = async (
  req: Readonly<Request>,
  action: ContainerAction,
  requestIds: Ids,
): Promise<Outcome> => {
  const CONDUCTOR_SERVICE = process.env.CONDUCTOR_NAME || 'gluesync-conductor';

  if (requestIds.length === 0) {
    return restartFullStack(req);
  }

  // Only the conductor: nothing to restart in-process, just the reboot.
  if (requestIds.length === 1 && requestIds[0] === CONDUCTOR_SERVICE) {
    rebootConductorAfterReply(req, CONDUCTOR_SERVICE);
    return ok({
      success: true,
      data: { containers: [conductorRestartItem(CONDUCTOR_SERVICE)] },
    });
  }

  // Every other service now; the conductor, if listed, after the reply.
  const hasConductor = requestIds.includes(CONDUCTOR_SERVICE);
  const idsToRestart = requestIds.filter(id => id !== CONDUCTOR_SERVICE);
  const results = await Promise.allSettled(idsToRestart.map(action));

  req.log.debug(`Container action restart: ${JSON.stringify(results)}`);

  const serviceContainers = toItems(idsToRestart, results);

  if (!hasConductor) {
    return ok({ success: true, data: { containers: serviceContainers } });
  }

  rebootConductorAfterReply(req, CONDUCTOR_SERVICE);

  return ok({
    success: true,
    data: {
      containers: [
        ...serviceContainers,
        conductorRestartItem(CONDUCTOR_SERVICE),
      ],
    },
  });
};

// ---------------------------------------------------------------- failures

const axiosDetails = (axiosError: Readonly<AxiosError>): string => {
  const responseData = axiosError.response?.data;

  if (typeof responseData === 'string') {
    return responseData;
  }

  if (responseData && typeof responseData === 'object') {
    return (
      (responseData as any).message ??
      (responseData as any).error ??
      JSON.stringify(responseData)
    );
  }

  return axiosError.message;
};

const failureOutcome = async (error: unknown): Promise<Outcome> => {
  // Failures reaching MOLO17's own services (backoffice) are diagnosed:
  // who is at fault and what to do, instead of a bare upstream status.
  const outbound = await buildOutboundErrorReply(error);

  if (outbound) {
    return {
      statusCode: outbound.statusCode,
      body: {
        ...outbound.body,
        // Keeps the established title for this action while `diagnosis` carries the cause.
        error: ACTION_FAILED,
        details: [outbound.body.diagnosis.fallback.title, outbound.body.details]
          .filter(Boolean)
          .join(' - '),
      },
    };
  }

  return axios.isAxiosError(error)
    ? failed(error.response?.status ?? 500, ACTION_FAILED, axiosDetails(error))
    : failed(500, ACTION_FAILED, describeFailure(error));
};

// Tells a Docker outage apart from an action that failed on its own.
const logDockerReachable = async (req: Readonly<Request>): Promise<void> => {
  try {
    await req.server.docker.ping();
    req.log.debug('Docker daemon is responding to ping');
  } catch (pingError) {
    req.log.error(`Docker daemon ping failed: ${errorMessage(pingError)}`);
  }
};

// ---------------------------------------------------------------- handler

const perform = async (req: Readonly<Request>): Promise<Outcome> => {
  const containerAction = req.body.action;
  const requestIds: Ids = req.body.ids || [];
  const releaseChannel = req.body.releaseChannel || 'ga';

  try {
    // Block all actions except restart when update mode is active
    if (isUpdateMode() && containerAction !== 'restart') {
      return {
        statusCode: 503,
        body: {
          success: false,
          error: 'Conductor is updating',
          details: 'Only restart operations are allowed during update mode',
          diagnosis: buildDiagnosis({ code: 'CONDUCTOR_UPDATING' }),
        },
      };
    }

    const action = createActions({ docker: req.server.docker })[
      containerAction
    ];

    if (!action) {
      throw new Error(`Unknown action: ${containerAction}`);
    }

    if (containerAction === 'update') {
      return await performUpdate(req, requestIds, releaseChannel);
    }

    if (containerAction === 'restart') {
      return await performRestart(req, action, requestIds);
    }

    const results = await Promise.allSettled(
      // eslint-disable-next-line functional/prefer-tacit -- keep map's index and array away from action
      requestIds.map(id => action(id)),
    );

    req.log.debug(
      `Container action ${containerAction}: ${JSON.stringify(results)}`,
    );

    return ok({
      success: true,
      data: { containers: toItems(requestIds, results) },
    });
  } catch (error) {
    req.log.error(
      `Error do containers action: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }`,
    );

    await logDockerReachable(req);

    return failureOutcome(error);
  }
};

const handler: DoContainersActionHandler = async (req, reply) => {
  const entry = gate.enter(
    { action: req.body.action, ids: req.body.ids || [] },
    () => perform(req),
  );

  if (entry.kind === 'busy') {
    const { running } = entry;
    req.log.warn(
      { running, requested: req.body.action, ids: req.body.ids },
      '[containers-action] refused: a different container action is running',
    );
    reply.header('Retry-After', RETRY_AFTER_SECONDS);
    reply.code(409);
    reply.send({
      success: false,
      error: 'Another container action is in progress',
      details: `"${running.action}" started at ${running.since}; try again when it has finished`,
    });
    return;
  }

  if (entry.kind === 'joined') {
    req.log.info(
      { running: entry.running },
      '[containers-action] same action already running: waiting for its result',
    );
  }

  const outcome = await entry.outcome;
  reply.code(outcome.statusCode);
  reply.send(outcome.body);
};

export default handler;
