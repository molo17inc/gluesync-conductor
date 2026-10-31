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
import healProxyErrorPages from '../../../helpers/healProxyErrorPages/healProxyErrorPages';
import { getLogger } from '../../../utils/logger';
import describeFailure from '../../../helpers/describeFailure/describeFailure';
import buildDiagnosis from '../../../diagnosis/buildDiagnosis';
import buildLocalErrorReply from '../../../diagnosis/buildLocalErrorReply';
import buildOutboundErrorReply from '../../../diagnosis/buildOutboundErrorReply';
import createActionGate from '../../../helpers/actionGate/actionGate';
import { ActionOutcome } from '../../../helpers/actionGate/actionGate.model';
import { RawComposeFile } from '../../../models/composeFile.model';
import { ReleaseChannelTypes } from '../../../models/conductor.model';
import { getDecidedOrchestrator } from '../../../helpers/orchestrator/getOrchestrator/getOrchestrator';
import {
  Orchestrator,
  SwarmOrchestrator,
} from '../../../helpers/orchestrator/getOrchestrator/getOrchestrator.model';
import buildMigrationRefusedOnSwarmReply from '../../../helpers/orchestrator/buildMigrationRefusedOnSwarmReply/buildMigrationRefusedOnSwarmReply';
import buildModeUnknownReply from '../../../helpers/orchestrator/buildModeUnknownReply/buildModeUnknownReply';
import forceUpdateService from '../../../helpers/swarm/forceUpdateService/forceUpdateService';
import restartSwarmStack from '../../../helpers/swarm/restartSwarmStack/restartSwarmStack';
import {
  DR_UPDATE_REFUSED_DETAILS,
  DR_UPDATE_REFUSED_ERROR,
  getDisasterRecoveryUpdateRefusal,
} from '../../../helpers/disasterRecovery/disasterRecovery';

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
  onThrow: error =>
    buildLocalErrorReply(error, ACTION_FAILED) ??
    failed(500, ACTION_FAILED, errorMessage(error)),
});

/** True while an update, restart or other container action is running. */
export const isContainerActionRunning = (): boolean =>
  gate.current() !== undefined;

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
    return (
      buildLocalErrorReply(error, 'Migration failed') ??
      failed(500, 'Migration failed', errorMessage(error))
    );
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

// Pruning through the Docker API only reaches the manager this Conductor runs
// on: the other nodes keep their images, so it would be a partial clean-up
const skipPruneOnSwarm = (): PruneOutcome => {
  logger.info(
    '[update-handler] swarm mode: not pruning images, only the manager would be pruned',
  );

  return {};
};

// If the grafana image carries the new embedded-dashboard tag, its host bind
// mounts are stripped and the container recreated so the baked-in
// dashboards/datasources are used. Idempotent no-op otherwise.
const recreateGrafanaIfEmbedded = async (
  req: Readonly<Request>,
  orchestrator: Readonly<Orchestrator>,
): Promise<ReadonlyArray<DoContainersActionItem>> => {
  // On Swarm the service is changed through the Swarm API, never recreated by
  // docker compose
  const grafanaEmbedded: HandleGrafanaEmbeddedDashboardResult =
    await handleGrafanaEmbeddedDashboard(
      orchestrator.mode === 'swarm'
        ? {
            swarm: {
              docker: req.server.docker,
              namespace: orchestrator.namespace,
            },
          }
        : undefined,
    );

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

const WIRING_VERB: Readonly<Record<string, string>> = {
  add: 'added',
  remove: 'removed',
  convert: 'converted',
  recreate: 'recreated',
};

// The MOLO17 error pages wiring follows the reverse-proxy image the update
// just left in the compose file (see healProxyErrorPages). Compose only; it
// never fails the update.
const healProxyErrorPagesAfterUpdate = async (
  req: Readonly<Request>,
  orchestrator: Readonly<Orchestrator>,
): Promise<ReadonlyArray<DoContainersActionItem>> => {
  if (orchestrator.mode !== 'compose') {
    return [];
  }

  const outcome = await healProxyErrorPages({ reason: 'update' });

  if (!outcome.recreated) {
    return [];
  }

  req.log.info(
    { service: outcome.recreated, action: outcome.action },
    '[update-handler] error pages wiring changed, reverse-proxy recreated',
  );

  return [
    {
      id: outcome.recreated,
      status: 'OK',
      message: `MOLO17 error pages wiring ${WIRING_VERB[outcome.action] ?? 'changed'} (${outcome.reason}); reverse-proxy recreated.`,
    },
  ];
};

const migrationRefusedOnSwarm = (): Outcome => ({
  statusCode: 501,
  body: buildMigrationRefusedOnSwarmReply(),
});

type ConductorRefusalSplit = Readonly<{
  refusedItems: ReadonlyArray<DoContainersActionItem>;
  wantedIds: Ids;
  nothingToUpdate: boolean;
}>;

// Swarm only (compose never sets a refusal): the Conductor is not moved to a
// version that is not newer than itself, the rest of the request goes on
const splitConductorRefusal = (
  conductorRefusal: string | undefined,
  requestIds: Ids,
): ConductorRefusalSplit => {
  const conductorAsked =
    requestIds.length === 0 || requestIds.includes(CONDUCTOR_NAME);
  const refusedItems: ReadonlyArray<DoContainersActionItem> =
    conductorRefusal && conductorAsked
      ? [{ id: CONDUCTOR_NAME, status: 'ERROR', message: conductorRefusal }]
      : [];
  const wantedIds = conductorRefusal
    ? requestIds.filter(id => id !== CONDUCTOR_NAME)
    : requestIds;

  return {
    refusedItems,
    wantedIds,
    // Only the Conductor was asked for: an empty list must not mean "all"
    nothingToUpdate:
      Boolean(conductorRefusal) &&
      requestIds.length > 0 &&
      wantedIds.length === 0,
  };
};

type UpdateBranchArgs = Readonly<{
  nothingToUpdate: boolean;
  conductorInfo: CheckModuleUpdateResult | null;
  composeJson: RawComposeFile;
  wantedIds: Ids;
  bulkIds: Ids;
  releaseChannel: ReleaseChannelTypes;
  swarm: boolean;
  namespace?: string;
  docker: Readonly<Docker>;
}>;

const runUpdateBranch = async (
  updateAction: ContainerAction,
  {
    nothingToUpdate,
    conductorInfo,
    composeJson,
    wantedIds,
    bulkIds,
    releaseChannel,
    swarm,
    namespace,
    docker,
  }: UpdateBranchArgs,
) => {
  if (nothingToUpdate) {
    return { orderedIds: [], results: [] };
  }

  if (isConductorOnlyUpdate(conductorInfo, wantedIds)) {
    return updateConductorOnly(updateAction, conductorInfo, composeJson, {
      swarm,
    });
  }

  return updateNormalBulk(updateAction, composeJson, bulkIds, releaseChannel, {
    swarm,
    namespace,
    docker,
  });
};

const performUpdate = async (
  req: Readonly<Request>,
  requestIds: Ids,
  releaseChannel: ReleaseChannelTypes,
  orchestrator: Readonly<Orchestrator>,
): Promise<Outcome> => {
  const swarm = orchestrator.mode === 'swarm';
  logger.info('[update-handler] Update action triggered');

  // Before anything is pulled or written: a disk that fills up halfway is what
  // used to leave the compose file empty.
  await ensureFreeSpace([composeFilePath()], getUpdateMinFreeBytes());

  const composeJson = await readComposeFile({ raw: true });

  // A site of a disaster-recovery pair is upgraded with Gluesync Control, one
  // site at a time: an in-place update here would migrate the databases of the
  // active site and leave the standby unable to take over. Nothing is pulled
  // or written.
  if (await getDisasterRecoveryUpdateRefusal(composeJson, requestIds)) {
    req.log.warn(
      { ids: requestIds },
      '[update-handler] refused: disaster recovery is enabled on this Core Hub',
    );

    return failed(409, DR_UPDATE_REFUSED_ERROR, DR_UPDATE_REFUSED_DETAILS);
  }

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
    return swarm
      ? migrationRefusedOnSwarm()
      : runMigration(requestIds, releaseChannel, req.server.docker);
  }

  logger.debug('[update-handler] Entering  NORMAL UPDATE FLOW');

  const { refusedItems, wantedIds, nothingToUpdate } = splitConductorRefusal(
    swarm ? conductorInfo?.refusal : undefined,
    requestIds,
  );

  const bulkIds =
    wantedIds.length === 0 && chronosInfo?.needsUpdate
      ? [CHRONOS_NAME]
      : wantedIds;
  const branchResult = await runUpdateBranch(updateAction, {
    nothingToUpdate,
    conductorInfo,
    composeJson,
    wantedIds,
    bulkIds,
    releaseChannel,
    swarm,
    namespace:
      orchestrator.mode === 'swarm' ? orchestrator.namespace : undefined,
    docker: req.server.docker,
  });

  const ids =
    'id' in branchResult ? [branchResult.id] : branchResult.orderedIds;
  const { results } = branchResult;

  req.log.debug(`Container action update: ${JSON.stringify(results)}`);

  const grafanaItems = await recreateGrafanaIfEmbedded(req, orchestrator);
  const proxyItems = await healProxyErrorPagesAfterUpdate(req, orchestrator);
  const pruneOutcome = swarm
    ? skipPruneOnSwarm()
    : await pruneImages(req.server.docker);

  return ok({
    success: true,
    data: {
      ...pruneOutcome,
      containers: [
        ...toItems(ids, results),
        ...refusedItems,
        ...grafanaItems,
        ...proxyItems,
      ],
    },
  });
};

// ---------------------------------------------------------------- restart

const conductorRestartItem = (serviceName: string): DoContainersActionItem => ({
  id: serviceName,
  status: 'OK',
  message: `Conductor ${serviceName} restart initiated.`,
});

// Swarm replaces the task of its own service: no helper container, and no
// update mode either, Swarm rolls back a task that does not start
const restartSelfOnSwarm = (
  req: Readonly<Request>,
  orchestrator: Readonly<SwarmOrchestrator>,
): void => {
  const { namespace, selfService } = orchestrator;

  req.log.info(
    { service: selfService },
    '[conductor-restart] swarm: restarting the conductor service',
  );

  setImmediate(() => {
    forceUpdateService(req.server.docker, `${namespace}_${selfService}`).catch(
      error => {
        req.log.error({ error }, '[conductor-restart] service restart failed');
      },
    );
  });
};

// Reboots the conductor once the reply has gone out: the reply is sent as soon
// as the outcome is returned, before the next macrotask. Update mode blocks
// incoming requests meanwhile.
const rebootConductorAfterReply = (
  req: Readonly<Request>,
  serviceName: string,
  orchestrator: Readonly<Orchestrator>,
): void => {
  if (orchestrator.mode === 'swarm') {
    restartSelfOnSwarm(req, orchestrator);
    return;
  }

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

// No ids on Swarm: every stack service, the conductor last, all after the
// reply (the rollouts take longer than a request should)
const restartFullStackOnSwarm = (
  req: Readonly<Request>,
  orchestrator: Readonly<SwarmOrchestrator>,
): Outcome => {
  req.log.info('[conductor-restart] swarm: full stack restart requested');

  setImmediate(() => {
    restartSwarmStack(req.server.docker, orchestrator)
      .then(results => {
        req.log.info(
          { results },
          '[conductor-restart] swarm: full stack restart done',
        );
      })
      .catch(error => {
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
  orchestrator: Readonly<Orchestrator>,
): Promise<Outcome> => {
  const CONDUCTOR_SERVICE =
    orchestrator.mode === 'swarm'
      ? orchestrator.selfService
      : process.env.CONDUCTOR_NAME || 'gluesync-conductor';

  if (requestIds.length === 0) {
    return orchestrator.mode === 'swarm'
      ? restartFullStackOnSwarm(req, orchestrator)
      : restartFullStack(req);
  }

  // Only the conductor: nothing to restart in-process, just the reboot.
  if (requestIds.length === 1 && requestIds[0] === CONDUCTOR_SERVICE) {
    rebootConductorAfterReply(req, CONDUCTOR_SERVICE, orchestrator);
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

  rebootConductorAfterReply(req, CONDUCTOR_SERVICE, orchestrator);

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
  // A full disk or a corrupt compose file is this install's own problem.
  const local = buildLocalErrorReply(error, ACTION_FAILED);

  if (local) {
    return local;
  }

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

    // Docker not answering is not "compose": the healing a compose Conductor
    // does would recreate containers inside a swarm
    const orchestrator = await getDecidedOrchestrator(req.server.docker);

    if (!orchestrator) {
      return { statusCode: 503, body: buildModeUnknownReply() };
    }

    const action = createActions({ docker: req.server.docker })[
      containerAction
    ];

    if (!action) {
      throw new Error(`Unknown action: ${containerAction}`);
    }

    if (containerAction === 'update') {
      return await performUpdate(req, requestIds, releaseChannel, orchestrator);
    }

    if (containerAction === 'restart') {
      return await performRestart(req, action, requestIds, orchestrator);
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
