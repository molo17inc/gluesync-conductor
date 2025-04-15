import { ComposeFile } from '../../models/composeFile.model';
import { AddModuleBody } from './addModule.model';
import writeYmlFile from '../../helpers/writeYmlFile/writeYmlFile';
import readYmlFile from '../../helpers/readYmlFile/readYmlFile';
import mergeComposeFiles from '../../helpers/mergeComposeFiles/mergeComposeFiles';
import { createComposeService } from '../../utils/createComposeService';

const filename = 'compose.modules.yml';

import { FastifyRequest, FastifyReply } from 'fastify';

const addModule = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const parsedJson = await readYmlFile<ComposeFile>(filename);
    const body = req.body as AddModuleBody;
    const composeFile = (body.modules || []).reduce<ComposeFile>(
      (acc, module) => {
        if (!module.type) {
          return acc;
        }
        const {
          imageName,
          type,
          nickname,
          tag,
          environment,
          ports = [],
          volumes = [],
        } = module;
        const containerName = `${imageName}-${type}-module`;
        const moduleLabels = [
          `com.molo17.conductor.unique_id=${nickname || containerName}`,
          `com.molo17.conductor.versiontag=${tag || 'latest'}`,
          'com.molo17.conductor.type=module',
        ];
        const service = createComposeService({
          imageName,
          type,
          nickname,
          tag,
          environment,
          ports,
          volumes,
          labels: moduleLabels,
          extraEnv: { GLUESYNC_MODULE_TAG: 'gluesync-conductor' },
        });
        return {
          ...acc,
          services: {
            ...acc.services,
            [containerName]: {
              ...acc?.services?.[containerName],
              ...service,
            },
          },
        };
      },
      {},
    );
    const newComposeFile = mergeComposeFiles([parsedJson, composeFile]);
    await writeYmlFile(newComposeFile, filename);
    reply.statusCode = 200;
    reply.send({ success: true, data: newComposeFile });
  } catch (error) {
    req.log.error(`Error: ${JSON.stringify(error)}`);
    reply.statusCode = 500;
    reply.send({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export default addModule;
