import { RemoveAgentHandler } from './removeAgent.model';
import { ComposeFile } from '../../../models/composeFile.model';

import writeYmlFile from '../../../helpers/writeYmlFile/writeYmlFile';
import readYmlFile from '../../../helpers/readYmlFile/readYmlFile';
import removeKey from '../../../helpers/removeKey/removeKey';

const filename = 'compose.agents.yml';

const handler: RemoveAgentHandler = async (req, reply) => {
  try {
    const { id } = req.params;
    const parsedJson = await readYmlFile<ComposeFile>(filename) || {};

    if (!parsedJson.services || !parsedJson.services[id]) {
      reply.statusCode = 404;
      reply.send({ success: false, error: `Agent ${id} not found` });
      return;
    }

    const composeFile: ComposeFile = {
      ...parsedJson,
      services: removeKey(parsedJson.services, id)
    };

    await writeYmlFile(composeFile, filename);

    reply.statusCode = 200;
    reply.send({ success: true, data: composeFile });
  } catch (error) {
    req.log.error(`Error: ${JSON.stringify(error)}`);
    reply.statusCode = 500;
    reply.send({ success: false, error: 'Internal server error' });
  }
};

export default handler;
