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
import updateConductorOnly from './handleUpdate/updateConductorOnly';
import fetchAllServicesInCompose from '../../../helpers/fetchAllServicesInCompose/fetchAllServicesInCompose';
import {
  enableUpdateMode,
  isUpdateMode,
} from '../../../plugins/apiBlockerAsUpdating';
import { autoReboot } from '../../../helpers/autoReboot/autoReboot';
import getRootPath from '../../../helpers/getRootPath/getRootPath';
import restartWindows from '../../../helpers/restartAllServices/windowsRestart';
import restartLinux from '../../../helpers/restartAllServices/linuxRestart';
import migrationWithUpdate from './migrationWithUpdate/migrationWithUpdate';
import updateNormalBulk from './handleUpdate/updateNormalBulk';
import { migrationNeeded } from '../../../helpers/migrationNeeded/migrationNeeded';
import handleGrafanaEmbeddedDashboard from '../../../helpers/handleGrafanaEmbeddedDashboard/handleGrafanaEmbeddedDashboard';
import { getLogger } from '../../../utils/logger';
import describeFailure from '../../../helpers/describeFailure/describeFailure';
import buildDiagnosis from '../../../diagnosis/buildDiagnosis';
import buildOutboundErrorReply from '../../../diagnosis/buildOutboundErrorReply';
import createActionGate from '../../../helpers/actionGate/actionGate';
import { ActionOutcome } from '../../../helpers/actionGate/actionGate.model';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;
const helperImageWindows = process.env.HELPER_IMAGE_BASE || '';
const logger = getLogger();

type Outcome = ActionOutcome<DoContainersActionResponse>;
type Request = Parameters<DoContainersActionHandler>[0];

// Seconds a refused caller should wait before asking again: a pull plus
// recreate plus the stability window of one service.
const RETRY_AFTER_SECONDS = '30';

// One container action at a time (see actionGate). A retry of the same action
// on the same ids joins the running one and gets its result, so a request that
// lost its connection mid-update (the reverse proxy it travels through was just
// recreated) ends with the real outcome instead of a refusal.
const gate = createActionGate<DoContainersActionResponse>({
  onThrow: error => ({
    statusCode: 500,
    body: {
      success: false,
      error: 'Failed to do containers action',
      details: error instanceof Error ? error.message : String(error),
    },
  }),
});

const ok = (body: DoContainersActionResponse): Outcome => ({
  statusCode: 200,
  body,
});

const perform = async (req: Readonly<Request>): Promise<Outcome> => {
  try {
    const containerAction = req.body.action;
    const requestIds: readonly string[] = req.body.ids || [];
    const releaseChannel = req.body.releaseChannel || 'ga';

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

    const actions = createActions({ docker: req.server.docker });
    const action = actions[containerAction];

    if (!action) {
      throw new Error(`Unknown action: ${containerAction}`);
    }

    if (containerAction === 'update') {
      logger.info('[update-handler] Update action triggered');

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

      const CONDUCTOR_NAME = 'gluesync-conductor';
      const CHRONOS_NAME = 'gluesync-chronos';
      const CORE_HUB_NAME = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
      const MIN_CORE_HUB_VERSION = '2.2.0';
      const normalizeVersion = (v: string) =>
        v.split('-')[0].split('.').slice(0, 3).join('.'); // take first 3 parts

      const conductorInfo = await checkModuleUpdate(
        req.server.docker,
        composeJson,
        releaseChannel,
        CONDUCTOR_NAME,
      );

      req.log.debug(
        `Checking for chronos update, ids length=${requestIds.length}`,
      );

      const chronosInfo = await checkModuleUpdate(
        req.server.docker,
        composeJson,
        releaseChannel,
        CHRONOS_NAME,
      );

      // --- Core-hub version check (functional) ---
      const coreHubNeedsMigration: boolean = await (async () => {
        try {
          const coreHubInfo = await checkModuleUpdate(
            req.server.docker,
            composeJson,
            releaseChannel,
            CORE_HUB_NAME,
          );
          const semVerVersion = normalizeVersion(
            coreHubInfo?.availableVersion || '',
          );

          req.log.debug(
            `[update-handler] Core-hub latest ${releaseChannel}: ${semVerVersion}`,
          );

          return semver.gte(semVerVersion, MIN_CORE_HUB_VERSION);
        } catch (error) {
          req.log.warn(
            `[update-handler] Failed to fetch core-hub version → assuming migration needed ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      })();

      // --- Decide migration flow (functional) ---
      if (
        !conductorInfo?.needsUpdate &&
        !chronosInfo?.needsUpdate &&
        coreHubNeedsMigration
      ) {
        const needsMigration = await migrationNeeded();

        logger.debug(
          { needsMigration },
          '[update-handler] migrationNeeded() returned:',
          needsMigration,
        );

        if (needsMigration) {
          logger.debug('[update-handler] Entering MIGRATION FLOW');

          try {
            await migrationWithUpdate(
              requestIds,
              releaseChannel,
              isWindows,
              helperImageWindows,
              req.server.docker,
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
            return {
              statusCode: 500,
              body: {
                success: false,
                error: 'Migration failed',
                details: error instanceof Error ? error.message : String(error),
              },
            };
          }
        }
      }

      logger.debug('[update-handler] Entering  NORMAL UPDATE FLOW');

      const branchResult =
        conductorInfo?.needsUpdate &&
        (requestIds.length === 0 ||
          (requestIds.length === 1 && requestIds[0] === CONDUCTOR_NAME))
          ? await updateConductorOnly(updateAction, conductorInfo, composeJson)
          : await updateNormalBulk(
              updateAction,
              composeJson,
              requestIds.length === 0 && chronosInfo?.needsUpdate
                ? [CHRONOS_NAME]
                : requestIds,
              releaseChannel,
            );

      const ids =
        'id' in branchResult ? [branchResult.id] : branchResult.orderedIds;
      const { results } = branchResult;

      req.log.debug(
        `Container action ${containerAction}: ${JSON.stringify(results)}`,
      );

      // If the grafana image carries the new embedded-dashboard tag, strip its
      // host bind mounts and recreate the container so the baked-in
      // dashboards/datasources are used. Idempotent no-op otherwise.
      const grafanaEmbedded = await handleGrafanaEmbeddedDashboard();

      if (grafanaEmbedded.applied) {
        req.log.info(
          { service: grafanaEmbedded.serviceId },
          '[update-handler] grafana recreated with embedded dashboard',
        );
      }

      const pruneOutcome = await req.server.docker
        .pruneImages({
          force: true,
          // Equivalent intent: `docker image prune -a -f`
          // Remove images not referenced by any container:
          filters: { dangling: { false: true } },
        })
        .then(resultPrune => {
          const deletedCount = resultPrune.ImagesDeleted?.length ?? 0;
          const reclaimedMb = (
            resultPrune.SpaceReclaimed /
            (1024 * 1024)
          ).toFixed(2);

          return deletedCount > 0
            ? {
                pruneResult: `Pruned ${deletedCount} images, and reclaimed ${reclaimedMb} MB disk space successfully`,
              }
            : {};
        })
        .catch((error: unknown) => ({
          pruneError: error instanceof Error ? error.message : String(error),
        }));

      const containers: ReadonlyArray<DoContainersActionItem> = [
        ...results.map(
          (result, index): DoContainersActionItem => ({
            id: ids[index],
            status: result.status === 'fulfilled' ? 'OK' : 'ERROR',
            message:
              result.status === 'fulfilled'
                ? result.value
                : describeFailure(result.reason),
          }),
        ),
        ...(grafanaEmbedded.applied
          ? [
              {
                id: grafanaEmbedded.serviceId,
                status: 'OK' as const,
                message:
                  'Grafana recreated with embedded dashboard (volumes removed).',
              },
            ]
          : []),
      ];

      return ok({
        success: true,
        data: {
          ...pruneOutcome,
          containers,
        },
      });
    }

    if (containerAction === 'restart') {
      const CONDUCTOR_SERVICE =
        process.env.CONDUCTOR_NAME || 'gluesync-conductor';

      // ---------------------------------------------------------
      // CASE 1 — No IDs → full stack restart
      // ---------------------------------------------------------
      if (requestIds.length === 0) {
        req.log.info('[conductor-restart] full stack restart requested');

        enableUpdateMode();

        // Runs after the reply has gone out (the reply is sent as soon as this
        // outcome is returned, before the next macrotask).
        setImmediate(() => {
          const hostProjectDir = getRootPath({
            basePath: process.env.BASE_PATH,
          });

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
              {
                id: 'ALL',
                status: 'OK',
                message: 'Full stack restart initiated.',
              },
            ],
          },
        });
      }

      // ---------------------------------------------------------
      // CASE 2 — IDs provided
      // ---------------------------------------------------------

      // Restart ONLY conductor

      if (requestIds.length === 1 && requestIds[0] === CONDUCTOR_SERVICE) {
        req.log.info(
          { service: CONDUCTOR_SERVICE },
          '[conductor-restart] triggering conductor restart',
        );

        // Enable update mode to block incoming requests during conductor restart
        enableUpdateMode();

        // Wrap in setImmediate to send response before conductor dies
        setImmediate(() => {
          autoReboot({
            hostProjectDir: getRootPath({ basePath: process.env.BASE_PATH }),
            serviceName: CONDUCTOR_SERVICE,
            helperImage: isWindows ? helperImageWindows : 'docker:cli',
            log: msg =>
              req.log.info({ msg }, '[conductor-restart] restart log'),
          }).catch(error => {
            req.log.error({ error }, '[conductor-restart] autoReboot failed');
          });
        });

        return ok({
          success: true,
          data: {
            containers: [
              {
                id: CONDUCTOR_SERVICE,
                status: 'OK',
                message: `Conductor ${CONDUCTOR_SERVICE} restart initiated.`,
              },
            ],
          },
        });
      }

      // If no IDs provided, get all services from compose file
      const allServiceIds =
        requestIds.length === 0
          ? await readComposeFile({ raw: true }).then(composeJson => {
              const services = fetchAllServicesInCompose(composeJson, true);
              req.log.debug(
                `No IDs provided for restart, restarting all services: ${services.join(', ')}`,
              );
              return services;
            })
          : requestIds;

      // Separate conductor from other services
      const hasConductor = allServiceIds.includes(CONDUCTOR_SERVICE);
      const idsToRestart = allServiceIds.filter(
        serviceName => serviceName !== CONDUCTOR_SERVICE,
      );

      // Restart all services except conductor
      const results = await Promise.allSettled(idsToRestart.map(action));

      req.log.debug(
        `Container action ${containerAction}: ${JSON.stringify(results)}`,
      );

      // Build response with all results
      const serviceContainers: ReadonlyArray<DoContainersActionItem> =
        results.map((result, index) => ({
          id: idsToRestart[index],
          status: result.status === 'fulfilled' ? 'OK' : 'ERROR',
          message:
            result.status === 'fulfilled'
              ? result.value
              : describeFailure(result.reason),
        }));

      if (!hasConductor) {
        return ok({ success: true, data: { containers: serviceContainers } });
      }

      // The conductor needs a restart too: add it to the response and trigger it
      const containers: ReadonlyArray<DoContainersActionItem> = [
        ...serviceContainers,
        {
          id: CONDUCTOR_SERVICE,
          status: 'OK',
          message: `Conductor ${CONDUCTOR_SERVICE} restart initiated.`,
        },
      ];

      req.log.info(
        { service: CONDUCTOR_SERVICE },
        '[conductor-restart] triggering conductor restart',
      );

      // Enable update mode to block incoming requests during conductor restart
      enableUpdateMode();

      // Wrap in setImmediate to send response before conductor dies
      setImmediate(() => {
        autoReboot({
          hostProjectDir: getRootPath({ basePath: process.env.BASE_PATH }),
          serviceName: CONDUCTOR_SERVICE,
          helperImage: isWindows ? helperImageWindows : 'docker:cli',
          log: msg => req.log.info({ msg }, '[conductor-restart] restart log'),
        }).catch(error => {
          req.log.error({ error }, '[conductor-restart] autoReboot failed');
        });
      });

      return ok({ success: true, data: { containers } });
    }

    const results = await Promise.allSettled(requestIds.map(action));

    req.log.debug(
      `Container action ${containerAction}: ${JSON.stringify(results)}`,
    );

    return ok({
      success: true,
      data: {
        containers: results.map((result, index) => ({
          id: requestIds[index],
          status: result.status === 'fulfilled' ? 'OK' : 'ERROR',
          message:
            result.status === 'fulfilled'
              ? result.value
              : describeFailure(result.reason),
        })),
      },
    });
  } catch (error) {
    req.log.error(
      `Error do containers action: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }`,
    );

    try {
      await req.server.docker.ping();
      req.log.debug('Docker daemon is responding to ping');
    } catch (pingError) {
      req.log.error(
        `Docker daemon ping failed: ${
          pingError instanceof Error ? pingError.message : String(pingError)
        }`,
      );
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
          error: 'Failed to do containers action',
          details: [
            outbound.body.diagnosis.fallback.title,
            outbound.body.details,
          ]
            .filter(Boolean)
            .join(' - '),
        },
      };
    }

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      const responseData = axiosError.response?.data;
      const details = ((): string => {
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
      })();

      return {
        statusCode: axiosError.response?.status ?? 500,
        body: {
          success: false,
          error: 'Failed to do containers action',
          details,
        },
      };
    }

    return {
      statusCode: 500,
      body: {
        success: false,
        error: 'Failed to do containers action',
        details: error instanceof Error ? error.message : String(error),
      },
    };
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
