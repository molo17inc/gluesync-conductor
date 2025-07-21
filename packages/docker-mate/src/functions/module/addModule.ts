import { ComposeFile } from '../../models/composeFile.model';
import { AddModuleBody, AddModuleHandler } from './addModule.model';
import readComposeFile from '../../helpers/readComposeFile/readComposeFile';
import writeComposeFile from '../../helpers/writeComposeFile/writeComposeFile';
import mergeComposeFiles, {
  mergeServices,
} from '../../helpers/mergeComposeFiles/mergeComposeFiles';
import createComposeService from '../../helpers/composeFile/createComposeService/createComposeService';

const filename = 'compose.modules.yml';

const addModule: AddModuleHandler = async (req, reply) => {
  try {
    const parsedJson = (await readComposeFile(filename)) || {};
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
          labels,
          ports = [],
          volumes = [],
        } = module;

        const service = createComposeService('module', {
          imageName,
          type,
          nickname,
          tag,
          environment,
          ports,
          volumes,
          labels,
        });

        return {
          ...acc,
          services: mergeServices([
            acc.services || {},
            { [service.container_name]: service },
          ]),
        };
      },
      {},
    );
    const newComposeFile = mergeComposeFiles([parsedJson, composeFile]);
    await writeComposeFile(newComposeFile, filename);
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
