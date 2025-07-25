import { RemoveAgentHandler } from './removeAgent.model';
import { ComposeFile } from '../../../models/composeFile.model';

import writeComposeFile from '../../../helpers/composeFile/writeComposeFile/writeComposeFile';
import readComposeFile from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import removeKey from '../../../helpers/removeKey/removeKey';

const handler: RemoveAgentHandler = async (req, reply) => {
  try {
    const { id } = req.params;
    const composeJson = (await readComposeFile()) || {};

    if (!composeJson.services || !composeJson.services[id]) {
      reply.statusCode = 404;
      reply.send({ success: false, error: `Agent ${id} not found` });
      return;
    }

    const composeFile: ComposeFile = {
      ...composeJson,
      services: removeKey(composeJson.services, id),
    };

    await writeComposeFile(composeFile);

    reply.statusCode = 200;
    reply.send({ success: true, data: composeFile });
  } catch (error) {
    req.log.error(`Error: ${JSON.stringify(error)}`);
    reply.statusCode = 500;
    reply.send({ success: false, error: 'Internal server error' });
  }
};

export default handler;
